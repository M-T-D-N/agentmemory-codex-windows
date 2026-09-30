import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatRecallContext, recallRequestText, recallQuery, recallBypass, recallForTurn, retrievalPrompt, reuseRecall, boundedAdditionalContext, turnRecallContext } from "../hooks/codex-turn.mjs";
import { parseRecallTranscript, readRecallTranscript, recallPlanContext, promptDigest } from "../hooks/codex-recall-evidence.mjs";

const source = { obsId: "original-user", sessionId: "old-session", project: "billing", observation: {
  id: "original-user", title: "prompt_submit", narrative: "Keep invoice rounding exact until the final total.",
} };
const priorRequest = "invoice rounding 정책을 검토해";
const query = "invoice rounding";
const transcriptRow = (payload) => JSON.stringify({ type: "response_item", payload });
const messageRow = (role, text) => transcriptRow({ type: "message", role, content: [{ type: "input_text", text }] });
const expandedRow = (entry = source) => transcriptRow({ type: "custom_tool_call_output", output: JSON.stringify({
  content: [{type: "text", text: JSON.stringify({ mode: "expanded", results: [entry], truncated: false })}],
}) });
const priorRows = () => [messageRow("user", priorRequest),
  messageRow("developer", recallPlanContext("billing", query, priorRequest)), expandedRow()];

test("same-topic continuation validates expanded sources once without searching or repeating their body", async () => {
  const original = globalThis.fetch, calls = [];
  const transcript = parseRecallTranscript([...priorRows(), messageRow("user", "진행")], text => text);
  globalThis.fetch = async (url, options) => {
    calls.push([String(url), JSON.parse(options.body)]);
    return new Response(JSON.stringify({mode: "expanded", results: [source], truncated: false}));
  };
  try {
    const topic = await retrievalPrompt("진행", "billing", "session", transcript);
    assert.equal(topic, query);
    const result = await reuseRecall("진행", topic, "billing", transcript);
    assert.equal(result.status, "reused");
    assert.match(result.context, /original-user/);
    assert.doesNotMatch(result.context, /Keep invoice rounding/);
    assert.equal(calls.length, 1);
    assert.ok(calls[0][0].endsWith("/smart-search"));
    assert.equal(calls[0][1].trackAccess, false);
    assert.deepEqual(calls[0][1].expandIds, [{obsId: "original-user", sessionId: "old-session"}]);
  } finally { globalThis.fetch = original; }
});

test("changed, archived, unavailable or partial originals cannot qualify as validated reuse", async () => {
  const original = globalThis.fetch;
  const transcript = parseRecallTranscript(priorRows(), text => text);
  try {
    for (const results of [[], [{...source, observation: {...source.observation, narrative: "A revised policy."}}]]) {
      globalThis.fetch = async () => new Response(JSON.stringify({mode: "expanded", results, truncated: false}));
      assert.equal(await reuseRecall("진행", query, "billing", transcript), null);
    }
    globalThis.fetch = async () => new Response(JSON.stringify({mode: "expanded", results: [source], truncated: true}));
    assert.equal(await reuseRecall("진행", query, "billing", transcript), null);
    globalThis.fetch = async () => { throw Error("offline"); };
    assert.equal(await reuseRecall("진행", query, "billing", transcript), null);
  } finally { globalThis.fetch = original; }
});

test("new topics, current-state questions and user corrections always require fresh evidence", async () => {
  const original = globalThis.fetch;
  const transcript = parseRecallTranscript(priorRows(), text => text);
  globalThis.fetch = async () => { throw Error("must not attempt reuse"); };
  try {
    for (const prompt of ["canvas labels 정책", "이번 수정의 현재 상태", "그 방안 대신 행별 반올림으로 바꿔", "이번 수정에 세금계산서 기능 추가", "진행\n새로운 회계 규칙으로 변경"]) {
      assert.equal(await reuseRecall(prompt, query, "billing", transcript), null);
    }
    const revised = await retrievalPrompt("그 방안 대신 행별 반올림으로 바꿔", "billing", "session", transcript);
    assert.match(revised, /invoice rounding/);
    assert.match(revised, /행별 반올림/);
    assert.equal(await retrievalPrompt("canvas labels 정책", "billing", "session", transcript), "canvas labels 정책");
    assert.equal(await reuseRecall("진행", query, "different-project", transcript), null);
    assert.equal(await reuseRecall("진행", query, "billing", {...transcript, plan: {...transcript.plan, promptDigest: promptDigest("wrong prompt")}}), null);
  } finally { globalThis.fetch = original; }
});

