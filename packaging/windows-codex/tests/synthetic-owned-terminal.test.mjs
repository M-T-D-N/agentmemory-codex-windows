import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {collectOwnedProcess,runOwnedProcess} from '../verification/windows-owned-process.mjs';

function fixture(extra={}){
  const child=new EventEmitter();child.pid=1234;child.exitCode=null;child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  const files=new Map();let timeout,clock=0;
  const command=['C:\\Windows\\powershell.exe','-File','C:\\candidate\\Install.ps1'];
  const identity=Buffer.from(JSON.stringify({pid:1234,creation_filetime:'134377326109647806',created_at_utc:'2026-10-29T07:30:10.9647806Z',executable:command[0]}));
  const capture=collectOwnedProcess(child,{command,cwd:'C:\\candidate',identityPath:'C:\\captures\\identity.json',timeoutMs:30000,outputDirectory:'C:\\captures',launchedAt:'2026-10-29T08:00:00.000Z',parentPid:4321},{now:()=>new Date(Date.UTC(2026,9,29,8,0,0,clock++)).toISOString(),setTimeout:fn=>(timeout=fn,1),clearTimeout:()=>{},readIdentity:async()=>Buffer.from(identity),write:async(path,b)=>{assert(!files.has(path),'No overwrite');files.set(path,Buffer.from(b));},...extra});
  return {child,files,capture,timeout:()=>timeout(),command};
}
for(const code of [0,7])test('timeout remains immutable after late exit '+code,async()=>{
  const f=fixture();f.child.stdout.emit('data',Buffer.from('early'));f.timeout();const primary=await f.capture.primary;
  assert.equal(primary.error_code,'TIMEOUT');assert.equal(primary.exit_code,null);assert.equal(primary.pending,true);const original=JSON.stringify(primary);
  f.child.stdout.emit('data',Buffer.from('late'));f.child.stderr.emit('data',Buffer.from('diagnostic'));
  f.child.exitCode=code;f.child.emit('exit',code,null);f.child.emit('close',code,null);
  const terminal=await f.capture.terminal;assert.equal(terminal.recorded,true);assert.equal(terminal.receipt.exit.exit_code,code);assert.equal(terminal.receipt.close.exit_code,code);
  assert.equal(terminal.receipt.creation_filetime,'134377326109647806');assert.equal(terminal.receipt.parent_pid,4321);assert.deepEqual(terminal.receipt.command,f.command);
  assert.equal(f.files.get(primary.terminal_evidence.stdout).toString(),'late');assert.equal(f.files.get(primary.terminal_evidence.stderr).toString(),'diagnostic');assert.equal(JSON.stringify(primary),original);assert.equal(terminal.receipt.automatic_resume,false);
});
test('signal is kept separately from exit code',async()=>{const f=fixture();f.timeout();await f.capture.primary;f.child.emit('exit',null,'SIGTERM');f.child.emit('close',null,'SIGTERM');const t=await f.capture.terminal;assert.equal(t.receipt.exit.signal,'SIGTERM');assert.equal(t.receipt.close.exit_code,null);});
test('overflow is bounded before and after timeout',async()=>{const f=fixture({outputLimit:4,lateLimit:3});f.child.stdout.emit('data',Buffer.from('12345'));const p=await f.capture.primary;assert.equal(p.error_code,'OUTPUT_LIMIT');assert.equal(p.stdout.length,4);f.child.stderr.emit('data',Buffer.from('123456'));f.child.emit('exit',7,null);f.child.emit('close',7,null);const t=await f.capture.terminal;assert.equal(t.receipt.late_stderr.bytes,3);assert.equal(t.receipt.late_output_truncated,true);});
test('exit does not imply pipe close; delayed output survives',async()=>{const f=fixture();f.timeout();await f.capture.primary;f.child.exitCode=0;f.child.emit('exit',0,null);f.child.stdout.emit('data',Buffer.from('last pipe bytes'));assert.equal(f.files.size,0);f.child.emit('close',0,null);const t=await f.capture.terminal;assert(Date.parse(t.receipt.exit.observed_at_utc)<Date.parse(t.receipt.close.observed_at_utc));assert.equal(f.files.get(t.receipt.late_stdout.path).toString(),'last pipe bytes');});
test('terminal storage failure is explicit, without changing primary timeout',async()=>{const f=fixture({write:async()=>{throw Object.assign(new Error('fixture write failed'),{code:'EACCES'});}});f.timeout();const p=await f.capture.primary;f.child.emit('exit',0,null);f.child.emit('close',0,null);assert.deepEqual(await f.capture.terminal,{recorded:false,error_code:'EACCES'});assert.equal(p.exit_code,null);});
test('normal close retains original primary result and immutable terminal file',async()=>{const f=fixture();f.child.stdout.emit('data',Buffer.from('ok'));f.child.exitCode=0;f.child.emit('exit',0,null);f.child.emit('close',0,null);const p=await f.capture.primary,t=await f.capture.terminal;assert.equal(p.exit_code,0);assert.equal(p.stdout.toString(),'ok');assert.equal(t.receipt.primary_reason,'CLOSE');assert.equal(f.files.size,3);f.child.emit('close',7,null);assert.equal(f.files.size,3);});
test('missing birth identity cannot masquerade as a valid terminal binding',async()=>{const f=fixture({readIdentity:async()=>Buffer.from('{}')});f.timeout();await f.capture.primary;f.child.emit('exit',0,null);f.child.emit('close',0,null);const t=await f.capture.terminal;assert.equal(t.receipt.creation_filetime,null);assert(t.receipt.identity_error);assert.equal(t.receipt.automatic_resume,false);});

