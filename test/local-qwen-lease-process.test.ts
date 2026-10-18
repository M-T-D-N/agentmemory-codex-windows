import { it, expect } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const source = fileURLToPath(new URL("../src/providers/local-qwen.ts", import.meta.url));
const childCode = `
import {readFileSync,existsSync} from 'node:fs';import {stripTypeScriptTypes} from 'node:module';import {SourceTextModule,SyntheticModule} from 'node:vm';import {join,dirname} from 'node:path';import{pathToFileURL}from'node:url';
const[source,root,mode]=process.argv.slice(1);process.env.AGENTMEMORY_LOCAL_QWEN_COORDINATION_DIR=root;
let injected=false;
const module=new SourceTextModule(stripTypeScriptTypes(readFileSync(source,'utf8'),{mode:'transform'}),{identifier:source});
await module.link(async name=>{
 if(name==='./local-qwen-coordination.js'){const actual=await import(pathToFileURL(join(dirname(source),'local-qwen-coordination.ts')));return new SyntheticModule(Object.keys(actual),function(){for(const[key,value]of Object.entries(actual))this.setExport(key,value);});}
 if(name==='../config.js')return new SyntheticModule(['getEnvVar'],function(){this.setExport('getEnvVar',key=>process.env[key]);});
 if(name==='./local-qwen-lifecycle.js')return new SyntheticModule(['localQwenBackgroundDeferral'],function(){this.setExport('localQwenBackgroundDeferral',()=>null);});
 const actual=await import(name),values={...actual};
 if(name==='node:fs/promises'&&mode!=='normal')values.open=async(...args)=>{const h=await actual.open(...args);if(injected)return h;injected=true;return new Proxy(h,{get(target,key){if(key==='writeFile'&&mode!=='close')return async data=>{if(mode==='partial')await target.writeFile(data.slice(0,8));throw Object.assign(Error('child ENOSPC'),{code:'ENOSPC'});};if(key==='close'&&mode==='close')return async()=>{await target.close();throw Error('child close failure');};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});};
 return new SyntheticModule(Object.keys(values),function(){for(const[key,value]of Object.entries(values))this.setExport(key,value);});
});await module.evaluate();
const provider=new module.namespace.LocalQwenProvider('auto',2048,'http://127.0.0.1:8000');
try{const release=await provider.acquireBackgroundLease();await release();console.log(JSON.stringify({pid:process.pid,canonicalExists:existsSync(join(root,'qwen-use.lock')),success:true}));}catch(error){console.log(JSON.stringify({pid:process.pid,canonicalExists:existsSync(join(root,'qwen-use.lock')),error:error.message}));process.exitCode=23;}
`;
for(const mode of ["write-before","partial","close"])it(`dot F3 real process restart after ${mode} preparation failure`,async()=>{
 const base=resolve(".tmp/qwen-process-tests");await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,"run-"));
 try{
  const first=spawnSync(process.execPath,["--experimental-vm-modules","--input-type=module","-e",childCode,source,root,mode],{encoding:"utf8",timeout:10000,windowsHide:true});
  expect(first.status,first.stderr).toBe(23);const failed=JSON.parse(first.stdout.trim());expect(failed.canonicalExists).toBe(false);
  const next=spawnSync(process.execPath,["--experimental-vm-modules","--input-type=module","-e",childCode,source,root,"normal"],{encoding:"utf8",timeout:10000,windowsHide:true});
  expect(next.status,next.stderr).toBe(0);const passed=JSON.parse(next.stdout.trim());expect(passed.success).toBe(true);expect(passed.canonicalExists).toBe(false);expect(passed.pid).not.toBe(failed.pid);
 }finally{await rm(root,{recursive:true,force:true});}
});
