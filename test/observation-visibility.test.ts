import { describe, expect, it } from "vitest";
import {
  isCodexInternalAmbientText,
  isExcludedCodexAmbientSession,
  sanitizeCodexAmbientObservation,
} from "../src/functions/observation-visibility.js";
import type { CompressedObservation, Session } from "../src/types.js";

function observation(narrative: string): CompressedObservation {
  return {
    id: "obs_visibility",
    sessionId: "ses_visibility",
    timestamp: "2026-08-12T00:00:00Z",
    type: "conversation",
    title: "prompt_submit",
    facts: [],
    narrative,
    concepts: [],
    files: [],
    importance: 5,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_visibility",
    project: "project-a",
    cwd: "/project-a",
    startedAt: "2026-08-12T00:00:00Z",
    status: "active",
    observationCount: 1,
    ...overrides,
  };
}

it("preserves complete human JSON containing evaluator instructions", () => {
  const text = JSON.stringify({ instructions: "You are an independent reasoning-effort evaluator, not the task executor." });
  expect(isCodexInternalAmbientText(text)).toBe(false);
  expect(sanitizeCodexAmbientObservation(observation(text))?.narrative).toBe(text);
});

it("recognizes the observed older effort protocol while preserving schema mismatches and quoted requests", () => {
  const supportedEfforts = ["medium", "high", "xhigh", "max"];
  const payload = {
    instructions: "You are an independent reasoning-effort evaluator, not the task executor. Return only the supplied JSON schema.",
    question: "Which supported effort is sufficient for the NEXT generation? Judge remaining reasoning, not vocabulary.",
    state: { model: "synthetic-model", supportedEfforts, originalTask: "synthetic task", latestUserPrompt: "Continue", publicEvidence: [] },
    outputSchema: { type: "object", additionalProperties: false, properties: {
      action: { type: "string", enum: ["recommend", "abstain"] },
      effort: { anyOf: [{ type: "string", enum: supportedEfforts }, { type: "null" }] },
      reason: { type: "string" },
    }, required: ["action", "effort", "reason"] },
  };
  const raw = JSON.stringify(payload);
  expect(isCodexInternalAmbientText(raw)).toBe(true);
  expect(sanitizeCodexAmbientObservation(observation(raw))).toBeNull();
  const reordered = { outputSchema: { required: ["reason", "action", "effort"], properties: {
    reason: { type: "string" }, effort: { anyOf: [{ type: "null" }, { enum: [...supportedEfforts].reverse(), type: "string" }] },
    action: { enum: ["abstain", "recommend"], type: "string" },
  }, additionalProperties: false, type: "object" }, state: { ...payload.state, supportedEfforts: [...supportedEfforts].reverse() },
  question: payload.question, instructions: payload.instructions };
  expect(isCodexInternalAmbientText(JSON.stringify(reordered))).toBe(true);
  for (const normal of [
    JSON.stringify({ instructions: payload.instructions }),
    JSON.stringify({ ...payload, outputSchema: { ...payload.outputSchema, additionalProperties: true } }),
    JSON.stringify({ ...payload, outputSchema: { ...payload.outputSchema, properties: {
      ...payload.outputSchema.properties, effort: { anyOf: [{ type: "string", enum: ["medium"] }, { type: "null" }] },
    } } }),
    "다음 JSON 요청 형식을 검토해줘\n" + raw,
  ]) expect(sanitizeCodexAmbientObservation(observation(normal))?.narrative).toBe(normal);
});

it("preserves a normal request after the response-annotations heading", () => {
  const text = "# Response annotations:\nPlease update the parser and preserve my identifiers.";
  expect(isCodexInternalAmbientText(text)).toBe(false);
  expect(sanitizeCodexAmbientObservation(observation(text))?.narrative).toBe(text);
});

