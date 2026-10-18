import { it, expect } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { invokeQwenCoordination } from "../src/providers/local-qwen-coordination.js";
const helper=fileURLToPath(new URL("../src/providers/local-qwen-coordination.ps1",import.meta.url));
const env=Object.fromEntries(Object.entries(process.env).map(([k,v])=>[k.toUpperCase(),v]));
env.PSMODULEPATH=join(env.SYSTEMROOT!,"System32/WindowsPowerShell/v1.0/Modules");
const ps=join(env.SYSTEMROOT!,"System32/WindowsPowerShell/v1.0/powershell.exe");
type Held={child:ChildProcess;closed:Promise<number|null>;next:()=>Promise<any>;send:(value?:string)=>void};
async function childScript(root:string,code:string):Promise<Held>{
 const file=join(root,randomUUID()+".ps1");await writeFile(file,"$ErrorActionPreference='Stop'\n. $args[0]\n"+code);
 const child=spawn(ps,["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",file,helper,root],{env,windowsHide:true,stdio:["pipe","pipe","pipe"]});
 let pending:((v:any)=>void)|undefined;const lines:any[]=[];let buffer="",error="";
 child.stdout!.setEncoding("utf8");child.stderr!.setEncoding("utf8");child.stderr!.on("data",v=>error+=v);
 child.stdout!.on("data",v=>{buffer+=v;let n;while((n=buffer.indexOf("\n"))>=0){const value=JSON.parse(buffer.slice(0,n).trim());buffer=buffer.slice(n+1);if(pending){const done=pending;pending=undefined;done(value);}else lines.push(value);}});
 const closed=new Promise<number|null>((done,reject)=>{child.once("error",reject);child.once("close",code=>{if(code!==0)reject(Error("Fixture process failed: "+error));else done(code);});});
 return {child,closed,next:()=>lines.length?Promise.resolve(lines.shift()):new Promise(done=>pending=done),send:value=>child.stdin!.write((value??"continue")+"\n")};
}
const ready="[Console]::Out.WriteLine('{\"ready\":true}');[Console]::Out.Flush();$null=[Console]::ReadLine();";
async function fixture(run:(root:string,record:any)=>Promise<void>){
 const base=resolve(".tmp/qwen-process-tests");await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,"coordination-"));
 const identity=(await invokeQwenCoordination({operation:"identity",pid:process.pid})).identity;
 const record={owner:"agentmemory-background",pid:process.pid,processStartUtc:identity.processStartUtc,started_filetime_utc:identity.started_filetime_utc,token:randomUUID()};
 try{await run(root,record);}finally{await rm(root,{recursive:true,force:true});}
}
async function publish(root:string,record:any){const bytes=JSON.stringify(record);await writeFile(join(root,"qwen-use.lock.pending-"+record.token),bytes);return invokeQwenCoordination({operation:"publish",directory:root,record,recordBytes:bytes});}
it("serializes late stale observer and late release against a newly published owner",()=>fixture(async(root,record)=>{
 const old={...record,token:randomUUID(),started_filetime_utc:"1"};await writeFile(join(root,"qwen-use.lock"),JSON.stringify(old));
 const a=await childScript(root,`$root=$args[1];$snapshot=[IO.File]::ReadAllText((Join-Path $root 'qwen-use.lock'));${ready}
 $request=[Console]::ReadLine()|ConvertFrom-Json;$r=Invoke-AgentMemoryQwenCoordination -Request $request;[Console]::Out.WriteLine(($r|ConvertTo-Json -Compress));`);
 try{expect(await a.next()).toEqual({ready:true});await publish(root,record);
 const late={...old,token:randomUUID(),started_filetime_utc:record.started_filetime_utc};const bytes=JSON.stringify(late);await writeFile(join(root,"qwen-use.lock.pending-"+late.token),bytes);
 a.send();a.send(JSON.stringify({operation:"publish",directory:root,record:late,recordBytes:bytes}));expect(await a.next()).toMatchObject({ok:false,reason:"lease_busy"});await a.closed;
 expect(await invokeQwenCoordination({operation:"release",directory:root,record:old})).toMatchObject({removed:false});expect(JSON.parse(await readFile(join(root,"qwen-use.lock"),"utf8")).token).toBe(record.token);
 }finally{if(a.child.exitCode===null){a.send();a.send(JSON.stringify({operation:"inspect",directory:root}));await a.closed;}}
}),15000);
it("holds common OS guard across processes and recovers after owner exit",()=>fixture(async(root,record)=>{
 const a=await childScript(root,`$guard=[IO.FileStream]::new((Join-Path $args[1] 'qwen-use.lock.lifecycle.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);try{${ready}}finally{$guard.Dispose()}`);
 try{await a.next();await expect(publish(root,record)).rejects.toThrow("coordination_busy");}finally{a.send();await a.closed;}
 await expect(publish(root,record)).resolves.toMatchObject({published:true});
}),15000);
it("uses start identity for reused PID and preserves unreadable process identity",()=>fixture(async(root,record)=>{
 await writeFile(join(root,"qwen-use.lock"),JSON.stringify({...record,started_filetime_utc:"1"}));await publish(root,record);
 const unknown=await childScript(root,`$r=Invoke-AgentMemoryQwenCoordination -Request @{operation='inspect';directory=$args[1]} -ProcessLookup {throw [UnauthorizedAccessException]::new('fixture')};[Console]::Out.WriteLine(($r|ConvertTo-Json -Compress));`);
 expect(await unknown.next()).toMatchObject({lease:"unknown"});await unknown.closed;expect(JSON.parse(await readFile(join(root,"qwen-use.lock"),"utf8")).token).toBe(record.token);
}),15000);
it("defers to live foreground and reclaims a proven reused foreground PID",()=>fixture(async(root,record)=>{
 const path=join(root,"foreground-request.json");await writeFile(path,JSON.stringify(record));await expect(publish(root,record)).rejects.toThrow("foreground_requested");
 await writeFile(path,JSON.stringify({...record,started_filetime_utc:"1"}));await expect(publish(root,record)).resolves.toMatchObject({published:true});
}),15000);
it("preserves ownership on actual EBUSY and EPERM then releases after recovery",()=>fixture(async(root,record)=>{
 await publish(root,record);const held=await childScript(root,`$file=[IO.FileStream]::new((Join-Path $args[1] 'qwen-use.lock'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{${ready}}finally{$file.Dispose()}`);
 try{await held.next();await expect(invokeQwenCoordination({operation:"release",directory:root,record})).rejects.toMatchObject({code:"EBUSY"});}finally{held.send();await held.closed;}
 const attrs=await childScript(root,`$path=Join-Path $args[1] 'qwen-use.lock';[IO.File]::SetAttributes($path,[IO.FileAttributes]::ReadOnly);try{${ready}}finally{[IO.File]::SetAttributes($path,[IO.FileAttributes]::Normal)}`);
 try{await attrs.next();await expect(invokeQwenCoordination({operation:"release",directory:root,record})).rejects.toMatchObject({code:"EPERM"});}finally{attrs.send();await attrs.closed;}
 await expect(invokeQwenCoordination({operation:"release",directory:root,record})).resolves.toMatchObject({removed:true});
}),20000);
it("reclaims dead child owner and publishes through spaces and brackets",()=>fixture(async(root,record)=>{
 const nested=join(root,"space [literal]");await mkdir(nested);
 const owner=await childScript(root,`$identity=Get-AgentMemoryProcessIdentity $PID;$r=@{owner='agentmemory-background';pid=$PID;processStartUtc=$identity.processStartUtc;started_filetime_utc=$identity.started_filetime_utc;token=[Guid]::NewGuid().ToString()};[Console]::Out.WriteLine(($r|ConvertTo-Json -Compress));`);
 const dead=await owner.next();await owner.closed;await writeFile(join(nested,"qwen-use.lock"),JSON.stringify(dead));await expect(publish(nested,record)).resolves.toMatchObject({published:true});
}),15000);