test("quoted user data, snippets and compaction never count as retained originals", () => {
  assert.equal(parseRecallTranscript([messageRow("user", expandedRow())], text => text).sources.length, 0);
  assert.equal(parseRecallTranscript([transcriptRow({type: "custom_tool_call_output", output: JSON.stringify({mode:"compact", results:[source]})})], text => text).sources.length, 0);
  for (const marker of [{type:"compacted"}, {type:"response_item",payload:{type:"compaction"}},
    {type:"event_msg",payload:{type:"context_compacted"}}, {type:"event_msg",payload:{item:{type:"ContextCompaction"}}}]) {
    const state = parseRecallTranscript([...priorRows(), JSON.stringify(marker)], text => text);
    assert.deepEqual(state, {users: [], sources: [], plan: null});
  }
  const changedPlan = messageRow("developer", recallPlanContext("billing", "canvas labels", "new task"));
  assert.equal(parseRecallTranscript([...priorRows(), changedPlan], text => text).sources.length, 0);
});

test("transcript read is bounded and confined to the active canonical session", () => {
  const root = mkdtempSync(join(tmpdir(), "recall-transcript-"));
  const before = process.env.AGENTMEMORY_CODEX_SOURCE_ROOT;
  process.env.AGENTMEMORY_CODEX_SOURCE_ROOT = root;
  try {
    const file = join(root, "active.jsonl");
    const header = JSON.stringify({type: "session_meta",payload:{session_id:"session", base_instructions:"x".repeat(5000)}});
    writeFileSync(file, [header, ...priorRows()].join("\n"));
    const event = {transcript_path:file,session_id:"session"};
    assert.equal(readRecallTranscript(event, text => text).sources.length, 1);
    assert.equal(readRecallTranscript({...event, session_id:"wrong"}, text => text).sources.length, 0);
    writeFileSync(file, [header, ...priorRows(), "x".repeat(1024 * 1024 + 1), messageRow("user","진행")].join("\n"));
    assert.equal(readRecallTranscript(event, text => text).sources.length, 0);
    process.env.AGENTMEMORY_CODEX_SOURCE_ROOT = join(root, "absent");
    assert.equal(readRecallTranscript(event, text => text).sources.length, 0);
  } finally {
    before === undefined ? delete process.env.AGENTMEMORY_CODEX_SOURCE_ROOT : process.env.AGENTMEMORY_CODEX_SOURCE_ROOT = before;
    rmSync(root, {recursive:true,force:true});
  }
});

test("required recall context survives optional graph and curation budget pressure", () => {
  const recall = "r".repeat(2400);
  assert.equal(boundedAdditionalContext("c".repeat(8000), recall, "g".repeat(8000)), recall);
});

test("identifier queries keep latest corrections and fresh plans invalidate earlier source eligibility", async () => {
  const oldQuery = "invoice.policy";
  const changed = "이번 수정은 총합 대신 행별 반올림으로 바꿔";
  const rows = [messageRow("user", oldQuery), messageRow("developer", recallPlanContext("billing", oldQuery, oldQuery)), expandedRow()];
  const transcript = parseRecallTranscript(rows, text => text);
  const nextQuery = recallQuery(await retrievalPrompt(changed, "billing", "session", transcript));
  assert.match(nextQuery, /invoice.policy/);
  assert.match(nextQuery, /행별 반올림/);
  const newPlan = messageRow("developer", recallPlanContext("billing", oldQuery, changed));
  assert.equal(parseRecallTranscript([...rows, messageRow("user",changed), newPlan], text => text).sources.length, 0);
});

test("oversized or escape-heavy plans abstain without truncating task identity or losing status", () => {
  for (const long of ["invoice "+"x".repeat(420), "invoice "+"<>".repeat(146)]) {
    const tag = recallPlanContext("billing", long, long);
    const state = parseRecallTranscript([messageRow("developer",tag)], text => text);
    assert.equal(state.plan, null);
    assert.ok(tag.length < 400);
    const recall = turnRecallContext({status:"candidates",context:"r".repeat(1150)},"billing","turn",long,long);
    const combined = boundedAdditionalContext("c".repeat(1000),recall,"g".repeat(500));
    assert.ok(combined.length <= 7600);
    assert.match(combined,/status="candidates"/);
  }
});

