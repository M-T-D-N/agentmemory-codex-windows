import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {open,readFile,lstat} from 'node:fs/promises';
import {join,win32} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function exclusive(path,bytes){const f=await open(path,'wx');try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}}
async function identityAt(path){const s=await lstat(path);assert(s.isFile()&&!s.isSymbolicLink()&&s.size<=1048576,'Unsafe child identity');return readFile(path);}

// The supplied handle is the original child, never a later PID lookup.
export function collectOwnedProcess(child,{command,cwd,identityPath,timeoutMs,outputDirectory,launchedAt,parentPid=process.pid},effects={}){
  assert(Array.isArray(command)&&command.length&&Number.isSafeInteger(parentPid)&&parentPid>0,'Missing owned command');
  assert(Number.isSafeInteger(timeoutMs)&&timeoutMs>0,'Missing action budget');
  assert(typeof launchedAt==='string'&&/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(launchedAt)&&Number.isFinite(Date.parse(launchedAt)),'Original pre-spawn clock required');
  command=Object.freeze([...command]);
  const now=effects.now??(()=>new Date().toISOString()),readIdentity=effects.readIdentity??identityAt,write=effects.write??exclusive;
  const schedule=effects.setTimeout??setTimeout,cancel=effects.clearTimeout??clearTimeout;
  const outputLimit=effects.outputLimit??32*1024*1024,lateLimit=effects.lateLimit??1024*1024;
  const prefix=join(outputDirectory,'terminal-'+randomUUID()),terminalPaths={receipt:prefix+'.json',stdout:prefix+'.stdout.bin',stderr:prefix+'.stderr.bin'};
  const out=[],err=[],lateOut=[],lateErr=[];
  let primaryDone=false,total=0,lateTotal=0,lateTruncated=false,timer,exitEvent=null,closeEvent=null,spawnError=null,primaryReason=null;
  let resolvePrimary,resolveTerminal,bindingPromise;
  const primary=new Promise(resolve=>{resolvePrimary=resolve;}),terminal=new Promise(resolve=>{resolveTerminal=resolve;});
  async function readBinding(){
    let identityBytes=null,identityError=null,identity=null;
    try{identityBytes=await readIdentity(identityPath);identity=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(identityBytes));assert(identity.pid===child.pid&&typeof identity.executable==='string'&&win32.normalize(identity.executable).toLowerCase()===win32.normalize(command[0]).toLowerCase()&&/^\d{17,20}$/.test(identity.creation_filetime),'Incomplete original child birth identity');}
    catch(error){identityError=error.code??error.message;identity=null;}
    return {identityBytes,identityError,identity};
  }
  async function finishPrimary(value){
    if(primaryDone)return;primaryDone=true;primaryReason=value.error_code??'CLOSE';cancel(timer);
    const binding=await (bindingPromise??=readBinding());
    resolvePrimary({...value,pid:child.pid,parent_pid:parentPid,identityBytes:binding.identityBytes,identityError:binding.identityError,
      launched_at_utc:launchedAt,timeout_ms:timeoutMs,end_utc:now(),stdout:Buffer.concat(out),stderr:Buffer.concat(err),
      terminal_evidence:{...terminalPaths,command_sha256:sha(Buffer.from(JSON.stringify(command))),original_identity_path:identityPath}});
  }
  const append=(early,late,chunk)=>{
    const bytes=Buffer.from(chunk);
    if(primaryDone){const n=Math.min(bytes.length,Math.max(0,lateLimit-lateTotal));if(n)late.push(bytes.subarray(0,n));lateTotal+=n;if(n<bytes.length)lateTruncated=true;return;}
    const n=Math.min(bytes.length,Math.max(0,outputLimit-total));if(n)early.push(bytes.subarray(0,n));total+=n;
    if(n<bytes.length)void finishPrimary({exit_code:null,error_code:'OUTPUT_LIMIT',output_truncated:true,pending:child.exitCode===null});
  };
  let terminalStarted=false;
  async function finishTerminal(){
    if(terminalStarted)return;terminalStarted=true;
    try{
      const binding=await (bindingPromise??=readBinding()),stdout=Buffer.concat(lateOut),stderr=Buffer.concat(lateErr);
      await write(terminalPaths.stdout,stdout);await write(terminalPaths.stderr,stderr);
      const value={schema_version:1,evidence_kind:'owned_child_terminal',production_qualified:false,
        pid:child.pid??null,parent_pid:parentPid,command:[...command],cwd,command_sha256:sha(Buffer.from(JSON.stringify(command))),
        original_identity_path:identityPath,identity_sha256:binding.identityBytes?sha(binding.identityBytes):null,
        creation_filetime:binding.identity?.creation_filetime??null,created_at_utc:binding.identity?.created_at_utc??null,
        executable:binding.identity?.executable??null,identity_error:binding.identityError,
        launched_at_utc:launchedAt,timeout_ms:timeoutMs,primary_reason:primaryReason,exit:exitEvent,close:closeEvent,spawn_error:spawnError,
        late_stdout:{path:terminalPaths.stdout,sha256:sha(stdout),bytes:stdout.length},late_stderr:{path:terminalPaths.stderr,sha256:sha(stderr),bytes:stderr.length},
        late_output_truncated:lateTruncated,automatic_resume:false,recorded_at_utc:now()};
      await write(terminalPaths.receipt,Buffer.from(JSON.stringify(value,null,2)));
      resolveTerminal({recorded:true,path:terminalPaths.receipt,receipt:value});
    }catch(error){resolveTerminal({recorded:false,error_code:error.code??'TERMINAL_STORAGE_ERROR'});}
  }
  child.stdout.on('data',bytes=>append(out,lateOut,bytes));child.stderr.on('data',bytes=>append(err,lateErr,bytes));
  child.once('exit',(code,signal)=>{exitEvent={exit_code:code,signal:signal??null,observed_at_utc:now()};});
  child.once('error',error=>{spawnError={code:error.code??'SPAWN_ERROR',observed_at_utc:now()};void finishPrimary({exit_code:null,error_code:spawnError.code,pending:false});});
  child.once('close',(code,signal)=>{closeEvent={exit_code:code,signal:signal??null,observed_at_utc:now()};void finishPrimary({exit_code:code,signal:signal??null,pending:false});void finishTerminal();});
  timer=schedule(()=>void finishPrimary({exit_code:null,error_code:'TIMEOUT',pending:child.exitCode===null}),timeoutMs);
  return Object.freeze({primary,terminal});
}

export function runOwnedProcess(options){
  const {command,cwd,environment}=options;
  const launchedAt=new Date().toISOString();
  const child=spawn(command[0],command.slice(1),{cwd,windowsHide:true,shell:false,env:environment,stdio:['ignore','pipe','pipe']});
  return collectOwnedProcess(child,{...options,launchedAt}).primary;
}
