import { describe, expect, it, vi } from 'vitest';
import { StateKV } from '../src/state/kv.js';
import { KV } from '../src/state/schema.js';
import { changeEmptyObservation } from '../src/functions/empty-observation.js';
import { previewSessionForget } from '../src/functions/forget-preview.js';
import { withObservationWrite, withObservationRecovery } from '../src/state/observation-write.js';
import { getSearchIndex, setIndexPersistence } from '../src/functions/search.js';
import { selectSemanticGraphBatch } from '../src/functions/semantic-graph-backlog.js';

vi.mock('../src/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function fixture() {
  const empty = { id: 'obs_empty', sessionId: 'session', timestamp: '2026-01-01T00:00:00Z', type: 'other', title: 'assistant_response', narrative: '', facts: [], concepts: [], files: [], importance: 5 };
  const anchor = { ...empty, id: 'obs_anchor', timestamp: '2026-01-02T00:00:00Z', narrative: 'A real decision', title: 'Decision' };
  const session = { id: 'session', project: 'project', status: 'completed', observationCount: 99, startedAt: empty.timestamp, semanticGraphStatus: 'complete', semanticGraphThroughObservationId: anchor.id };
  const store = new Map<string, Map<string, any>>([
    [KV.sessions, new Map([[session.id, session]])],
    [KV.observations(session.id), new Map([[empty.id, empty], [anchor.id, anchor]])],
  ]);
  let failCount = false;
  let uncertain = false;
  const trigger = async ({ function_id: id, payload: p }: any): Promise<any> => {
    if (id === 'state::list_groups') return { groups: [...store.keys()] };
    const bucket = store.get(p.scope) ?? new Map();
    if (id === 'state::get') return structuredClone(bucket.get(p.key) ?? null);
    if (id === 'state::list') return structuredClone([...bucket.values()]);
    if (id === 'state::set') {
      bucket.set(p.key, structuredClone(p.value)); store.set(p.scope, bucket);
      if (uncertain && p.value.emptyDeletion) throw Error('Timeout after commit');
      return structuredClone(p.value);
    }
    if (id === 'state::update') {
      if (failCount) { failCount = false; throw Error('Count update failed'); }
      const row = structuredClone(bucket.get(p.key));
      for (const op of p.ops) row[op.path] = op.value;
      bucket.set(p.key, row); return row;
    }
    if (id === 'state::delete') { bucket.delete(p.key); return; }
    throw Error('Unexpected function: ' + id);
  };
  const sdk = { trigger } as never;
  return { kv: new StateKV(sdk), sdk, store, empty, anchor, session,
    failCount: () => { failCount = true; }, uncertain: () => { uncertain = true; } };
}
const request = { action: 'delete-empty', project: 'project', sessionId: 'session', observationIds: ['obs_empty'], expectedVersion: 0, reason: 'User requested proven empty records be removed' };