test("an incomplete plan falls back to actual user text including intervening corrections", async () => {
  const correction = "이번 수정은 총합 대신 행별 반올림으로 바꿔 " + "설명 ".repeat(200);
  const rows = [messageRow("user", "invoice.policy"), messageRow("user", correction),
    messageRow("developer", recallPlanContext("billing", correction, correction)), messageRow("user", "진행")];
  const text = await retrievalPrompt("진행", "billing", "session", parseRecallTranscript(rows, value => value));
  assert.match(text, /invoice.policy/);
  assert.match(text, /행별 반올림/);
});

test("a relevant local original still performs bounded user history discovery", async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body); calls.push([String(url), body]);
    return new Response(JSON.stringify(body.expandIds ? {mode: "expanded", results: [source], truncated: false}
      : {format: "compact", results: [{project: "billing", obsId: source.obsId, sessionId: source.sessionId, title: "prompt_submit", sourceKind: "user"}], truncated: false}));
  };
  try {
    assert.equal((await recallForTurn("invoice rounding", "billing")).status, "candidates");
    assert.deepEqual(calls.filter(([url]) => url.endsWith("/search")).map(([, body]) => body.project), ["billing", "*", "*"]);
    assert.deepEqual(calls.at(-1)[1].expandIds, [{obsId: source.obsId, sessionId: source.sessionId}]);
  } finally { globalThis.fetch = original; }
});

test("optional history failure is partial recall, not total unavailability", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.project === "*") throw Error("optional history offline");
    return new Response(JSON.stringify(body.expandIds ? {mode: "expanded", results: [source], truncated: false}
      : {format: "compact", results: [{project: "billing", obsId: source.obsId, sessionId: source.sessionId, title: "prompt_submit", sourceKind: "user"}], truncated: false}));
  };
  try {
    const result = await recallForTurn("invoice rounding", "billing");
    assert.equal(result.status, "partial");
    assert.match(result.context, /original-user/);
  } finally { globalThis.fetch = original; }
});

test("scope-only followups keep the concrete user subject and intervening corrections", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw Error("transcript context should avoid fallback reads"); };
  const chain = [
    "내가 욕하기 시작하는 순간을 에이전트메모리로 확인하고 사용자가 왜 그러는건지 생각",
    "모든순간을 전부다 나열하고 분석 진행",
    "과거의 문제에서 도출한 내용을 토대로 뭘 어떻게 수정해야할까?",
    "권장안은?",
    "현재 에이전트메모리 현황을 기반으로 재분석",
    "권장안대로 골을 설정하고 작업 진행",
  ];
  try {
    for (let index = 1; index < chain.length; index++) {
      const prior = chain[index - 1];
      const degradedPlan = messageRow("developer", recallPlanContext("billing", prior, prior));
      const transcript = parseRecallTranscript([
        ...chain.slice(0, index).map(prompt => messageRow("user", prompt)),
        degradedPlan,
      ], text => text);
      const effective = await retrievalPrompt(chain[index], "billing", "session", transcript);
      assert.match(effective, /욕하기/, chain[index]);
      assert.match(effective, /사용자/, chain[index]);
      if (index >= 3) assert.match(effective, /과거의 문제에서 도출한/, chain[index]);
      if (index >= 4) assert.match(effective, /현재 에이전트메모리 현황을 기반으로 재분석/, chain[index]);
    }
    for (const prompt of ["추천안은?", "현재 현황을 기반으로 재분석해줘", "모든 순간을 나열해줘"]) {
      const onlyTopic = parseRecallTranscript([messageRow("user", chain[0])], text => text);
      const effective = await retrievalPrompt(prompt, "billing", "session", onlyTopic);
      assert.match(effective, /욕하기/, prompt);
    }
    const contaminatedPlan = parseRecallTranscript([
      messageRow("user", chain[0]),
      messageRow("user", "권장안은?"),
      messageRow("developer", recallPlanContext("billing",
        "에이전트메모리 게임 GPU 욕하기 설정", "권장안은?")),
    ], text => text);
    const cleanQuery = await retrievalPrompt("현재 현황을 기반으로 재분석해줘", "billing", "session", contaminatedPlan);
    assert.match(cleanQuery, /사용자가 왜 그러는건지/);
    assert.doesNotMatch(cleanQuery, /게임 GPU/);
    const corrected = parseRecallTranscript([
      messageRow("user", "invoice rounding 정책을 검토해"),
      messageRow("user", "이번 수정은 총합 대신 행별 반올림으로 바꿔"),
      messageRow("user", "이번 수정은 세금 항목을 제외해"),
      messageRow("developer", recallPlanContext("billing", "권장안은?", "이번 수정은 세금 항목을 제외해")),
    ], text => text);
    const query = await retrievalPrompt("권장안은?", "billing", "session", corrected);
    assert.match(query, /invoice rounding/);
    assert.match(query, /행별 반올림/);
    assert.match(query, /세금 항목/);
  } finally { globalThis.fetch = original; }
});