describe("Codex observation visibility", () => {
  it("recognizes title, fork, activity-update, suggestion, and compliance prompt families", () => {
    expect(
      isCodexInternalAmbientText(
        "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.",
      ),
    ).toBe(true);
    expect(
      isCodexInternalAmbientText(
        "You are a helpful assistant. You will be presented with the most recent messages in an existing conversation. Your job is to generate a short title for the conversation.",
      ),
    ).toBe(true);
    expect(
      isCodexInternalAmbientText(
        "You are in a fork of an existing Codex thread. Fill the structured description field with a compact, search-oriented summary",
      ),
    ).toBe(true);
    expect(
      isCodexInternalAmbientText(
        "You write the one-line activity update displayed beneath an existing Codex task title. Fill the structured summary field with one plain-text sentence of at most 280 characters. The task title is already visible; add the latest meaningful detail instead of repeating it.",
      ),
    ).toBe(true);
    expect(
      isCodexInternalAmbientText(
        "# Overview\nGenerate a hyperpersonalized suggestion for the ambient UI",
      ),
    ).toBe(true);
    expect(
      isCodexInternalAmbientText(
        "You are an expert at upholding safety and compliance standards for Codex ambient suggestions",
      ),
    ).toBe(true);
  });

  it("recognizes structured Codex host payloads that may use the user role", () => {
    const internalPayloads = [
      '<subagent_notification>{"status":"completed"}</subagent_notification>',
      '<in-app-browser-context>{"active":true}</in-app-browser-context>',
      '<hook_prompt>internal hook payload</hook_prompt>',
      '<recommended_plugins><plugin>internal</plugin></recommended_plugins>',
      '<app-context>host application context</app-context>',
      '<skills_instructions>host skill routing</skills_instructions>',
      '<permissions instructions>host sandbox policy</permissions instructions>',
      '<turn_aborted>host interruption marker</turn_aborted>',
      '# AGENTS.md instructions for D:\\workspaces\\example',
      '# Response annotations:',
      '# Response annotations:\n<environment_context>host metadata</environment_context>',
    ];

    for (const payload of internalPayloads) {
      expect(isCodexInternalAmbientText(payload)).toBe(true);
      expect(sanitizeCodexAmbientObservation(observation(payload))).toBeNull();
    }
  });

  it("excludes explicitly marked and recognizable internal sessions", () => {
    expect(
      isExcludedCodexAmbientSession(
        session({ captureExcluded: true, firstPrompt: "ordinary" }),
      ),
    ).toBe(true);
    expect(
      isExcludedCodexAmbientSession(
        session({
          firstPrompt:
            "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.",
        }),
      ),
    ).toBe(true);
    expect(
      isExcludedCodexAmbientSession(
        session({
          firstPrompt:
            "You write the one-line activity update displayed beneath an existing Codex task title. Fill the structured summary field with one plain-text sentence of at most 280 characters. The task title is already visible; add the latest meaningful detail instead of repeating it.".slice(0, 200),
        }),
      ),
    ).toBe(true);
    expect(
      isCodexInternalAmbientText(
        "# Overview\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex.",
      ),
    ).toBe(true);
    expect(
      isExcludedCodexAmbientSession(session({ firstPrompt: "normal user" })),
    ).toBe(false);
  });

  it("removes only ambient UI blocks from otherwise normal user text", () => {
    const result = sanitizeCodexAmbientObservation(
      observation(
        '<context source="ambient-ui-state">internal state</context>Keep this user request',
      ),
    );
    expect(result?.narrative).toBe("Keep this user request");
    expect(
      sanitizeCodexAmbientObservation(
        observation('<context source="ambient-ui-state">only state</context>'),
      ),
    ).toBeNull();
  });

  it("classifies the remaining request after removing complete marked UI context", () => {
    const request = "## My request:\nKeep my existing identifiers\n";
    for (const block of ['<in-app-browser-context source="ambient-ui-state">state</in-app-browser-context>',
      '<context source="ambient-ui-state">state</context>', '<agentmemory-ambient-ui-state>state</agentmemory-ambient-ui-state>']) {
      const mixed = "\n" + block + "\n\n" + request;
      expect(isCodexInternalAmbientText(mixed)).toBe(false);
      expect(isExcludedCodexAmbientSession(session({ firstPrompt: mixed }))).toBe(false);
      expect(sanitizeCodexAmbientObservation(observation(mixed))?.narrative).toBe("\n" + request);
      expect(isCodexInternalAmbientText(block)).toBe(true);
      expect(sanitizeCodexAmbientObservation(observation(block))).toBeNull();
      expect(isCodexInternalAmbientText(block + '<heartbeat>internal</heartbeat>')).toBe(true);
    }
    expect(isCodexInternalAmbientText('<in-app-browser-context source="ambient-ui-state">unclosed request')).toBe(true);
    expect(isCodexInternalAmbientText('<in-app-browser-context>unmarked</in-app-browser-context>request')).toBe(false);
  });

  it("preserves literal ambient markup in code and quotations on stored observation reads", () => {
    const block = '<agentmemory-ambient-ui-state source="ambient-ui-state">user example</agentmemory-ambient-ui-state>';
    for (const text of ['```xml\n' + block + '\n```', '`' + block + '`', '> ' + block, '    ' + block]) {
      const original = observation(text);
      expect(sanitizeCodexAmbientObservation(original)?.narrative).toBe(text);
      expect(original.narrative).toBe(text);
    }
    expect(sanitizeCodexAmbientObservation(observation(block + 'Keep my request'))?.narrative).toBe('Keep my request');
  });

  it("keeps title-only observations when no ambient content was removed", () => {
    const titleOnly = observation("");

    expect(sanitizeCodexAmbientObservation(titleOnly)).toBe(titleOnly);
  });
});

 it("hides legacy approval and pure page events while preserving mixed human and assistant markup", () => {
   for (const text of ["The following is the Codex agent history whose request action you are assessing. request", "The following is the Codex agent history added since your last approval assessment. request", '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>', "<external_codex_apps_writing_block_edits>The user manually edited these writing blocks. Treat the following snapshots as the current versions of those blocks, superseding the earlier assistant output.\n[]</external_codex_apps_writing_block_edits>"]) {
     const raw = observation(text); expect(sanitizeCodexAmbientObservation(raw)).toBeNull(); expect(raw.narrative).toBe(text);
   }
   const emptyEdit = "<external_codex_apps_writing_block_edits>The user manually edited these writing blocks. Treat the following snapshots as the current versions of those blocks, superseding the earlier assistant output.\n[]</external_codex_apps_writing_block_edits>";
   for (const text of [emptyEdit.replace("[]", '[{"text":"Actual user edit"}]'), emptyEdit + "\nKeep my request"]) expect(sanitizeCodexAmbientObservation(observation(text))?.narrative).toBe(text);
   for (const text of ['# AGENTS.md instructions for project\n문서를 수정해줘', '<environment_context>example</environment_context> explanation', '<in-app-browser-context>example</in-app-browser-context>Keep normal request']) expect(sanitizeCodexAmbientObservation(observation(text))?.narrative).toBe(text);
   expect(isCodexInternalAmbientText('# AGENTS.md instructions for project\n<INSTRUCTIONS>host</INSTRUCTIONS>\n<environment_context>host</environment_context>')).toBe(true);
 });

 it("recognizes native effort evaluation payloads and their stored first-prompt prefix without hiding ordinary JSON", () => {
   const payload = { instructions: "You are an independent reasoning-effort evaluator, not the task executor. Return only the supplied JSON schema.",
     question: "Which reasoning effort is sufficient for the NEXT generation of state.model?",
     state: { coverage: { source: "native DecisionContext + local projectEvidence" } } };
   const raw = JSON.stringify(payload);
   expect(isCodexInternalAmbientText(raw)).toBe(true);
   expect(isExcludedCodexAmbientSession(session({ firstPrompt: raw.slice(0, 200) }))).toBe(true);
   expect(sanitizeCodexAmbientObservation(observation(raw))).toBeNull();
   expect(isCodexInternalAmbientText(JSON.stringify({state: payload.state, question: payload.question, instructions: payload.instructions}))).toBe(true);
   for (const normal of [JSON.stringify({ instructions: "Run my requested task", state: payload.state }),
     "다음 JSON 요청 형식을 검토해줘\n" + raw, JSON.stringify({ quote: payload.instructions }),
     JSON.stringify({ instructions: "You are an independent editor, not the task executor." })]) {
     expect(sanitizeCodexAmbientObservation(observation(normal))?.narrative).toBe(normal);
   }
 });

