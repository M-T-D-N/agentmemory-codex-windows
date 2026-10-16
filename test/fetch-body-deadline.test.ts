import { it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { fetchWithTimeout } from "../src/providers/_fetch.js";
import { startViewerServer } from "../src/viewer/server.js";
async function fixture(statuses:number[], delays:number[]) {
 let calls=0,closedResolve!:()=>void;const closed=new Promise<void>(r=>closedResolve=r);
 const server=createServer((_req,res)=>{const index=calls++;res.writeHead(statuses[Math.min(index,statuses.length-1)],{"content-type":"application/json","retry-after":"0"});res.flushHeaders();const timer=setTimeout(()=>res.end('{"ok":true}'),delays[Math.min(index,delays.length-1)]);res.once("close",()=>{clearTimeout(timer);closedResolve();});});
 server.listen(0,"127.0.0.1");await once(server,"listening");return {server,url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,port:(server.address() as AddressInfo).port,calls:()=>calls,closed};
}
async function stop(server:Server){const ended=new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));server.closeAllConnections();await ended;}
for(const status of [200,503])it(`dot F5 fast ${status} headers do not exempt slow body`,async()=>{
 const f=await fixture([status],[350]);try{const start=Date.now();await expect(fetchWithTimeout(f.url,{},100).then(r=>r.text())).rejects.toThrow();expect(Date.now()-start).toBeLessThan(300);}finally{await stop(f.server);}
});
it("dot F5 retry bodies share the original total deadline",async()=>{const f=await fixture([429,503,200],[40,40,250]);try{const start=Date.now();await expect(fetchWithTimeout(f.url,{},300).then(r=>r.text())).rejects.toThrow();expect(f.calls()).toBe(3);expect(Date.now()-start).toBeLessThan(550);}finally{await stop(f.server);}});
it("dot F5 caller cancels a pending body",async()=>{const f=await fixture([200],[500]);const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),50);try{const start=Date.now();await expect(fetchWithTimeout(f.url,{signal:controller.signal},3000).then(r=>r.text())).rejects.toThrow();expect(Date.now()-start).toBeLessThan(250);}finally{clearTimeout(timer);await stop(f.server);}});
it("dot F5 caller cancels retry sleep",async()=>{
 const server=createServer((_req,res)=>{res.writeHead(429,{"content-type":"application/json"});res.end('{}');});server.listen(0,"127.0.0.1");await once(server,"listening");const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),50);
 try{const start=Date.now();await expect(fetchWithTimeout(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,{signal:controller.signal},3000)).rejects.toThrow();expect(Date.now()-start).toBeLessThan(250);}finally{clearTimeout(timer);await stop(server);}
});
it("dot F5 viewer retains body deadline after upstream headers",{timeout:15000},async()=>{
 const f=await fixture([200],[14000]);const viewer=startViewerServer(0,{}, {},undefined,f.port);await once(viewer,"listening");try{const start=Date.now();const response=await fetch(`http://127.0.0.1:${(viewer.address() as AddressInfo).port}/status`);expect(response.status).toBe(504);expect(await response.json()).toEqual({error:"upstream timeout"});expect(Date.now()-start).toBeLessThan(12500);}finally{await stop(viewer);await stop(f.server);}
});
it("dot F5 viewer cancels upstream body when caller disconnects",async()=>{
 const f=await fixture([200],[1500]);const viewer=startViewerServer(0,{}, {},undefined,f.port);await once(viewer,"listening");const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),60);
 try{await expect(fetch(`http://127.0.0.1:${(viewer.address() as AddressInfo).port}/status`,{signal:controller.signal})).rejects.toThrow();const cancelled=await Promise.race([f.closed.then(()=>true),new Promise<boolean>(r=>setTimeout(()=>r(false),300))]);expect(cancelled).toBe(true);}finally{clearTimeout(timer);await stop(viewer);await stop(f.server);}
});