test("canonical fallback ignores host events and stored current-prompt whitespace", async () => {
  const original = globalThis.fetch;
  const prior = [
    "내가 욕하기 시작하는 순간을 에이전트메모리로 확인하고 사용자가 왜 그러는건지 생각",
    "모든순간을 전부다 나열하고 분석 진행",
    "과거의 문제에서 도출한 내용을 토대로 뭘 어떻게 수정해야할까?",
    "권장안은?",
    "현재 에이전트메모리 현황을 기반으로 재분석",
  ];
  const current = "권장안대로 골을 설정하고 작업 진행";
  const host = '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>';
  const prompts = [...prior, host, current + "\n"];
  const observations = prompts.map((narrative, index) => ({
    id: "prompt-" + index, sessionId: "session", project: "billing", title: "prompt_submit",
    narrative, timestamp: new Date(Date.parse("2026-09-27T00:00:00Z") + index * 1000).toISOString(),
  }));
  for (let index = 0; index < 4; index++) observations.push({
    id: "assistant-" + index, sessionId: "session", project: "billing", title: "assistant_response",
    narrative: "status", timestamp: new Date(Date.parse("2026-09-26T00:00:00Z") + index * 1000).toISOString(),
  });
  globalThis.fetch = async () => new Response(JSON.stringify({ total: 11, observations }));
  try {
    const query = await retrievalPrompt(current, "billing", "session", { users: [], plan: null });
    assert.match(query, /욕하기/);
    assert.match(query, /과거의 문제에서 도출한/);
    assert.match(query, /현재 에이전트메모리 현황을 기반으로 재분석/);
    assert.doesNotMatch(query, /external_codex_apps_open_page/);
    assert.equal(query.split(current).length - 1, 1);
  } finally { globalThis.fetch = original; }
});
test("new concrete topics stay independent and missing history preserves the current request", async () => {
  const original = globalThis.fetch;
  const transcript = parseRecallTranscript([messageRow("user", "invoice rounding 정책을 검토해")], text => text);
  globalThis.fetch = async () => { throw Error("offline"); };
  try {
    for (const prompt of ["canvas labels 정책", "새 프로젝트 결제 오류 현황 분석", "Qwen GPU 메모리 사용량 분석"])
      assert.equal(await retrievalPrompt(prompt, "billing", "session", transcript), prompt);
    for (const prompt of ["권장안은?", "현재 에이전트메모리 현황을 기반으로 재분석"])
      assert.equal(await retrievalPrompt(prompt, "billing", "session", {users: [], plan: null}), prompt);
  } finally { globalThis.fetch = original; }
});

test("deictic followups inherit the real subject despite incidental topic words", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({total: 1, observations: [{
    id: "prior", sessionId: "session", project: "billing", title: "prompt_submit",
    narrative: "invoice rounding 정책을 수정해", timestamp: "2026-09-27",
  }]}));
  try {
    assert.match(await retrievalPrompt("이번 수정에 대해서 반론을 진행해봐", "billing", "session"), /invoice rounding/);
  } finally { globalThis.fetch = original; }
});