describe('recoverable empty observations through canonical state', () => {
  it.each([KV.graphQueryDocuments, KV.graphQueryAdjacency])('rejects deleted provenance in derived graph scope %s', async (scope) => {
    const f = fixture();
    expect(await changeEmptyObservation(f.kv, request)).toMatchObject({ success: true });
    await expect(f.kv.set(scope, '00', [{ id: 'gn_stale', sourceObservationIds: ['obs_empty'] }])).rejects.toThrow('deleted observation');
    expect(f.store.get(scope)?.size ?? 0).toBe(0);
  });
  it('previews without writes, deletes, restores the same ID, and preserves graph cursor and source fields', async () => {
    const f = fixture();
    const preview = await changeEmptyObservation(f.kv, { ...request, dryRun: true });
    expect(preview).toMatchObject({ success: true, eligible: true, expectedVersion: 0, actualObservationCount: 2, referenceCount: 0 });
    expect(f.store.has(KV.audit)).toBe(false);
    getSearchIndex().add(f.empty as never);
    expect(await changeEmptyObservation(f.kv, request)).toMatchObject({ success: true, state: 'deleted', version: 1, actualObservationCount: 1 });
    expect(await f.kv.get(KV.observations('session'), 'obs_empty')).toBeNull();
    expect(await f.kv.list(KV.observations('session'))).toEqual([f.anchor]);
    expect(getSearchIndex().search('assistant_response', 10).some(hit => hit.obsId === 'obs_empty')).toBe(false);
    const deletedSession = await f.kv.get<any>(KV.sessions, 'session');
    expect(deletedSession.semanticGraphThroughObservationId).toBe('obs_anchor');
    expect(selectSemanticGraphBatch(deletedSession, await f.kv.list<any>(KV.observations('session')))).toBeNull();
    expect(await changeEmptyObservation(f.kv, { ...request, action: 'restore-empty', expectedVersion: 1 })).toMatchObject({ success: true, state: 'restored', version: 2, actualObservationCount: 2 });
    const restored = await f.kv.get<any>(KV.observations('session'), 'obs_empty');
    const { emptyDeletion, ...original } = restored;
    expect(original).toEqual(f.empty);
    expect(emptyDeletion.auditId).toBeTruthy();
    expect(selectSemanticGraphBatch(await f.kv.get<any>(KV.sessions, 'session'), await f.kv.list<any>(KV.observations('session')))).toBeNull();
  });

  it.each([
    { narrative: 'real content' }, { facts: ['a fact'] }, { imageRef: 'image' }, { unknownFutureField: 'preserve' },
  ])('refuses content in any field %j', async (extra) => {
    const f = fixture(); f.store.get(KV.observations('session'))!.set('obs_empty', { ...f.empty, ...extra });
    expect(await changeEmptyObservation(f.kv, request)).toMatchObject({ success: false, committed: false });
    expect(f.store.has(KV.audit)).toBe(false);
  });

  it.each([
    { status: 'active' }, { semanticGraphStatus: 'pending' }, { semanticGraphBootstrapSkipped: 1 },
    { semanticGraphThroughObservationId: 'obs_empty' }, { semanticGraphThroughObservationId: 'missing' },
  ])('refuses unsupported cursor/session state %j', async (extra) => {
    const f = fixture(); f.store.get(KV.sessions)!.set('session', { ...f.session, ...extra });
    expect(await changeEmptyObservation(f.kv, request)).toMatchObject({ success: false, committed: false });
  });

  it('refuses existing derived provenance, then blocks new references and destructive imports after deletion', async () => {
    const f = fixture();
    f.store.set(KV.graphNodes, new Map([['node', { id: 'node', sourceObservationIds: ['obs_empty'] }]]));
    expect(await changeEmptyObservation(f.kv, request)).toMatchObject({ success: false, committed: false });
    f.store.get(KV.graphNodes)!.clear();
    expect(await changeEmptyObservation(f.kv, request)).toMatchObject({ success: true });
    await expect(f.kv.set(KV.memories, 'memory', { sourceObservationIds: ['obs_empty'] })).rejects.toThrow('deleted observation');
    await expect(f.kv.update(KV.actions, 'action', [{ type: 'set', path: 'sourceObservationIds', value: ['obs_empty'] }])).rejects.toThrow('deleted observation');
    await expect(f.kv.set(KV.observations('session'), 'obs_empty', f.empty)).rejects.toThrow('Protected observation');
    await expect(f.kv.delete(KV.sessions, 'session')).rejects.toThrow('Protected session');
    expect(() => f.kv.assertRecoveryImportAllowed({ observations: { session: [] } })).toThrow('Import');
    expect(() => f.kv.assertRecoveryImportAllowed({}, true)).toThrow('Replace import');
    expect(() => f.kv.assertRecoveryImportAllowed({ sessions: [{ id: 'unrelated' }] })).not.toThrow();
    const restarted = new StateKV(f.sdk); await restarted.initializeObservationRecovery();
    await expect(restarted.set(KV.graphEdges, 'edge', { sourceObservationIds: ['obs_empty'] })).rejects.toThrow('deleted observation');
  });

  it.each([
    KV.graphNodes, KV.graphEdges, KV.graphEdgeHistory, KV.memories, KV.lessons,
    KV.semantic, KV.procedural, KV.actions, KV.crystals, KV.commits,
    KV.summaries, KV.relations, KV.graphSnapshot,
  ])('protects observation references before and after deletion in %s', async (scope) => {
    const f = fixture();
    const reference = { id: 'reference', sourceObservationIds: ['obs_empty'] };
    const snapshot = scope === KV.graphSnapshot;
    const key = snapshot ? 'current' : reference.id;
    const value = snapshot ? { topNodes: [reference], topEdges: [reference] } : reference;
    f.store.set(scope, new Map([[key, value]]));
    expect(await previewSessionForget(f.kv, request)).toMatchObject({
      referenceCount: snapshot ? 2 : 1,
      references: expect.arrayContaining([expect.objectContaining({ scope, matchedIds: ['obs_empty'] })]),
    });
    expect(await changeEmptyObservation(f.kv, request)).toMatchObject({ success: false, committed: false });
    expect(f.store.has(KV.audit)).toBe(false);
    f.store.get(scope)!.clear();
    expect(await changeEmptyObservation(f.kv, request)).toMatchObject({ success: true });
    await expect(f.kv.set(scope, key, value)).rejects.toThrow('deleted observation');
    await expect(f.kv.update(scope, key, [{ type: 'set',
      path: snapshot ? 'topEdges' : 'sourceObservationIds',
      value: snapshot ? [reference] : ['obs_empty'],
    }])).rejects.toThrow('deleted observation');
    expect(f.store.get(scope)!.size).toBe(0);
  });

  it('rejects a later cursor update that moves before a protected observation at the same timestamp', async () => {
    const f = fixture();
    expect(await changeEmptyObservation(f.kv, request)).toMatchObject({ success: true });
    await f.kv.set(KV.observations('session'), 'obs_a', { ...f.empty, id: 'obs_a' });
    await expect(f.kv.update(KV.sessions, 'session', [{ type: 'set', path: 'semanticGraphThroughObservationId', value: 'obs_a' }])).rejects.toThrow('cursor');
    expect(await f.kv.get<any>(KV.sessions, 'session')).toMatchObject({ semanticGraphThroughObservationId: 'obs_anchor' });
  });

  it('repairs a partial count failure on retry without another version or audit', async () => {
    const f = fixture(); f.failCount();
    expect(await changeEmptyObservation(f.kv, request)).toMatchObject({ success: false, committed: true });
    const restarted = new StateKV(f.sdk); await restarted.initializeObservationRecovery();
    expect(await changeEmptyObservation(restarted, request)).toMatchObject({ success: true, changed: 0, version: 1, actualObservationCount: 1 });
    expect(f.store.get(KV.audit)!.size).toBe(1);
  });

  it('fails closed on ambiguous canonical write and reloads canonical state after worker restart', async () => {
    const f = fixture(); f.uncertain();
    expect(await changeEmptyObservation(f.kv, request)).toMatchObject({ success: false, commitState: 'unknown' });
    await expect(f.kv.set(KV.memories, 'unrelated', {})).rejects.toThrow('uncertain');
    const restarted = new StateKV(f.sdk); await restarted.initializeObservationRecovery();
    expect(await restarted.get(KV.observations('session'), 'obs_empty')).toBeNull();
  });

  it('does not wait on a writer holding existing keyed locks; it returns a no-change retry', async () => {
    const f = fixture();
    await withObservationWrite(async () => {
      expect(await changeEmptyObservation(f.kv, request)).toMatchObject({ success: false, committed: false });
    });
    expect(await changeEmptyObservation(f.kv, request)).toMatchObject({ success: true });
  });

  it('flushes the index after releasing recovery so a pending save can finish', async () => {
    const f = fixture();
    let startSave!: () => void;
    const waiting = new Promise<void>(resolve => { startSave = resolve; });
    const saveQueue = waiting.then(() => withObservationWrite(async () => {}));
    const original = (f.sdk as any).trigger;
    (f.sdk as any).trigger = async (input: any) => {
      if (input.function_id === 'state::list' && input.payload.scope === KV.memories) {
        startSave();
        await Promise.resolve();
      }
      return original(input);
    };
    setIndexPersistence({ save: () => saveQueue } as never);
    try {
      expect(await changeEmptyObservation(f.kv, request)).toMatchObject({ success: true });
    } finally { setIndexPersistence(null); }
  });

  it('refuses recovery after a source write times out before its late commit', async () => {
    const f = fixture();
    const original = (f.sdk as any).trigger;
    let delayed!: () => Promise<void>;
    (f.sdk as any).trigger = async (input: any) => {
      if (input.function_id === 'state::set' && input.payload.scope === KV.memories) {
        delayed = () => original(input);
        throw Error('SDK timeout before engine commit');
      }
      return original(input);
    };
    await expect(f.kv.set(KV.memories, 'late', { sourceObservationIds: ['obs_empty'] })).rejects.toThrow('SDK timeout');
    expect(await changeEmptyObservation(f.kv, request)).toMatchObject({ success: false, committed: false });
    await delayed();
    expect(await f.kv.get(KV.observations('session'), 'obs_empty')).toEqual(f.empty);
    const restarted = new StateKV(f.sdk); await restarted.initializeObservationRecovery();
    expect(await changeEmptyObservation(restarted, request)).toMatchObject({ success: false, committed: false });
  });

  it('queues ordinary writes during exclusive recovery without serializing ordinary writes', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    const recovery = withObservationRecovery(() => held);
    const writer = withObservationWrite(async () => { entered = true; });
    await Promise.resolve(); expect(entered).toBe(false);
    release(); await recovery; await writer; expect(entered).toBe(true);
  });
});
