import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { runEvidenceProcess } from "../verification/run-native-capture-e2e.mjs";
import { consumeNativeEvidence } from "../verification/native-evidence-store.mjs";
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const base = resolve(".tmp/native-process-tests"); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, "run-")); roots.push(root); return { root, id: randomUUID() }; }
const url = new URL("../verification/native-evidence-store.mjs", import.meta.url).href;
function child(root, id, mode) { return ["--input-type=module", "-e", `import{saveUnconfirmedEvidence}from${JSON.stringify(url)};const ack=await saveUnconfirmedEvidence(${JSON.stringify(root)},{executionId:${JSON.stringify(id)},success:false,verificationPassed:true});console.log('NATIVE_EVIDENCE '+JSON.stringify(${mode === "wrong-run" ? "{...ack,executionId:'00000000-0000-0000-0000-000000000000'}" : "ack"}));${mode === "nonzero" ? "process.exitCode=23;" : mode === "timeout" ? "setInterval(()=>{},1000);await new Promise(()=>{});" : ""}`]; }
test("real parent confirms only child normal zero exit and consumer needs parent outcome", async () => {
 const {root,id}=await fixture(); const outcome=await runEvidenceProcess({root,executionId:id,childArgs:child(root,id,"normal")});
 const stored=JSON.parse(await readFile(join(root,id,"result.json"),"utf8"));assert.equal(stored.record.success,false);
 assert.equal((await consumeNativeEvidence(root,{...outcome,exitCode:0})).success,true);
 await assert.rejects(consumeNativeEvidence(root,{...outcome,exitCode:1}));
});
for(const mode of ["nonzero","wrong-run","timeout"])test(`actual parent rejects ${mode} child despite written acknowledgment`,async()=>{
 const{root,id}=await fixture();await assert.rejects(runEvidenceProcess({root,executionId:id,childArgs:child(root,id,mode),timeoutMs:mode==="timeout"?1000:5000}),mode==="timeout"?/interrupted or timed out/:undefined);
 assert.equal(JSON.parse(await readFile(join(root,id,"result.json"),"utf8")).record.success,false);
 await assert.rejects(readFile(join(root,id,"confirmation.json")));
});
test("receipt written before parent interruption is not a successful consumer result",async()=>{
 const{root,id}=await fixture();const runner=new URL("../verification/run-native-capture-e2e.mjs",import.meta.url).href;
 const code=`import{runEvidenceProcess}from${JSON.stringify(runner)};const outcome=await runEvidenceProcess({root:${JSON.stringify(root)},executionId:${JSON.stringify(id)},childArgs:${JSON.stringify(child(root,id,"normal"))}});console.log(JSON.stringify(outcome));process.exit(29);`;
 const outer=spawnSync(process.execPath,["--input-type=module","-e",code],{encoding:"utf8"});assert.equal(outer.status,29);
 const outcome=JSON.parse(outer.stdout.trim());assert.equal(JSON.parse(await readFile(join(root,id,"confirmation.json"),"utf8")).state,"confirmed");
 await assert.rejects(consumeNativeEvidence(root,{...outcome,exitCode:outer.status}));
});