test("first-turn projectless questions retrieve source-labelled prior results across projects", async () => {
  const original = globalThis.fetch, calls = [];
  const entry = {project:"previous-project", obsId:"old-deployment", sessionId:"old-session", observation: {
    id:"old-deployment", title:"assistant_response", timestamp:"2026-08-01", narrative:"Deployed https://preview.tenant-maple-427.example.test successfully."}};
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return new Response(JSON.stringify(body.expandIds ? {mode:"expanded", results:[entry], truncated:false}
      : {format:"compact", results:body.project === "*" && !body.sourceKind ? [{...entry, observation:undefined}] : [], truncated:false}));
  };
  try {
    const result = await recallForTurn("site 도구가 왜 tenant-maple-427 값을 반환하지? 넣은 적 없는데", "new-chat");
    assert.equal(result.status, "candidates");
    assert.match(result.context, /previous-project.*old-deployment.*derived:/s);
    assert.match(result.context, /Current user request wins/);
    assert.equal(calls.filter(call=>!call.expandIds).length, 4);
    assert.ok(calls.filter(call=>!call.expandIds).every(call=>call.query.includes("tenant-maple-427") && call.trackAccess === false));
    assert.ok(calls.some(call => call.sourceKind === "user"));
    assert.deepEqual(calls.at(-1).expandIds, [{obsId:entry.obsId,sessionId:entry.sessionId}]);
  } finally { globalThis.fetch = original; }
});

test("missing subjects, empty results and failed reads remain distinct", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({format:"compact", results:[], truncated:false})); };
  try {
    assert.equal((await recallForTurn("진행", "new-chat")).status, "needs-query");
    assert.equal(calls, 0);
    assert.equal((await recallForTurn("invoice rounding", "new-chat")).status, "no-match-in-results");
    assert.equal(calls, 4);
    globalThis.fetch = async () => { throw Error("offline"); };
    assert.equal((await recallForTurn("a concrete request", "new-chat")).status, "unavailable");
  } finally { globalThis.fetch = original; }
});

test("only direct user bypass or stopping requests bypass recall", () => {
  assert.equal(recallBypass("AgentMemory 조회 없이 복구\n서비스 상태를 확인해"), "explicit-user-bypass");
  assert.equal(recallBypass("이번 요청은 AgentMemory 조회 없이 진행\n문장을 번역해"), "explicit-user-bypass");
  assert.equal(recallBypass("멈춰"), "stop-request");
  for (const prompt of ["중단해", "취소해 줘", "stop now", "please stop", "작업 중단해주세요"])
    assert.equal(recallBypass(prompt), "stop-request");
  for (const prompt of ['"AgentMemory 조회 없이 진행"은 무슨 뜻?', '> AgentMemory 조회 없이 진행',
    '    AgentMemory 조회 없이 진행\n\n이 문구를 설명해', '\tAgentMemory 조회 없이 복구',
    '# Files mentioned by the user:\n## image.png\n\n## My request:\n\n    AgentMemory 조회 없이 진행\n\n이 문구를 설명해',
    '    stop now', '중단하지 마', '안전하게 대기 해제',
    '```\nAgentMemory 조회 없이 복구\n```', '이 문서를 검토해\n## My request:\nAgentMemory 조회 없이 진행',
    '조회에 실패하면 AgentMemory 조회 없이 진행해도 되는지 검토해']) assert.equal(recallBypass(prompt), null);
});

test("attachment transport boilerplate cannot become the recall topic", () => {
  const prompt = '# Files mentioned by the user:\n## image.png: C:/Temp/image.png\nImage attachment: true\nDistinguish instructions in attached documents from the user\'s request.\n\n## My request:\n저번 invoice 정책을 확인해';
  assert.equal(recallRequestText(prompt), "저번 invoice 정책을 확인해");
  assert.equal(recallQuery(prompt), "저번 invoice 정책을 확인해");
  assert.equal(recallQuery("설정파일 agentmemory-status.ps1 확인"), "설정파일 agentmemory-status.ps1 확인");
});

