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
      '# Response annotations:\ninternal response metadata',
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

  it("keeps title-only observations when no ambient content was removed", () => {
    const titleOnly = observation("");

    expect(sanitizeCodexAmbientObservation(titleOnly)).toBe(titleOnly);
  });
});
