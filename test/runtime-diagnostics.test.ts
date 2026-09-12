import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachRuntimeDiagnostics } from "../src/telemetry/runtime-diagnostics.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "am-runtime-diag-"));
  const file = join(directory, "snapshot.json");
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  const sdk = {
    registerFunction(id: string, handler: (input: unknown) => Promise<unknown>) { handlers.set(id, handler); return { id }; },
    trigger(request: { function_id: string }) { return request.function_id === "state::get" ? pending : Promise.resolve("ok"); },
  };
  const diag = attachRuntimeDiagnostics(sdk as never, { file, runId: "20260912T010000000Z" })!;
  cleanups.push(async () => { release("done"); await diag.stop(); rmSync(directory, { recursive: true, force: true }); });
  return { sdk, file, handlers, release, diag };
}
async function snapshot(file: string, predicate: (value: any) => boolean = () => true) {
  for (let i = 0; i < 60; i++) {
    try { const value = JSON.parse(readFileSync(file, "utf8")); if (predicate(value)) return value; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error("Diagnostic snapshot not ready");
}

describe("runtime stall diagnostics", () => {
  it("preserves handler results and errors while excluding all payloads, values and error text", async () => {
    const f = fixture();
    f.sdk.registerFunction("mem::fixture", async (input) => input);
    f.sdk.registerFunction("mem::failure", async () => { throw Error("PRIVATE_ERROR"); });
    expect(await f.handlers.get("mem::fixture")!("PRIVATE_PROMPT")).toBe("PRIVATE_PROMPT");
    await expect(f.handlers.get("mem::failure")!({ token: "PRIVATE_TOKEN" })).rejects.toThrow("PRIVATE_ERROR");
    const value = await snapshot(f.file, s => s.recent.length === 2);
    expect(value.recent.map((r: any) => r.outcome)).toEqual(["ok", "error"]);
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE_|token|payload|environment/);
    expect(value.active).toEqual([]);
  });

  it("continues recording a blocked main loop and retains its exact function/state wait chain", async () => {
    const f = fixture();
    await snapshot(f.file, s => s.heartbeatAt !== null);
    f.sdk.registerFunction("mem::fixture", async () => f.sdk.trigger({ function_id: "state::get", payload: "PRIVATE_VALUE" } as never));
    const pending = f.handlers.get("mem::fixture")!({ secret: "PRIVATE_SECRET" });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2100);
    const value = JSON.parse(readFileSync(f.file, "utf8"));
    expect(value.heartbeatAgeMs).toBeGreaterThanOrEqual(1000);
    const fn = value.active.find((r: any) => r.name === "mem::fixture");
    const state = value.active.find((r: any) => r.name === "state::get");
    expect(state.parent).toBe(fn.id);
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE_/);
    f.release("real-result");
    expect(await pending).toBe("real-result");
  });

  it("bounds active records and reports observation loss under load", async () => {
    const f = fixture();
    const pending = Array.from({ length: 700 }, () => f.sdk.trigger({ function_id: "state::get" }));
    const value = await snapshot(f.file, s => s.droppedEvents > 0 || s.droppedActive > 0);
    expect(value.active.length).toBeLessThanOrEqual(128);
    expect(value.recent.length).toBeLessThanOrEqual(64);
    expect(readFileSync(f.file).length).toBeLessThan(131072);
    f.release("ok"); await Promise.all(pending);
  });

  it("is opt-in and does not wrap SDK methods with an invalid run identity", () => {
    const sdk = { registerFunction() {}, trigger() {} };
    const before = sdk.trigger;
    expect(attachRuntimeDiagnostics(sdk as never, {file:"relative.json",runId:"bad"})).toBeUndefined();
    expect(sdk.trigger).toBe(before);
  });
});
