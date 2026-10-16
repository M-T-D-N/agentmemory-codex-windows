import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { runNativeCaptureE2e } from "./native-capture-e2e.mjs";
import { saveUnconfirmedEvidence } from "./native-evidence-store.mjs";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = async path => JSON.parse(await readFile(path, "utf8"));
const childPath = (root, path) => {
  const target = resolve(root, path); assert(!relative(resolve(root), target).startsWith(".."), "Path outside installation"); return target;
};
const [mode, configPath, executionId] = process.argv.slice(2);
let sdk;
try {
  const config = await json(configPath), install = resolve(config.installRoot);
  const installed = await json(join(install, "config/install-manifest.json"));
  const packageRoot = childPath(install, installed.package_relative_path);
  const { registerWorker } = await import(pathToFileURL(join(packageRoot, "node_modules/iii-sdk/dist/index.mjs")));
  sdk = registerWorker(config.engineUrl ?? "ws://127.0.0.1:49134");
  const trigger = (id, payload) => sdk.trigger({ function_id: id, payload });
  const rows = async scope => (await trigger("state::list", { scope })).map(row => row.value ?? row);
  if (mode === "baseline") {
    const selection = await json(config.selectionPath); const sessions = [];
    for (const selected of selection.rows) {
      const current = await rows("mem:obs:" + selected.id), byId = new Map(current.map(row => [row.id, row]));
      sessions.push({ id: selected.id, identities: selected.identities.map(prior => { const row = byId.get(prior.id); assert(row, "Baseline observation missing"); return { id: row.id, narrativeDigest: hash(JSON.stringify(row.narrative) ?? "undefined"), source: row.codexSource, deleted: row.deleted }; }) });
    }
    await writeFile(config.baselinePath, JSON.stringify({ at: new Date().toISOString(), release: installed.release_revision, authHash: hash(await readFile(join(install, "config/secret.dpapi"))), sessions }, null, 2), { flag: "wx" });
    console.log(JSON.stringify({ baseline: config.baselinePath, observations: sessions.reduce((n, s) => n + s.identities.length, 0) }));
  } else {
    assert.equal(mode, "run");
    const manifestBytes = await readFile(join(config.releaseRoot, "release-manifest.json")), manifest = JSON.parse(manifestBytes);
    assert.equal(installed.installation_status, "activated"); assert.equal(installed.release_revision, config.expectedRevision);
    assert.equal(hash(manifestBytes), installed.release_manifest_sha256.toLowerCase());
    const workerRelative = join(installed.package_relative_path, "dist/index.mjs"), runtimeHash = hash(await readFile(childPath(install, workerRelative)));
    assert.equal(runtimeHash, hash(await readFile(join(config.releaseRoot, "payload", workerRelative))));
    const identity = { sourceCommit: manifest.source_commit, runtime: installed.release_revision, runtimeHash, releaseManifestHash: hash(manifestBytes), node: process.version,
      verifierHash: hash(await readFile(new URL("./native-capture-e2e.mjs", import.meta.url))), operatingWrapperHash: hash(await readFile(new URL(import.meta.url))), activationAt: installed.verified_at_utc,
      gitHead: { status: "not-queried", reason: "Qualified release identity verified by installed manifest and payload bytes" } };
    const request = async (route, body, { signal } = {}) => {
      const response = await fetch((config.apiUrl ?? "http://127.0.0.1:3111/agentmemory/") + route, { method: body ? "POST" : "GET", headers: { authorization: "Bearer " + process.env.AGENTMEMORY_SECRET, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
      return { status: response.status, body: await response.json() };
    };
    for (let n = 0; n < 8; n++) { const value = await trigger("mem::codex-source-capture", { project: config.project, sessionId: config.sessionId }); assert(!value.issue); if (value.status === "caught_up") break; }
    const observations = await rows("mem:obs:" + config.sessionId);
    const row = observations.filter(row => row.codexSource && row.narrative.includes(config.query)).sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    assert(row, "Actual requested native source has not been collected");
    const verifyAdditional = async ({ signal, observeWorker }) => {
      const baseline = await json(config.baselinePath); let preserved = 0;
      for (const session of baseline.sessions) {
        const byId = new Map((await rows("mem:obs:" + session.id)).map(row => [row.id, row]));
        for (const prior of session.identities) { const current = byId.get(prior.id); assert(current); assert.equal(hash(JSON.stringify(current.narrative) ?? "undefined"), prior.narrativeDigest); assert.deepEqual(current.codexSource, prior.source); assert.deepEqual(current.deleted, prior.deleted); preserved++; }
        signal.throwIfAborted();
      }
      assert.equal(hash(await readFile(join(install, "config/secret.dpapi"))), baseline.authHash);
      const graph = async (sourceId, fresh) => {
        const result = (await rows("mem:graph:results:" + config.sessionId)).find(row => row.id === sourceId);
        if (!result || result.outcome !== "extracted") return null;
        if (fresh) assert(Date.parse(result.completedAt) >= Date.parse(identity.activationAt), "Extraction predates this activation");
        const linked = (await rows("mem:graph:nodes")).filter(node => node.project === config.project && node.sourceObservationIds?.includes(sourceId)); assert(linked.length > 0, "Automatic extraction has no linked nodes");
        const response = await request("graph/query", { project: config.project, startNodeId: linked[0].id, maxDepth: 1, limit: 20 }, { signal }); assert.equal(response.status, 200); assert(response.body.nodes.some(node => node.id === linked[0].id));
        const source = observations.find(item => item.id === sourceId); assert(source?.codexSource, "Graph source missing from canonical native observations");
        return { sourceId, sourceKey: source.codexSource.key, nodes: linked.map(node => node.id), queried: response.body.nodes.length, extraction: result };
      };
      const preservedGraph = await graph(config.existingGraphObservationId, false); assert(preservedGraph, "Existing automatic graph unavailable");
      let freshGraph;
      if (config.requireFreshGraph) {
        while (!(freshGraph = await graph(row.id, true))) {
          signal.throwIfAborted(); await observeWorker();
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      return { preserved, authenticationPreserved: true, existingGraph: preservedGraph, freshGraph: freshGraph ?? { status: "not-executed", reason: "Qwen startup not authorized" } };
    };
    const result = await runNativeCaptureE2e({ executionId, deadlineMs: config.deadlineMs ?? 300000, identity,
      target: { project: config.project, sessionId: config.sessionId, observationId: row.id, sourceKey: row.codexSource.key, query: config.query, narrativeDigest: hash(JSON.stringify(row.narrative)) }, trigger, request, verifyAdditional,
      save: (record, context) => saveUnconfirmedEvidence(config.evidenceRoot, record, context) });
    console.log("NATIVE_EVIDENCE " + JSON.stringify(result.storage));
  }
} catch (error) { console.error(JSON.stringify({ error: error.message, result: error.result ?? null })); process.exitCode = 1; }
finally { sdk?.shutdown(); }