it("uses native normal-user evidence before excluding truncated session previews", () => {
  const evaluator = JSON.stringify({ instructions: "You are an independent reasoning-effort evaluator, not the task executor. " + "Return only the supplied JSON schema. ".repeat(5),
    question: "Which reasoning effort is sufficient for the NEXT generation of state.model?",
    state: { coverage: { source: "native DecisionContext + local projectEvidence" } } });
  const ambient = '<in-app-browser-context source="ambient-ui-state">' + "x".repeat(500) + '</in-app-browser-context>Keep normal request';
  const native = { cursor: { parser: { normalUserSeen: true } } };
  for (const firstPrompt of [evaluator.slice(0, 200), ambient.slice(0, 200)]) {
    expect(isExcludedCodexAmbientSession({ firstPrompt })).toBe(true);
    expect(isExcludedCodexAmbientSession({ firstPrompt, codexNativeCapture: native })).toBe(false);
    expect(isExcludedCodexAmbientSession({ firstPrompt, codexNativeCapture: native, captureExcluded: true })).toBe(true);
  }
  expect(isCodexInternalAmbientText(ambient)).toBe(false);
  expect(isExcludedCodexAmbientSession({ firstPrompt: "# Response annotations:" })).toBe(false);
  expect(isExcludedCodexAmbientSession({ firstPrompt: "You are in a fork of an existing Codex thread. Fill the structured description field with a compact, search-oriented summary", codexNativeCapture: native })).toBe(true);
});

it("does not apply legacy preview fallback to a complete 200-character human JSON", () => {
  const instructions = "You are an independent reasoning-effort evaluator, not the task executor.";
  const base = JSON.stringify({ instructions, padding: "" });
  const text = JSON.stringify({ instructions, padding: "x".repeat(200 - base.length) });
  expect(text).toHaveLength(200);
  expect(isExcludedCodexAmbientSession({ firstPrompt: text })).toBe(false);
  expect(isCodexInternalAmbientText(text)).toBe(false);
});
