import { withObservationWrite, withObservationRecovery } from "../src/state/observation-write.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeDiagnosticPhase, attachRuntimeDiagnostics } from "../src/telemetry/runtime-diagnostics.js";

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
    trigger(request: { function_id: string; payload?: unknown }) { const handler=handlers.get(request.function_id); return request.function_id === "state::get" ? pending : handler ? handler(request.payload) : Promise.resolve("ok"); },
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

describe("request-scoped graph and recovery diagnostics", () => {
 it("links HTTP and function request identity while preserving bounded phase/count evidence without payloads", async () => {
  const f=fixture(), requestId="qualification-0001";
  f.sdk.registerFunction("mem::graph-query",async()=>{
   runtimeDiagnosticPhase("graph.documents",{shards:64,documents:22000});
   await f.sdk.trigger({function_id:"state::list_page",payload:{scope:"mem:graph:query-documents",content:"PRIVATE_DOCUMENT"}} as never);
   return {nodes:[{id:"PRIVATE_NODE"}],edges:[],fromSnapshot:true,totalsExact:false,warning:"PRIVATE_WARNING"};
  });
  f.sdk.registerFunction("api::graph-query", async()=>f.sdk.trigger({function_id:"mem::graph-query",payload:{project:"PRIVATE_PROJECT"}} as never));
  await f.handlers.get("api::graph-query")!({headers:{"x-agentmemory-request-id":requestId,authorization:"PRIVATE_AUTH"}});
  const value=await snapshot(f.file,s=>s.requests?.filter((r:any)=>r.requestId===requestId).length===2);
  const graph=value.requests.find((r:any)=>r.name==="mem::graph-query");
  expect(graph.serverCompleted).toBe(true);expect(graph.phases["graph.documents"].counts).toEqual({shards:64,documents:22000});
  expect(graph.counts.DocumentShardReads).toBe(1);expect(graph.phases["graph.returned"].counts.snapshot).toBe(1);
  expect(JSON.stringify(value)).not.toMatch(/PRIVATE_|authorization|content|payload/);
 });
 it("retains server active/completed distinction when the client deadline does not cancel work", async()=>{
  const f=fixture(),requestId="qualification-0002";
  f.sdk.registerFunction("mem::graph-query",async()=>{await f.sdk.trigger({function_id:"state::get",payload:{scope:"mem:sessions"}} as never);return {nodes:[],edges:[],fromIndex:true};});
  const pending=f.handlers.get("mem::graph-query")!({__diagnosticRequestId:requestId});
  const active=await snapshot(f.file,s=>s.active.some((r:any)=>r.name==="mem::graph-query"&&r.requestId===requestId));
  expect(active.active.find((r:any)=>r.name==="mem::graph-query").serverCompleted).toBe(false);
  f.release("complete after client deadline");await pending;
  const done=await snapshot(f.file,s=>s.requests?.some((r:any)=>r.name==="mem::graph-query"&&r.requestId===requestId));
  expect(done.requests.find((r:any)=>r.name==="mem::graph-query").serverCompleted).toBe(true);
 });
 it("busy recovery reports active writer and zero mutation before executing protected work",async()=>{
  const f=fixture();let release!:()=>void,executed=false;
  const writer=withObservationWrite(()=>new Promise<void>(resolve=>{release=resolve}));
  f.sdk.registerFunction("mem::import",async()=>withObservationRecovery(async()=>{executed=true;}));
  try{
   await expect(f.handlers.get("mem::import")!({__diagnosticRequestId:"qualification-0003"})).rejects.toThrow("recovery made no changes");
   const value=await snapshot(f.file,s=>s.requests?.some((r:any)=>r.requestId==="qualification-0003"));
   const entry=value.requests.find((r:any)=>r.requestId==="qualification-0003");
   expect(entry.phases["recovery.rejected"].counts).toMatchObject({writers:1,mutationStarted:0});expect(executed).toBe(false);expect(entry.counts.MutationCalls).toBeUndefined();
  }finally{release();await writer;}
 });
 it("ignores untrusted oversized or nonsyntactic request identifiers",async()=>{
  const f=fixture();f.sdk.registerFunction("mem::graph-query",async()=>({nodes:[],edges:[]}));
  await f.handlers.get("mem::graph-query")!({__diagnosticRequestId:"PRIVATE_SECRET_WITH_UNDERSCORES"});
  const value=await snapshot(f.file,s=>s.recent.length===1);expect(value.requests).toEqual([]);expect(JSON.stringify(value)).not.toContain("PRIVATE_SECRET");
 });
});

for (const name of ["mem::graph-query", "mem::import", "mem::archive", "mem::forget", "mem::slot-create", "mem::remember", "mem::capture", "mem::observe"]) {
 it(`${name} receives unchanged public input with request tracing enabled`, async () => {
  const f = fixture(), payload = {project: "PRIVATE_PROJECT", dryRun: true};
  f.sdk.registerFunction(name, async input => {
   expect(input).toEqual(payload);
   expect(Object.keys(input as object)).not.toContain("__diagnosticRequestId");
   return {success: true};
  });
  f.sdk.registerFunction("api::fixture", async () => f.sdk.trigger({function_id:name,payload}));
  await expect(f.handlers.get("api::fixture")!({headers:{"x-agentmemory-request-id":"qualification-boundary"}})).resolves.toEqual({success:true});
  const value = await snapshot(f.file, s => s.requests?.some((r:any)=>r.name===name));
  expect(value.requests.find((r:any)=>r.name===name).requestId).toBe("qualification-boundary");
  expect(payload).toEqual({project:"PRIVATE_PROJECT",dryRun:true});
 });
}

describe("bounded recovery admission", () => {
 it("reserves admission ahead of new writers, drains the existing writer and never overlaps writes", async()=>{
  let finish!:()=>void, finishRecovery!:()=>void;
  const order:string[]=[];
  const existing=withObservationWrite(async()=>{order.push("existing");await new Promise<void>(resolve=>{finish=resolve});});
  const recovery=withObservationRecovery(async()=>{order.push("recovery");await withObservationWrite(async()=>{order.push("nested");});await new Promise<void>(resolve=>{finishRecovery=resolve});},500);
  const later=withObservationWrite(async()=>{order.push("later");});
  await new Promise(resolve=>setTimeout(resolve,10));expect(order).toEqual(["existing"]);
  finish();await existing;await new Promise(resolve=>setTimeout(resolve,10));expect(order).toEqual(["existing","recovery","nested"]);
  finishRecovery();await recovery;await later;expect(order).toEqual(["existing","recovery","nested","later"]);
 });
 it("timeout makes no changes, releases admission and permits later writes and recovery",async()=>{
  let finish!:()=>void;let changed=0;
  const existing=withObservationWrite(()=>new Promise<void>(resolve=>{finish=resolve}));
  await expect(withObservationRecovery(async()=>{changed++},20)).rejects.toThrow("recovery made no changes");
  expect(changed).toBe(0);await withObservationWrite(async()=>{changed++});expect(changed).toBe(1);
  finish();await existing;await withObservationRecovery(async()=>{changed++});expect(changed).toBe(2);
 });
 it("failed recovery releases admission and reentrant recovery rejects instead of waiting on itself",async()=>{
  await expect(withObservationWrite(()=>withObservationRecovery(async()=>{},100))).rejects.toThrow("writers are active");
  await expect(withObservationRecovery(async()=>{throw Error("owned failure")},100)).rejects.toThrow("owned failure");
  await withObservationWrite(async()=>{});await withObservationRecovery(async()=>{});
 });
});
