import { describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { registerWorker, type ISdk } from 'iii-sdk';
import { StateKV } from '../src/state/kv.js';
import { KV } from '../src/state/schema.js';

async function withDisconnectServer(work: (sdk: ISdk, received: string[]) => Promise<void>) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address !== 'object' || !address) throw Error('Missing listener');
  const received: string[] = [];
  server.on('connection', socket => {
    socket.on('message', raw => {
      const request = JSON.parse(raw.toString());
      if (request.type !== 'invokefunction' || !request.invocation_id) return;
      received.push(request.function_id);
      if (request.function_id === 'test::disconnect' || request.function_id === 'state::set') {
        socket.terminate();
        return;
      }
      const result = request.function_id === 'state::list_groups' ? { groups: [] }
        : request.function_id === 'test::fresh' ? 'fresh' : null;
      socket.send(JSON.stringify({ type: 'invocationresult', invocation_id: request.invocation_id, result }));
    });
  });
  const sdk = registerWorker(`ws://127.0.0.1:${address.port}`, {
    workerName: 'sdk-disconnect-test', invocationTimeoutMs: 60_000,
    enableMetricsReporting: false, otel: { enabled: false },
    reconnectionConfig: { initialDelayMs: 20, maxDelayMs: 20, jitterFactor: 0 },
  });
  try { await work(sdk, received); }
  finally {
    await sdk.shutdown();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function settleAfterDisconnect(request: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request.then(value => ({ value }), error => ({ error: String(error) })),
      new Promise<{ pending: true }>(resolve => { timer = setTimeout(() => resolve({ pending: true }), 1500); }),
    ]);
  } finally { clearTimeout(timer); }
}

describe('pinned SDK disconnect handling', () => {
  it('rejects an interrupted request before its long invocation timeout and accepts fresh work', async () => {
    await withDisconnectServer(async (sdk, received) => {
      const closed = vi.spyOn(console, 'warn');
      let interrupted;
      try {
        interrupted = await settleAfterDisconnect(sdk.trigger({ function_id: 'test::disconnect', payload: {} }));
        expect(closed).toHaveBeenCalledWith('[iii] Worker connection closed', { code: 1006, pendingInvocations: 1 });
      } finally { closed.mockRestore(); }
      expect(interrupted).toEqual({ error: expect.stringContaining('connection closed') });
      expect(await sdk.trigger({ function_id: 'test::fresh', payload: {} })).toBe('fresh');
      expect(received.filter(name => name === 'test::disconnect')).toHaveLength(1);
    });
  });

  it('marks a disconnected canonical write uncertain and does not retry the mutation', async () => {
    await withDisconnectServer(async (sdk, received) => {
      const kv = new StateKV(sdk, { requireDurability: true });
      const interrupted = await settleAfterDisconnect(kv.set(KV.sessions, 'test-session', { id: 'test-session' }));
      expect(interrupted).toEqual({ error: expect.stringContaining('connection closed') });
      expect(kv.requiresWriteRecovery()).toBe(true);
      await expect(kv.set(KV.sessions, 'test-session', { id: 'test-session' })).rejects.toThrow('uncertain');
      expect(received.filter(name => name === 'state::set')).toHaveLength(1);
    });
  });
});