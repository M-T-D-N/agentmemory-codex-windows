import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  boundedAdditionalContext,
  collectHandledObservationIds,
  formatCurationContext,
  formatGraphContext,
  formatRecallContext,
  isExcludedSession,
  isInternalCodexAmbientPrompt,
  isSdkChildContext,
  observationCurationSource,
  promptText,
  safeText,
  selectFairCurationSources,
} from "../hooks/codex-turn.mjs";

const STANDALONE = resolve(
  import.meta.dirname, "..", "..", "..",
  "dist",
  "standalone.mjs",
);
const MCP_WRAPPER = resolve(
  process.env.AGENTMEMORY_MCP_WRAPPER ||
    join(import.meta.dirname, "..", "powershell", "agentmemory-mcp.ps1"),
);
const HOOK_WRAPPER = resolve(
  process.env.AGENTMEMORY_HOOK_WRAPPER ||
    join(import.meta.dirname, "agentmemory-hook.ps1"),
);

async function callStandalone(url, name, args, syntheticHome) {
  const child = spawn(process.execPath, [STANDALONE], {
    env: {
      ...process.env,
      AGENTMEMORY_URL: url,
      AGENTMEMORY_FORCE_PROXY: "true",
      AGENTMEMORY_SECRET: "",
      HOME: syntheticHome,
      USERPROFILE: syntheticHome,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const response = await new Promise((resolveResponse, reject) => {
    const timeout = setTimeout(() => reject(new Error(`MCP response timeout: ${stderr}`)), 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line);
        if (parsed.id === 1) {
          clearTimeout(timeout);
          resolveResponse(parsed);
        }
      }
    });
    child.once("error", reject);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    })}\n`);
  });
  child.stdin.end();
  child.kill();
  return response;
}

async function callOfficialMcp(name, args) {
  const child = spawn("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    MCP_WRAPPER,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const response = await new Promise((resolveResponse, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Official MCP response timeout: ${stderr}`)), 15_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line);
        if (parsed.id === 1) {
          clearTimeout(timeout);
          resolveResponse(parsed);
        }
      }
    });
    child.once("error", reject);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    })}\n`);
  });
  child.stdin.end();
  await Promise.race([
    once(child, "exit"),
    new Promise((resolveWait) => setTimeout(resolveWait, 1_000)),
  ]);
  if (child.exitCode === null) child.kill();
  return response;
}

function mcpTextJson(response) {
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  assert.notEqual(response.result?.isError, true, response.result?.content?.[0]?.text);
  return JSON.parse(response.result?.content?.[0]?.text ?? "null");
}

async function callOfficialHook(event) {
  const child = spawn("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    HOOK_WRAPPER,
    "-ScriptName",
    "codex-turn.mjs",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(event));
  const [code] = await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`Official hook timeout: ${stderr}`)),
      15_000,
    )),
  ]);
  assert.equal(code, 0, stderr);
  return stdout.trim() ? JSON.parse(stdout) : null;
}

function recallObservations(payload) {
  return (payload?.results ?? []).map((result) => result?.observation).filter(Boolean);
}

test("normal user text is preserved without trimming or sensitivity-based rejection", () => {
  const text = "  일반 사용자 원문 password=descriptive-not-a-secret  \n" + "가".repeat(20_000);
  assert.equal(safeText(text), text);
  assert.equal(promptText(text), text);
});

test("ambient UI state is removed without discarding the surrounding user message", () => {
  const prompt = "사용자 원문\n<ctx source=\"ambient-ui-state\">internal state</ctx>마지막 문장";
  assert.equal(promptText(prompt), "사용자 원문\n마지막 문장");
});

test("known Codex internal prompt templates and their sessions are excluded", () => {
  const titlePrompt = "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt. Return JSON.";
  const existingConversationTitlePrompt = "You are a helpful assistant. You will be presented with the most recent messages in an existing conversation. Your job is to generate a short title for the conversation.";
  const forkPrompt = "You are in a fork of an existing Codex thread. Fill the structured description field with a compact, search-oriented summary (up to 100 characters).";
  const activityUpdatePrompt = "You write the one-line activity update displayed beneath an existing Codex task title. Fill the structured summary field with one plain-text sentence of at most 280 characters. The task title is already visible; add the latest meaningful detail instead of repeating it.";
  const projectlessSuggestionPrompt = "# Overview\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex.";
  assert.equal(isInternalCodexAmbientPrompt(titlePrompt), true);
  assert.equal(isInternalCodexAmbientPrompt(existingConversationTitlePrompt), true);
  assert.equal(isInternalCodexAmbientPrompt(forkPrompt), true);
  assert.equal(isInternalCodexAmbientPrompt(activityUpdatePrompt), true);
  assert.equal(isInternalCodexAmbientPrompt(projectlessSuggestionPrompt), true);
  assert.equal(promptText(titlePrompt), null);
  assert.equal(promptText(existingConversationTitlePrompt), null);
  assert.equal(promptText(activityUpdatePrompt), null);
  assert.equal(isExcludedSession({ firstPrompt: titlePrompt.slice(0, 200) }), true);
  assert.equal(isExcludedSession({ firstPrompt: activityUpdatePrompt.slice(0, 200) }), true);
  assert.equal(isExcludedSession({ captureExcluded: true }), true);
});

test("structured Codex host payloads are excluded even when delivered as user prompts", () => {
  const payloads = [
    '<subagent_notification>{"status":"completed"}</subagent_notification>',
    '<in-app-browser-context>{"active":true}</in-app-browser-context>',
    '<hook_prompt>internal hook payload</hook_prompt>',
    '<recommended_plugins><plugin>internal</plugin></recommended_plugins>',
    '<app-context>host application context</app-context>',
    '<skills_instructions>host skill routing</skills_instructions>',
    '<permissions instructions>host sandbox policy</permissions instructions>',
    '<turn_aborted>host interruption marker</turn_aborted>',
    '# AGENTS.md instructions for D:\\workspaces\\example',
    '# Response annotations:\ninternal response metadata',
  ];

  for (const payload of payloads) {
    assert.equal(isInternalCodexAmbientPrompt(payload), true);
    assert.equal(promptText(payload), null);
  }
});

test("subagent hook payloads are excluded by their Codex agent identity", () => {
  assert.equal(isSdkChildContext({ agent_id: "019ff548-subagent" }), true);
  assert.equal(isSdkChildContext({ agentId: "019ff548-subagent" }), true);
  assert.equal(isSdkChildContext({ agent_type: "default" }), true);
  assert.equal(isSdkChildContext({ agentType: "explorer" }), true);
  assert.equal(isSdkChildContext({ agent_type: "main" }), false);
  assert.equal(isSdkChildContext({}), false);
});

test("official derived-store provenance suppresses already curated observations", () => {
  const handled = collectHandledObservationIds(
    [{ sourceObservationIds: ["obs-memory"] }],
    [{ sourceIds: ["obs-lesson"] }],
    {
      nodes: [{ sourceObservationIds: ["obs-node"] }],
      edges: [{ sourceObservationIds: ["obs-edge"] }],
    },
  );
  assert.deepEqual(
    [...handled].sort(),
    ["obs-edge", "obs-lesson", "obs-memory", "obs-node"],
  );
});

test("automatic structural and provider graph provenance does not suppress Codex curation", () => {
  const handled = collectHandledObservationIds(
    [],
    [],
    {
      nodes: [
        {
          properties: { curation_lane: "structural_graph", curation_claim: false },
          sourceObservationIds: ["obs-structural"],
        },
        {
          properties: { curation_lane: "provider_graph", curation_claim: false },
          sourceObservationIds: ["obs-provider"],
        },
        {
          properties: { curation_status: "confirmed" },
          sourceObservationIds: ["obs-codex"],
        },
      ],
      edges: [{
        properties: { curation_lane: "provider_graph", curation_claim: false },
        sourceObservationIds: ["obs-provider-edge"],
      }],
    },
  );
  assert.deepEqual([...handled], ["obs-codex"]);
});

test("historical project reconciliation provenance does not claim semantic curation", () => {
  const handled = collectHandledObservationIds(
    [],
    [],
    {
      nodes: [
        {
          id: "node-reconciled",
          type: "project",
          properties: { curation_status: "historical_raw_provenance_reconciled" },
          sourceObservationIds: ["obs-reconciled-only"],
        },
        {
          type: "decision",
          properties: { status: "confirmed" },
          sourceObservationIds: ["obs-semantic-claim"],
        },
        {
          type: "project",
          properties: { curation_status: "historical_raw_provenance_reviewed" },
          sourceObservationIds: ["obs-reviewed-nondurable"],
        },
      ],
      edges: [
        {
          sourceNodeId: "node-reconciled",
          targetNodeId: "node-semantic",
          sourceObservationIds: ["obs-reconciled-edge"],
        },
        {
          sourceNodeId: "node-semantic",
          targetNodeId: "node-reviewed",
          sourceObservationIds: ["obs-semantic-edge"],
        },
        {
          properties: { curation_status: "historical_raw_provenance_reconciled" },
          sourceObservationIds: ["obs-explicit-reconciled-edge"],
        },
      ],
    },
  );
  assert.deepEqual(
    [...handled].sort(),
    ["obs-reviewed-nondurable", "obs-semantic-claim", "obs-semantic-edge"],
  );
});

test("fair curation selection does not let a repeatedly skipped oldest source block later work", () => {
  const sessions = [
    {
      session: { id: "session-old" },
      observations: [{
        id: "obs-old",
        title: "assistant_response",
        timestamp: "2026-01-01T00:00:00Z",
        narrative: "Implemented and verified a durable workflow decision with tests and file evidence. " + "x".repeat(180),
      }],
    },
    {
      session: { id: "session-new" },
      observations: [{
        id: "obs-new",
        title: "assistant_response",
        timestamp: "2026-01-02T00:00:00Z",
        narrative: "Fixed and verified a reusable architecture lesson with canary evidence. " + "y".repeat(180),
      }],
    },
  ];
  const observed = new Set();
  for (let turn = 0; turn < 32; turn++) {
    for (const source of selectFairCurationSources(sessions, new Set(), `turn-${turn}`)) {
      observed.add(source.observationId);
    }
  }
  assert.deepEqual([...observed].sort(), ["obs-new", "obs-old"]);
});

test("curation context requires exact official provenance fields", () => {
  const source = observationCurationSource({
    id: "obs-source",
    title: "prompt_submit",
    narrative: "앞으로 공식 project 격리를 항상 유지하고 별도 fallback은 사용하지 말 것",
  }, "session-source");
  assert.equal(source?.observationId, "obs-source");
  const context = formatCurationContext("example-workspace", [source]);
  assert.match(context, /memory_save with sourceObservationIds/);
  assert.match(context, /memory_lesson_save with sourceIds/);
  assert.match(context, /"observationId": "obs-source"/);
});

test("curation and graph context stay within the managed hook output budget", () => {
  const sources = [1, 2].map((index) => ({
    kind: "assistant_result",
    sessionId: `session-${index}`,
    observationId: `observation-${index}`,
    content: "x".repeat(420),
  }));
  const curation = formatCurationContext("example-workspace", sources);
  assert.match(curation, /<\/agentmemory-curation>$/);
  const graph = formatGraphContext("AgentMemory context budget contract", "example-workspace", {
    nodes: [{
      id: "gn-budget",
      type: "contract",
      name: "AgentMemory context budget contract",
      properties: { summary: "g".repeat(1_000), project: "example-workspace" },
    }],
    edges: [],
  });
  assert.match(graph, /<\/agentmemory-graph-context>$/);
  const combined = boundedAdditionalContext(curation, graph);
  assert.ok(combined.length <= 2_300, `context length was ${combined.length}`);
  assert.match(combined, /<\/agentmemory-curation>/);
  assert.match(combined, /<\/agentmemory-graph-context>$/);
});

test("federated recall labels source projects, boosts current-project evidence, and caps monopolies", () => {
  const result = {
    results: [
      ["other-high", "other", 9],
      ["current", "current-project", 7],
      ["other-second", "other", 8],
      ["other-third", "other", 7.5],
      ["third", "third-project", 6],
    ].map(([id, project, score], index) => ({
      project,
      score,
      observation: {
        id,
        title: `memory-${id}`,
        narrative: `relevant evidence ${id}`,
        timestamp: `2026-08-24T00:00:0${index}.000Z`,
      },
    })),
  };
  const context = formatRecallContext("current-project", result);
  assert.match(context, /scope="federated"/);
  assert.match(context, /\[current-project\] memory-current/);
  assert.equal((context.match(/\[other\]/g) ?? []).length, 2);
  assert.doesNotMatch(context, /memory-other-third/);
});

test("MCP shim preserves project, expandIds, and audit operation at the official proxy", async () => {
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ content: [{ type: "text", text: "{\"success\":true}" }] }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const home = mkdtempSync(join(tmpdir(), "agentmemory-mcp-test-"));
  try {
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await callStandalone(baseUrl, "memory_smart_search", {
      query: "needle",
      project: "exact-project",
      expandIds: "obs-one,obs-two",
      limit: 2,
    }, home);
    await callStandalone(baseUrl, "memory_audit", { operation: "observe", limit: 3 }, home);
    assert.deepEqual(calls[0], {
      name: "memory_smart_search",
      arguments: {
        query: "needle",
        project: "exact-project",
        expandIds: "obs-one,obs-two",
        limit: 2,
      },
    });
    assert.deepEqual(calls[1], {
      name: "memory_audit",
      arguments: { operation: "observe", limit: 3 },
    });
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(home, { recursive: true, force: true });
  }
});

test("MCP shim fails closed when the official server is unavailable", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentmemory-mcp-fail-test-"));
  try {
    const response = await callStandalone(
      "http://127.0.0.1:1",
      "memory_recall",
      { query: "needle", project: "exact-project" },
      home,
    );
    assert.equal(response.result?.isError, true);
    assert.match(response.result?.content?.[0]?.text ?? "", /Error:/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("live official MCP enforces project isolation and audit filtering", {
  skip: process.env.AGENTMEMORY_INTEGRATION !== "1",
  timeout: 60_000,
}, async () => {
  const bogusProject = "__agentmemory_nonexistent_project_canary__";
  const leakedRecall = mcpTextJson(await callOfficialMcp("memory_recall", {
    query: "AgentMemory",
    project: bogusProject,
    limit: 20,
    format: "full",
  }));
  assert.equal(leakedRecall.results?.length ?? 0, 0);

  const leakedSmart = mcpTextJson(await callOfficialMcp("memory_smart_search", {
    query: "AgentMemory",
    project: bogusProject,
    limit: 20,
  }));
  assert.equal(leakedSmart.results?.length ?? 0, 0);

  const exactRecall = mcpTextJson(await callOfficialMcp("memory_recall", {
    query: "AgentMemory",
    project: "example-workspace",
    limit: 20,
    format: "full",
  }));
  assert.ok((exactRecall.results?.length ?? 0) > 0);
  const expandable = exactRecall.results.find((result) => result?.observation?.id);
  assert.ok(expandable?.observation?.id, JSON.stringify(exactRecall));

  const expanded = mcpTextJson(await callOfficialMcp("memory_smart_search", {
    query: "unused-for-expansion",
    project: "example-workspace",
    expandIds: expandable.observation.id,
    limit: 1,
  }));
  assert.equal(expanded.mode, "expanded");
  assert.equal(
    expanded.results?.[0]?.obsId,
    expandable.observation.id,
    JSON.stringify(expanded),
  );

  const audit = mcpTextJson(await callOfficialMcp("memory_audit", {
    operation: "observe",
    limit: 20,
  }));
  const entries = Array.isArray(audit) ? audit : audit.entries ?? [];
  assert.ok(entries.length > 0);
  assert.ok(entries.every((entry) => entry.operation === "observe"));
});

test("live official hooks preserve raw turns, exclude internal turns, and catch up cross-session backlog", {
  skip: process.env.AGENTMEMORY_INTEGRATION !== "1",
  timeout: 90_000,
}, async () => {
  const nonce = `agentmemory-e2e-${Date.now()}-${process.pid}`;
  const linkedWorktreeCwd = "D:\\workspaces\\example\\ExampleProject\\work";
  const sourceSession = `${nonce}-source`;
  const nextSession = `${nonce}-next`;
  const internalSession = `${nonce}-internal`;
  const recoveredSession = `${nonce}-recovered`;
  const activitySession = `${nonce}-activity-update`;
  const subagentSession = `${nonce}-subagent`;
  const userToken = `USER_${randomUUID().replaceAll("-", "")}`;
  const secondUserToken = `USER_SECOND_${randomUUID().replaceAll("-", "")}`;
  const assistantToken = `ASSIST_${randomUUID().replaceAll("-", "")}`;
  const internalToken = `INTERNAL_${randomUUID().replaceAll("-", "")}`;
  const recoveredToken = `RECOVERED_${randomUUID().replaceAll("-", "")}`;
  const activityToken = `ACTIVITY_${randomUUID().replaceAll("-", "")}`;
  const descriptiveAssignment = "password=descriptive-not-a-secret-value";
  const sharedPromptPrefix = "same-session-prefix ".repeat(40);
  const userText = `${sharedPromptPrefix}${userToken} 일반 사용자 원문을 그대로 보존하는 테스트입니다.\n${"사용자원문".repeat(120)}  `;
  const assistantText = `${assistantToken} AgentMemory 공식 project 격리의 근본 원인 수정과 실제 MCP 테스트를 완료했고, 검증된 결과를 다음 정상 대화에서 증분 정제해야 합니다. ${"assistant raw text ".repeat(45)}`;

  await callOfficialHook({ hook_event_name: "SessionStart", session_id: sourceSession, cwd: linkedWorktreeCwd });
  await callOfficialHook({
    hook_event_name: "UserPromptSubmit",
    session_id: sourceSession,
    cwd: linkedWorktreeCwd,
    prompt: `${userText}\n${descriptiveAssignment}`,
  });
  const secondUserText = `${sharedPromptPrefix}${secondUserToken} same-session second normal user prompt`;
  await callOfficialHook({
    hook_event_name: "UserPromptSubmit",
    session_id: sourceSession,
    cwd: linkedWorktreeCwd,
    prompt: secondUserText,
  });
  await callOfficialHook({
    hook_event_name: "Stop",
    session_id: sourceSession,
    cwd: linkedWorktreeCwd,
    turn_id: `${nonce}-turn`,
    last_assistant_message: assistantText,
  });
  await callOfficialHook({ hook_event_name: "SessionEnd", session_id: sourceSession, cwd: linkedWorktreeCwd });

  const userRecall = mcpTextJson(await callOfficialMcp("memory_recall", {
    query: userToken,
    project: "example-project",
    limit: 5,
    format: "full",
  }));
  assert.ok(recallObservations(userRecall).some((observation) => observation.narrative === `${userText}\n${descriptiveAssignment}`));
  const secondUserRecall = mcpTextJson(await callOfficialMcp("memory_recall", {
    query: secondUserToken,
    project: "example-project",
    limit: 5,
    format: "full",
  }));
  assert.ok(recallObservations(secondUserRecall)
    .some((observation) => observation.narrative === secondUserText));
  const assistantRecall = mcpTextJson(await callOfficialMcp("memory_recall", {
    query: assistantToken,
    project: "example-project",
    limit: 5,
    format: "full",
  }));
  const assistantObservation = recallObservations(assistantRecall)
    .find((observation) => observation.narrative === assistantText);
  assert.ok(assistantObservation?.id, JSON.stringify(assistantRecall));
  assert.ok(assistantObservation.narrative.length > 400);

  await callOfficialHook({ hook_event_name: "SessionStart", session_id: nextSession, cwd: linkedWorktreeCwd });
  const nextPromptStartedAt = Date.now();
  const nextPromptResult = await callOfficialHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nextSession,
    cwd: linkedWorktreeCwd,
    prompt: `${nonce} 다음 정상 대화`,
  });
  const nextPromptElapsedMs = Date.now() - nextPromptStartedAt;
  assert.ok(nextPromptElapsedMs < 3_500, `UserPromptSubmit hook took ${nextPromptElapsedMs}ms`);
  const additionalContext = nextPromptResult?.hookSpecificOutput?.additionalContext ?? "";
  assert.match(additionalContext, /<agentmemory-curation project="example-project">/);
  assert.match(additionalContext, /"kind":\s*"assistant_result"/);
  const backlogSessionIds = [...additionalContext.matchAll(/"sessionId":\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  assert.ok(backlogSessionIds.length > 0, additionalContext);
  assert.ok(backlogSessionIds.every((sessionId) => sessionId !== nextSession), additionalContext);
  await callOfficialHook({ hook_event_name: "SessionEnd", session_id: nextSession, cwd: linkedWorktreeCwd });

  await callOfficialHook({ hook_event_name: "SessionStart", session_id: internalSession, cwd: linkedWorktreeCwd });
  await callOfficialHook({
    hook_event_name: "UserPromptSubmit",
    session_id: internalSession,
    cwd: linkedWorktreeCwd,
    prompt: `You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt. Return JSON containing ${internalToken}.`,
  });
  await callOfficialHook({
    hook_event_name: "Stop",
    session_id: internalSession,
    cwd: linkedWorktreeCwd,
    last_assistant_message: `{"title":"${internalToken}"}`,
  });
  await callOfficialHook({ hook_event_name: "SessionEnd", session_id: internalSession, cwd: linkedWorktreeCwd });

  const internalRecall = mcpTextJson(await callOfficialMcp("memory_recall", {
    query: internalToken,
    project: "*",
    limit: 20,
    format: "full",
  }));
  assert.equal(internalRecall.results?.length ?? 0, 0);
  const sessions = mcpTextJson(await callOfficialMcp("memory_sessions", {})).sessions ?? [];
  const internal = sessions.find((session) => session.id === internalSession);
  assert.equal(internal, undefined);

  await callOfficialHook({ hook_event_name: "SessionStart", session_id: recoveredSession, cwd: linkedWorktreeCwd });
  await callOfficialHook({
    hook_event_name: "UserPromptSubmit",
    session_id: recoveredSession,
    cwd: linkedWorktreeCwd,
    prompt: `You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt. Return JSON containing ${internalToken}.`,
  });
  await callOfficialHook({
    hook_event_name: "UserPromptSubmit",
    session_id: recoveredSession,
    cwd: linkedWorktreeCwd,
    prompt: `${recoveredToken} 정상 사용자 프롬프트`,
  });
  await callOfficialHook({
    hook_event_name: "Stop",
    session_id: recoveredSession,
    cwd: linkedWorktreeCwd,
    last_assistant_message: `${recoveredToken} 정상 응답`,
  });
  await callOfficialHook({ hook_event_name: "SessionEnd", session_id: recoveredSession, cwd: linkedWorktreeCwd });
  const recoveredRecall = mcpTextJson(await callOfficialMcp("memory_recall", {
    query: recoveredToken,
    project: "example-project",
    limit: 10,
    format: "full",
  }));
  assert.equal(recallObservations(recoveredRecall)
    .filter((observation) => observation.narrative?.includes(recoveredToken)).length, 2);

  await callOfficialHook({ hook_event_name: "SessionStart", session_id: activitySession, cwd: linkedWorktreeCwd });
  await callOfficialHook({
    hook_event_name: "UserPromptSubmit",
    session_id: activitySession,
    cwd: linkedWorktreeCwd,
    prompt: `You write the one-line activity update displayed beneath an existing Codex task title. Fill the structured summary field with one plain-text sentence of at most 280 characters. The task title is already visible; add the latest meaningful detail instead of repeating it. Latest message: ${activityToken}`,
  });
  await callOfficialHook({
    hook_event_name: "Stop",
    session_id: activitySession,
    cwd: linkedWorktreeCwd,
    last_assistant_message: `${activityToken} summary`,
  });
  await callOfficialHook({ hook_event_name: "SessionEnd", session_id: activitySession, cwd: linkedWorktreeCwd });
  const activityRecall = mcpTextJson(await callOfficialMcp("memory_recall", {
    query: activityToken,
    project: "*",
    limit: 20,
    format: "full",
  }));
  assert.equal(activityRecall.results?.length ?? 0, 0);
  const sessionsAfterActivity = mcpTextJson(await callOfficialMcp("memory_sessions", {})).sessions ?? [];
  const activity = sessionsAfterActivity.find((session) => session.id === activitySession);
  assert.equal(activity, undefined);

  await callOfficialHook({
    hook_event_name: "SessionStart",
    session_id: subagentSession,
    cwd: linkedWorktreeCwd,
    agent_id: `${nonce}-child-agent`,
    agent_type: "default",
  });
  await callOfficialHook({
    hook_event_name: "UserPromptSubmit",
    session_id: subagentSession,
    cwd: linkedWorktreeCwd,
    agent_id: `${nonce}-child-agent`,
    agent_type: "default",
    prompt: `${internalToken} subagent-only prompt`,
  });
  await callOfficialHook({
    hook_event_name: "Stop",
    session_id: subagentSession,
    cwd: linkedWorktreeCwd,
    agent_id: `${nonce}-child-agent`,
    agent_type: "default",
    last_assistant_message: `${internalToken} subagent-only response`,
  });
  await callOfficialHook({
    hook_event_name: "SessionEnd",
    session_id: subagentSession,
    cwd: linkedWorktreeCwd,
    agent_id: `${nonce}-child-agent`,
    agent_type: "default",
  });
  const subagentRecall = mcpTextJson(await callOfficialMcp("memory_recall", {
    query: internalToken,
    project: "*",
    limit: 20,
    format: "full",
  }));
  assert.equal(subagentRecall.results?.length ?? 0, 0);
  const sessionsAfterSubagent = mcpTextJson(await callOfficialMcp("memory_sessions", {})).sessions ?? [];
  assert.equal(sessionsAfterSubagent.some((session) => session.id === subagentSession), false);
});

test("current Codex model curates verified observations into official memory, lesson, and graph stores", {
  skip: process.env.AGENTMEMORY_CURATE !== "1",
  timeout: 90_000,
}, async () => {
  const nonce = `agentmemory-curation-${Date.now()}-${process.pid}`;
  const verifiedToken = `VERIFIED_${randomUUID().replaceAll("-", "")}`;
  const cwd = "D:\\workspaces\\example";
  const verifiedSummary = `${verifiedToken} AgentMemoryCodex 실제 0.9.29 런타임 수정과 공식 MCP 검증을 완료했습니다. 존재하지 않는 exact project의 recall과 smart search는 0건이었고, audit operation 필터와 expandIds가 동작했으며, 프록시 미도달은 local KV 성공으로 오판하지 않았습니다. 정상 user/assistant 원문, 내부 Codex prompt 제외, 다음 세션 backlog provenance도 실제 hook canary로 검증했습니다.`;
  const priorVerifiedRecall = mcpTextJson(await callOfficialMcp("memory_recall", {
    query: "VERIFIED AgentMemoryCodex 0.9.29 exact project expandIds",
    project: "example-workspace",
    limit: 100,
    format: "full",
  }));
  let verifiedObservation = recallObservations(priorVerifiedRecall)
    .find((observation) => observation.title === "assistant_response"
      && observation.narrative?.startsWith("VERIFIED_")
      && observation.narrative.includes("AgentMemoryCodex 실제 0.9.29 런타임 수정"));
  if (!verifiedObservation) {
    const newSessionId = `${nonce}-source`;
    await callOfficialHook({ hook_event_name: "SessionStart", session_id: newSessionId, cwd });
    await callOfficialHook({
      hook_event_name: "UserPromptSubmit",
      session_id: newSessionId,
      cwd,
      prompt: `${nonce} verified curation source`,
    });
    await callOfficialHook({
      hook_event_name: "Stop",
      session_id: newSessionId,
      cwd,
      last_assistant_message: verifiedSummary,
    });
    await callOfficialHook({ hook_event_name: "SessionEnd", session_id: newSessionId, cwd });
    const verifiedRecall = mcpTextJson(await callOfficialMcp("memory_recall", {
      query: verifiedToken,
      project: "example-workspace",
      limit: 5,
      format: "full",
    }));
    verifiedObservation = recallObservations(verifiedRecall)
      .find((observation) => observation.narrative === verifiedSummary);
    assert.ok(verifiedObservation?.id, JSON.stringify(verifiedRecall));
  }
  let sessionId = verifiedObservation.sessionId;

  const memoryContent = "AgentMemoryCodex runtime policy: preserve normal user and final assistant text without whole-turn sensitivity rejection; redact only actual secret tokens in the official server, exclude Codex internal ambient/title/fork/subagent turns, keep exact project scoping and official lifecycle/retention/graph, use no external LLM, and fail closed instead of using local fallback.";
  const lessonContent = "When an AgentMemory MCP shim special-cases core tools, validation can silently discard project, expandIds, and audit filters; forward original arguments to the official server, disable local fallback, and verify that a nonexistent project returns zero results and audit entries match the requested operation.";
  const rootSession = "019ff548-a42d-74c0-bf97-9fa1160299c2";
  const rootSourceIds = [
    "obs_mspvtfjw_4cf82d832b91",
    "obs_mspwgibq_c8a7c49e8e36",
    verifiedObservation.id,
  ];

  const memoryBefore = mcpTextJson(await callOfficialMcp("memory_recall", {
    query: "whole-turn sensitivity rejection local fallback",
    project: "example-workspace",
    limit: 100,
    format: "full",
  }));
  let storedMemory = recallObservations(memoryBefore)
    .find((observation) => observation.narrative === memoryContent);
  if (!storedMemory) {
    const memorySave = mcpTextJson(await callOfficialMcp("memory_save", {
      content: memoryContent,
      type: "preference",
      concepts: "AgentMemoryCodex,project isolation,raw conversation,fail closed,noop",
      project: "example-workspace",
      sourceObservationIds: rootSourceIds.join(","),
    }));
    assert.equal(memorySave.success, true);
    assert.equal(memorySave.memory?.project, "example-workspace");
    assert.ok(rootSourceIds.every((id) => memorySave.memory?.sourceObservationIds?.includes(id)));
    storedMemory = { id: memorySave.memory?.id, narrative: memoryContent };
  }

  const lessonBefore = mcpTextJson(await callOfficialMcp("memory_lesson_recall", {
    query: "special-cases core tools project expandIds audit filters",
    project: "example-workspace",
    limit: 10,
  }));
  let storedLesson = lessonBefore.lessons?.find((lesson) => lesson.content === lessonContent);
  if (!storedLesson) {
    const lessonSave = mcpTextJson(await callOfficialMcp("memory_lesson_save", {
      content: lessonContent,
      context: "AgentMemory MCP proxy or shim maintenance",
      confidence: 0.95,
      project: "example-workspace",
      tags: "mcp,project-isolation,fail-closed,regression",
      sourceIds: verifiedObservation.id,
    }));
    assert.equal(lessonSave.success, true);
    storedLesson = lessonSave.lesson;
  } else if (!storedLesson.sourceIds?.includes(verifiedObservation.id)) {
    const canonicalSourceId = storedLesson.sourceIds?.[0];
    const canonicalSource = canonicalSourceId
      ? mcpTextJson(await callOfficialMcp("memory_verify", {
        id: canonicalSourceId,
        project: "example-workspace",
      }))
      : null;
    assert.equal(canonicalSource?.success, true);
    assert.equal(canonicalSource?.type, "observation");
    assert.equal(canonicalSource?.session?.project, "example-workspace");
    verifiedObservation = {
      id: canonicalSourceId,
      sessionId: canonicalSource.observation.sessionId,
    };
    sessionId = verifiedObservation.sessionId;
    rootSourceIds[2] = verifiedObservation.id;
  }
  assert.equal(storedLesson?.project, "example-workspace");
  assert.ok(storedLesson?.sourceIds?.includes(verifiedObservation.id));

  const graphBefore = mcpTextJson(await callOfficialMcp("memory_graph_query", {
    project: "example-workspace",
    query: "AgentMemory Codex: managed lifecycle hooks active",
    limit: 100,
  }));
  const canonicalNode = graphBefore.nodes?.find((node) => node.name === "AgentMemory Codex: managed lifecycle hooks active");
  assert.ok(canonicalNode);
  if (!canonicalNode.sourceObservationIds?.includes(verifiedObservation.id)) {
    const graphSave = mcpTextJson(await callOfficialMcp("memory_graph_upsert", {
      project: "example-workspace",
      sources: [
        { sessionId: rootSession, observationIds: rootSourceIds.slice(0, 2) },
        { sessionId, observationIds: [verifiedObservation.id] },
      ],
      nodes: [{
        key: "managed-lifecycle",
        type: "event",
        name: "AgentMemory Codex: managed lifecycle hooks active",
        properties: {
          status: "confirmed",
          authority: "live-official-mcp-and-hook-canary",
          capture_scope: "Raw normal user and final assistant text; Codex internal ambient/title/fork/subagent turns excluded.",
          curation_scope: "Current Codex app model incrementally curates official observations into project-scoped memory, lesson, and zero-LLM graph stores using source observation provenance.",
          runtime_guards: "Exact project filters, fail-closed MCP proxy, provider noop, provider-backed consolidation and typed LLM graph extraction disabled.",
        },
      }],
      edges: [],
    }));
    assert.equal(graphSave.success, true);
  }

  const memoryAfter = mcpTextJson(await callOfficialMcp("memory_recall", {
    query: "whole-turn sensitivity rejection local fallback",
    project: "example-workspace",
    limit: 100,
    format: "full",
  }));
  storedMemory = recallObservations(memoryAfter)
    .find((observation) => observation.narrative === memoryContent);
  assert.ok(storedMemory?.id, JSON.stringify(memoryAfter));
  const memoryVerification = mcpTextJson(await callOfficialMcp("memory_verify", {
    id: storedMemory.id,
    project: "example-workspace",
  }));
  assert.equal(memoryVerification.success, true);
  assert.equal(memoryVerification.type, "memory");
  assert.ok(rootSourceIds.every((id) => memoryVerification.citations
    ?.some((citation) => citation.observationId === id
      && citation.sessionProject === "example-workspace")));
  const lessonAfter = mcpTextJson(await callOfficialMcp("memory_lesson_recall", {
    query: "special-cases core tools project expandIds audit filters",
    project: "example-workspace",
    limit: 10,
  }));
  assert.ok(lessonAfter.lessons?.some((lesson) => lesson.content === lessonContent
    && lesson.sourceIds?.includes(verifiedObservation.id)));
  const graphAfter = mcpTextJson(await callOfficialMcp("memory_graph_query", {
    project: "example-workspace",
    query: "AgentMemory Codex: managed lifecycle hooks active",
    limit: 100,
  }));
  const updatedNode = graphAfter.nodes?.find((node) => node.name === "AgentMemory Codex: managed lifecycle hooks active");
  assert.ok(updatedNode?.sourceObservationIds?.includes(verifiedObservation.id));

  const supersessionSave = mcpTextJson(await callOfficialMcp("memory_save", {
    content: memoryContent,
    type: "preference",
    concepts: "AgentMemoryCodex,project isolation,raw conversation,fail closed,noop",
    project: "example-workspace",
    sourceObservationIds: verifiedObservation.id,
  }));
  assert.equal(supersessionSave.success, true);
  assert.equal(supersessionSave.memory?.parentId, storedMemory.id);
  assert.ok(rootSourceIds.every((id) => supersessionSave.memory?.sourceObservationIds?.includes(id)));
  const handledAfterSupersession = collectHandledObservationIds(
    [supersessionSave.memory],
    [],
    { nodes: [], edges: [] },
  );
  assert.ok(rootSourceIds.every((id) => handledAfterSupersession.has(id)));
  const supersessionVerification = mcpTextJson(await callOfficialMcp("memory_verify", {
    id: supersessionSave.memory.id,
    project: "example-workspace",
  }));
  assert.ok(rootSourceIds.every((id) => supersessionVerification.citations
    ?.some((citation) => citation.observationId === id
      && citation.sessionProject === "example-workspace")));

  await new Promise((resolveWait) => setTimeout(resolveWait, 750));
  const graphAfterSupersession = mcpTextJson(await callOfficialMcp("memory_graph_query", {
    project: "example-workspace",
    query: "AgentMemory Codex: managed lifecycle hooks active",
    limit: 100,
  }));
  assert.ok(graphAfterSupersession.nodes
    ?.some((node) => node.name === "AgentMemory Codex: managed lifecycle hooks active"));
  const graphRefresh = mcpTextJson(await callOfficialMcp("memory_graph_upsert", {
    project: "example-workspace",
    sources: [
      { sessionId: rootSession, observationIds: rootSourceIds.slice(0, 2) },
      { sessionId, observationIds: [verifiedObservation.id] },
    ],
    nodes: [{
      key: "managed-lifecycle",
      type: "event",
      name: "AgentMemory Codex: managed lifecycle hooks active",
      properties: { status: "confirmed" },
    }],
    edges: [],
  }));
  assert.equal(graphRefresh.success, true);
  const graphAfterRefresh = mcpTextJson(await callOfficialMcp("memory_graph_query", {
    project: "example-workspace",
    query: "AgentMemory Codex: managed lifecycle hooks active",
    limit: 100,
  }));
  assert.ok(graphAfterRefresh.nodes
    ?.some((node) => node.name === "AgentMemory Codex: managed lifecycle hooks active"
      && rootSourceIds.every((id) => node.sourceObservationIds?.includes(id))));

  const linkedWorktreeEvidenceContent = "AgentMemoryCodex linked-worktree hook canary verified that D:\\workspaces\\example\\ExampleProject\\work resolves to the exact example-project project, preserves normal user and final assistant text beyond 400 characters, exposes prior-session observations to the next normal turn for bounded curation catch-up, and excludes Codex internal ambient, title, fork, and subagent turns.";
  const exampleSourcesRecall = mcpTextJson(await callOfficialMcp("memory_recall", {
    query: "ASSIST AgentMemory project 격리 근본 원인 증분 정제",
    project: "example-project",
    limit: 100,
    format: "full",
  }));
  const exampleSourceObservations = recallObservations(exampleSourcesRecall)
    .filter((observation) => observation.title === "assistant_response"
      && observation.sessionId?.startsWith("agentmemory-e2e-")
      && observation.narrative?.startsWith("ASSIST_"));
  assert.ok(exampleSourceObservations.length > 0, JSON.stringify(exampleSourcesRecall));
  const exampleSourceIds = [...new Set([
    "obs_mspxp7le_6e77e211d266",
    "obs_mspxp88r_e4e814b26c3a",
    ...exampleSourceObservations.map((observation) => observation.id),
  ])];
  const exampleMemoryBefore = mcpTextJson(await callOfficialMcp("memory_recall", {
    query: "linked-worktree hook canary bounded curation catch-up",
    project: "example-project",
    limit: 100,
    format: "full",
  }));
  let exampleMemory = recallObservations(exampleMemoryBefore)
    .find((observation) => observation.narrative === linkedWorktreeEvidenceContent);
  let exampleVerification = exampleMemory
    ? mcpTextJson(await callOfficialMcp("memory_verify", {
      id: exampleMemory.id,
      project: "example-project",
    }))
    : null;
  const verifiedExampleIds = new Set(exampleVerification?.citations
    ?.filter((citation) => citation.sessionProject === "example-project")
    .map((citation) => citation.observationId) ?? []);
  if (!exampleMemory || exampleSourceIds.some((id) => !verifiedExampleIds.has(id))) {
    const exampleMemorySave = mcpTextJson(await callOfficialMcp("memory_save", {
      content: linkedWorktreeEvidenceContent,
      type: "workflow",
      concepts: "AgentMemoryCodex,linked worktree,raw conversation,curation catch-up,subagent exclusion",
      project: "example-project",
      sourceObservationIds: exampleSourceIds.join(","),
    }));
    assert.equal(exampleMemorySave.success, true);
    exampleMemory = { id: exampleMemorySave.memory?.id, narrative: linkedWorktreeEvidenceContent };
    exampleVerification = mcpTextJson(await callOfficialMcp("memory_verify", {
      id: exampleMemory.id,
      project: "example-project",
    }));
  }
  assert.equal(exampleVerification?.success, true);
  assert.equal(exampleVerification?.type, "memory");
  assert.ok(exampleSourceIds.every((id) => exampleVerification.citations
    ?.some((citation) => citation.observationId === id
      && citation.sessionProject === "example-project")));
});