test('late identity cannot replace the original timeout birth binding',async()=>{let reads=0;const f=fixture({readIdentity:async()=>{reads++;return Buffer.from(JSON.stringify({pid:1234,creation_filetime:reads===1?'134377326109647806':'134377326109647807',created_at_utc:'2026-10-29T07:30:10.9647806Z',executable:'C:\\Windows\\powershell.exe'}));}});f.timeout();await f.capture.primary;f.child.emit('exit',0,null);f.child.emit('close',0,null);const t=await f.capture.terminal;assert.equal(reads,1);assert.equal(t.receipt.creation_filetime,'134377326109647806');});

test('pre-spawn time precedes OS birth even when collector starts in a later millisecond',async()=>{
 const child=new EventEmitter();child.pid=2345;child.exitCode=null;child.stdout=new EventEmitter();child.stderr=new EventEmitter();
 const preSpawn='2026-10-29T08:00:00.000Z',created='2026-10-29T08:00:00.001Z',collectorStart='2026-10-29T08:00:00.002Z';
 const identity=Buffer.from(JSON.stringify({pid:2345,creation_filetime:'134377344000010000',created_at_utc:created,executable:'C:\\Windows\\powershell.exe'}));
 const capture=collectOwnedProcess(child,{command:['C:\\Windows\\powershell.exe','-File','C:\\candidate\\Install.ps1'],cwd:'C:\\candidate',identityPath:'C:\\captures\\id.json',timeoutMs:30000,outputDirectory:'C:\\captures',launchedAt:preSpawn,parentPid:4321},{now:()=>collectorStart,readIdentity:async()=>identity,write:async()=>{},setTimeout:()=>1,clearTimeout:()=>{}});
 child.exitCode=0;child.emit('exit',0,null);child.emit('close',0,null);const primary=await capture.primary,terminal=await capture.terminal;
 assert.equal(primary.launched_at_utc,preSpawn);assert(Date.parse(primary.launched_at_utc)<=Date.parse(JSON.parse(primary.identityBytes).created_at_utc));assert(Date.parse(created)<Date.parse(collectorStart));assert.equal(terminal.receipt.launched_at_utc,preSpawn);
 const source=runOwnedProcess.toString();assert(source.indexOf('const launchedAt=')<source.indexOf('spawn('),'Real launcher captures time before spawning');assert(source.includes('collectOwnedProcess(child,{...options,launchedAt})'));
});
