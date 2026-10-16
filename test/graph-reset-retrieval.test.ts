import { describe, it, expect, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { registerGraphFunction } from "../src/functions/graph.js";
import { GraphRetrieval } from "../src/functions/graph-retrieval.js";
import { HybridSearch } from "../src/state/hybrid-search.js";
import { SearchIndex } from "../src/state/search-index.js";
import { archiveTargetAddress, archiveTargetDigest } from "../src/functions/archive.js";
import { KV } from "../src/state/schema.js";
import type { GraphNode, GraphEdge, CompressedObservation } from "../src/types.js";

async function fixture() {
  const kv = mockKV(); const sdk = mockSdk();
  registerGraphFunction(sdk as never, kv as never, { name: "noop" } as never);
  const node = (id: string): GraphNode => ({id, name: id === "a" ? "Alpha" : "Beta", type:"concept", project:"A", properties:{}, sourceObservationIds:[id], createdAt:"2020-01-01T00:00:00.000Z"});
  await kv.set(KV.graphNodes,"a",node("a")); await kv.set(KV.graphNodes,"b",node("b"));
  await kv.set(KV.graphEdges,"ab",{id:"ab",sourceNodeId:"a",targetNodeId:"b",type:"related_to",weight:0.8,project:"A",sourceObservationIds:["a"],createdAt:"2020-01-01T00:00:00.000Z",isLatest:true} satisfies GraphEdge);
  const bm25 = new SearchIndex();
  for (const id of ["a","b"]) {
    const obs: CompressedObservation = {id,sessionId:"s",timestamp:"2020-01-01T00:00:00.000Z",type:"note",title:id === "a" ? "Alpha" : "Beta",facts:[],narrative:"Original remains searchable",concepts:[],files:[],importance:5};
    bm25.add(obs); await kv.set(KV.observations("s"),id,obs);
  }
  return {kv,sdk,bm25,retrieval:new GraphRetrieval(kv as never),hybrid:new HybridSearch(bm25,null,null,kv as never)};
}
describe("graph reset retrieval barrier", () => {
  it.each(["entities","chunks","temporal","hybrid"])("actual reset hides prior graph from %s and preserves canonical originals", async mode => {
    const f=await fixture();
    expect((await f.retrieval.searchByEntities(["Alpha"])).length).toBeGreaterThan(0);
    expect((await f.hybrid.search("Alpha"))[0].graphScore).toBeGreaterThan(0);
    expect((await f.sdk.trigger("mem::graph-reset",{})) as object).toMatchObject({success:true});
    if(mode === "entities") expect(await f.retrieval.searchByEntities(["Alpha"])).toEqual([]);
    if(mode === "chunks") expect(await f.retrieval.expandFromChunks(["a"])).toEqual([]);
    if(mode === "temporal") expect(await f.retrieval.temporalQuery("Alpha")).toEqual({entity:null,currentState:[],history:[]});
    if(mode === "hybrid") { const rows=await f.hybrid.search("Alpha"); expect(rows[0].graphScore).toBe(0); expect(rows[0].graphContext).toBeUndefined(); }
    expect(await f.kv.get(KV.graphNodes,"a")).not.toBeNull();
    expect(f.bm25.search("Alpha")[0].obsId).toBe("a");
  });
  it("uses empty reset index without enumerating old canonical graph",async()=>{
    const f=await fixture(); await f.sdk.trigger("mem::graph-reset",{});
    const list=vi.spyOn(f.kv,"list");
    expect(await f.retrieval.searchByEntities(["Alpha"])).toEqual([]);
    expect(list.mock.calls.filter(([scope])=>scope===KV.graphNodes||scope===KV.graphEdges)).toEqual([]);
  });
  it("rejects reset during traversal before returning old graph",async()=>{
    const f=await fixture(); const list=f.kv.list.bind(f.kv); let reset=false;
    vi.spyOn(f.kv,"list").mockImplementation(async scope=>{const rows=await list(scope); if(scope===KV.graphEdges&&!reset){reset=true;await f.sdk.trigger("mem::graph-reset",{});}return rows;});
    await expect(f.retrieval.searchByEntities(["Alpha"])).rejects.toThrow(/changed/);
  });
  it("strips graph contribution when reset occurs during hybrid enrichment",async()=>{
    const f=await fixture();const get=f.kv.get.bind(f.kv);let reset=false;
    vi.spyOn(f.kv,"get").mockImplementation(async(scope,key)=>{if(scope===KV.observations("s")&&!reset){reset=true;await f.sdk.trigger("mem::graph-reset",{});}return get(scope,key);});
    const rows=await f.hybrid.search("Alpha");expect(rows[0].graphScore).toBe(0);expect(rows[0].graphContext).toBeUndefined();
  });
});

describe("post-reset indexed graph",()=>{
  async function fresh() {
    const f=await fixture();await f.sdk.trigger("mem::graph-reset",{});
    for(const id of ["a","b"]){const old=await f.kv.get<GraphNode>(KV.graphNodes,id);await f.kv.set(KV.graphNodes,"new-"+id,{...old!,id:"new-"+id,createdAt:"2099-01-01T00:00:00.000Z"});}
    await f.kv.set(KV.graphEdges,"new-ab",{id:"new-ab",sourceNodeId:"new-a",targetNodeId:"new-b",type:"related_to",weight:0.8,project:"A",sourceObservationIds:["a"],createdAt:"2099-01-01T00:00:00.000Z",isLatest:true} satisfies GraphEdge);
    expect(await f.sdk.trigger("mem::graph-snapshot-rebuild",{force:true})).toMatchObject({success:true});return f;
  }
  it("retrieves fresh graph through index without canonical enumeration",async()=>{
    const f=await fresh();const list=vi.spyOn(f.kv,"list");
    expect((await f.retrieval.searchByEntities(["Alpha"])).map(x=>x.obsId)).toEqual(["a","b"]);
    expect((await f.retrieval.expandFromChunks(["a"])).map(x=>x.obsId)).toEqual(["b"]);
    expect((await f.retrieval.temporalQuery("Alpha")).entity?.id).toBe("new-a");
    expect((await f.hybrid.search("Alpha"))[0].graphScore).toBeGreaterThan(0);
    expect(list.mock.calls.filter(([scope])=>scope===KV.graphNodes||scope===KV.graphEdges)).toEqual([]);
  });
  it.each(["stale","retired","archived-edge","archived-node"])("preserves %s visibility after reset",async mode=>{
    const f=await fresh();const edge=await f.kv.get<GraphEdge>(KV.graphEdges,"new-ab");
    if(mode==="stale")await f.kv.set(KV.graphEdges,"new-ab",{...edge!,stale:true});
    if(mode==="retired")await f.kv.set(KV.graphEdges,"new-ab",{...edge!,reviewRetirement:{active:true,reason:"replaced",sourceObservationIds:["a"],sourceSessionIds:[],updatedAt:edge!.createdAt}});
    if(mode.startsWith("archived")){
      const target=mode==="archived-edge"?{kind:"graph_edge" as const,id:"new-ab"}:{kind:"graph_node" as const,id:"new-b"};
      const {key}=archiveTargetAddress(target);const record=await f.kv.get(mode==="archived-edge"?KV.graphEdges:KV.graphNodes,target.id);
      await f.kv.set(KV.archiveStates,key,{version:1,id:key,target,project:"A",state:"archived",revision:1,auditId:"fixture-audit",changedAt:new Date().toISOString(),reason:"fixture",targetDigest:archiveTargetDigest(record)});
    }
    expect(await f.retrieval.expandFromChunks(["a"])).toEqual([]);
    expect((await f.retrieval.temporalQuery("Alpha")).currentState).toEqual([]);
    expect((await f.retrieval.searchByEntities(["Alpha"])).map(x=>x.obsId)).toEqual(["a"]);
  });
  it("fails closed when nonempty reset graph has an unavailable index",async()=>{
    const f=await fresh();await f.kv.delete(KV.graphQueryManifest,"current");const list=vi.spyOn(f.kv,"list");
    await expect(f.retrieval.searchByEntities(["Alpha"])).rejects.toThrow(/unavailable/);
    expect((await f.hybrid.search("Alpha"))[0].graphScore).toBe(0);
    expect(list.mock.calls.filter(([scope])=>scope===KV.graphNodes||scope===KV.graphEdges)).toEqual([]);
  });
});