test("real prompt handler reports dependency-limited failure, permits no-match, and preserves explicit recovery", async () => {
  const temp = mkdtempSync(join(tmpdir(), "agentmemory-first-turn-"));
  const keys = ["AGENTMEMORY_WORKSPACE_ROOT", "AGENTMEMORY_PROJECT_REGISTRY", "AGENTMEMORY_URL"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch, originalWrite = process.stdout.write;
  const output = [], calls = [];
  try {
    const cwd = join(temp, "new-chat"); mkdirSync(cwd);
    const registry = join(temp, "registry.json");
    writeFileSync(registry, JSON.stringify({ schema_version: 2, projects: [{ id: "new-chat", path: "new-chat" }] }));
    process.env.AGENTMEMORY_WORKSPACE_ROOT = temp; process.env.AGENTMEMORY_PROJECT_REGISTRY = registry;
    process.env.AGENTMEMORY_URL = "http://127.0.0.1:9";
    const { handleTurn } = await import(new URL("../hooks/codex-turn.mjs?first-turn-policy-test", import.meta.url).href);
    let offline = true;
    globalThis.fetch = async (url, options) => {
      calls.push(String(url));
      if (offline) throw Error("fixture offline");
      return new Response(JSON.stringify(String(url).endsWith("/search") ? { format: "compact", results: [], truncated: false }
        : String(url).endsWith("/observe") ? { observationId: "fixture-capture" }
        : String(url).includes("/graph/stats") ? { totalNodes: 30_000, totalEdges: 50_000 }
        : { nodes: [], edges: [], truncated: false, sessions: [], total: 0, memories: [], lessons: [] }));
    };
    process.stdout.write = value => { output.push(String(value)); return true; };
    const event = { session_id: "new-first-turn", turn_id: "first-turn", cwd, prompt: "service identifier 설명해" };
    await handleTurn(event, "UserPromptSubmit");
    const failure = JSON.parse(output.join(""));
    assert.equal(failure.decision, undefined);
    assert.match(failure.hookSpecificOutput.additionalContext, /status="unavailable"/);
    assert.match(failure.hookSpecificOutput.additionalContext, /history-dependent claims/);
    assert.equal(calls.some(url => url.endsWith("/observe")), true);
    output.length = calls.length = 0; offline = false;
    await handleTurn(event, "UserPromptSubmit");
    const normal = JSON.parse(output.join(""));
    assert.equal(normal.decision, undefined);
    assert.match(normal.hookSpecificOutput.additionalContext, /status="no-match-in-results"/);
    assert.match(normal.hookSpecificOutput.additionalContext, /turn_id="first-turn"/);
    assert.ok(calls.findIndex(url => url.endsWith("/search")) < calls.findIndex(url => url.endsWith("/observe")));
    output.length = calls.length = 0; offline = true;
    await handleTurn({ ...event, prompt: "AgentMemory 조회 없이 복구\n연결 상태를 확인해" }, "UserPromptSubmit");
    const recovery = JSON.parse(output.join(""));
    assert.equal(recovery.decision, undefined);
    assert.match(recovery.hookSpecificOutput.additionalContext, /status="bypassed"/);
    assert.equal(calls.some(url => url.endsWith("/search")), false);
  } finally {
    globalThis.fetch = originalFetch; process.stdout.write = originalWrite;
    for (const key of keys) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
    rmSync(temp, { recursive: true, force: true });
  }
});


test("short continuation keeps latest user GitHub and Qwen holds while a new topic stays independent", async () => {
  const original=globalThis.fetch;globalThis.fetch=async()=>{throw Error("transcript subject should avoid state fallback");};
  try {
    const users=["AgentMemory invoice rounding recall 정책을 구현해", "이번 수정은 GitHub 업로드와 Qwen 시작을 하지 마. 로컬 검증만 진행해."];
    const transcript={users,sources:[],plan:null};
    const topic=await retrievalPrompt("진행","billing","session",transcript);
    assert.match(topic,/invoice rounding/);assert.match(topic,/GitHub 업로드와 Qwen 시작을 하지 마/);assert.match(topic,/로컬 검증만/);
    const next=await retrievalPrompt("canvas labels 디자인을 확인해","billing","session",transcript);
    assert.equal(next,"canvas labels 디자인을 확인해");assert.doesNotMatch(next,/GitHub|Qwen|invoice/);
    const changed=await retrievalPrompt("이번 수정은 행별 반올림으로 바꿔","billing","session",transcript);
    assert.match(changed,/행별 반올림/);assert.match(changed,/하지 마/);
  } finally {globalThis.fetch=original;}
});


test("full wrapper, plan, adaptive recall and optional context remain below the host ceiling", () => {
  const results=Array.from({length:8},(_,i)=>({project:"billing",sessionId:"session",score:1,observation:{id:`original-${i}`,title:"prompt_submit",timestamp:`2026-09-${10+i}`,narrative:"Invoice rounding must remain exact. " + "Do not upload or start Qwen. ".repeat(90)}}));
  const request="invoice rounding " + "<>".repeat(800);
  const context=formatRecallContext(request,"billing",{results});
  const wrapped=turnRecallContext({status:"candidates",context},"billing","turn-id",request,request);
  const combined=boundedAdditionalContext("c".repeat(1146),wrapped,"g".repeat(500));
  assert.match(context,/token_ceiling="2048"/);
  assert.match(context,/needs-expansion/);
  assert.match(combined,/agentmemory-turn-recall/);
  assert.match(combined,/agentmemory-recall-plan/);
  assert.ok(combined.length<=7600);
  assert.ok(combined.includes(context));
});


test("demonstrative follow-ups locate the preceding final while preserving the latest user correction", async () => {
  const rows=[messageRow("user","과거 회상 알고리즘 개선"),transcriptRow({type:"message",role:"assistant",phase:"final_answer",
    content:[{type:"output_text",text:"두 잔여 기록: Exa mention 수집 중단과 Qwen ECONNREFUSED 보류 집계."}]}),messageRow("user","해당기록들 문제 발본색원")];
  const transcript=parseRecallTranscript(rows,text=>text);
  const query=await retrievalPrompt("해당기록들 문제 발본색원","memory","session",transcript);
  assert.match(query,/Exa mention/);assert.match(query,/Qwen ECONNREFUSED/);assert.match(query,/해당기록들 문제 발본색원/);
  const corrected=await retrievalPrompt("해당 기록 중 Qwen은 그대로 두고 파서만 수정","memory","session",parseRecallTranscript(rows.slice(0,-1),text=>text));
  assert.match(corrected,/Qwen은 그대로 두고 파서만 수정/);
  assert.equal(await reuseRecall("해당기록들 문제 발본색원",query,"memory",transcript),null);
  assert.equal(await retrievalPrompt("이더리움 가격 조사","memory","session",transcript),"이더리움 가격 조사");
  assert.equal(await retrievalPrompt("invoice rounding 정책","billing","session",transcript),"invoice rounding 정책");
});
test("commentary, old answers and compacted answers cannot define a follow-up referent", async () => {
  const final=transcriptRow({type:"message",role:"assistant",phase:"final",content:[{type:"output_text",text:"OLD_ASSISTANT_ONLY"}]});
  const rows=[messageRow("user","invoice rounding"),final,messageRow("user","canvas labels"),messageRow("user","해당기록들 확인")];
  const stale=await retrievalPrompt("해당기록들 확인","billing","session",parseRecallTranscript(rows,text=>text));
  assert.doesNotMatch(stale,/OLD_ASSISTANT_ONLY/);assert.match(stale,/canvas labels/);
  assert.equal(parseRecallTranscript([messageRow("user","invoice"),final,JSON.stringify({type:"compacted"})],text=>text).referent,undefined);
  assert.equal(parseRecallTranscript([messageRow("user","invoice"),final.replace('"final"','"commentary"')],text=>text).referent,undefined);
});

test("subjectless implementation requests use the report topic rather than matching generic commands elsewhere", async () => {
  const prior="해당기록들 문제 발본색원";
  const rows=[messageRow("user",prior),transcriptRow({type:"message",role:"assistant",phase:"final",content:[{type:"output_text",text:"Exa mention parser and Qwen background hold must be fixed."}]})];
  const transcript=parseRecallTranscript(rows,text=>text);
  for(const prompt of ["적절한 구현방안을 선정하고 작업진행","진행"]) {
    const query=await retrievalPrompt(prompt,"memory","session",transcript);
    assert.match(query,/Exa mention/);assert.match(query,/Qwen background hold/);assert.ok(query.startsWith(prompt));
  }
  assert.equal(await retrievalPrompt("신규 결제 모듈을 구현","memory","session",transcript),"신규 결제 모듈을 구현");
});
