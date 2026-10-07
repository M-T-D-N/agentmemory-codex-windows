import { describe, it, expect } from "vitest";
import {
  CompressOutputSchema,
  SummaryOutputSchema,
} from "../src/eval/schemas.js";
import { validateInput, validateOutput } from "../src/eval/validator.js";
import {
  scoreCompression,
  scoreSummary,
} from "../src/eval/quality.js";

describe("Zod Schemas", () => {
  describe("CompressOutputSchema", () => {
    it("accepts valid output", () => {
      const result = CompressOutputSchema.safeParse({
        type: "file_edit",
        title: "Edit auth module",
        facts: ["Added JWT validation"],
        narrative: "Modified the auth middleware to validate tokens",
        concepts: ["auth"],
        files: ["src/auth.ts"],
        importance: 7,
      });
      expect(result.success).toBe(true);
    });

    it("rejects empty facts array", () => {
      const result = CompressOutputSchema.safeParse({
        type: "file_edit",
        title: "Edit auth module",
        facts: [],
        narrative: "Modified the auth middleware to validate tokens",
        concepts: [],
        files: [],
        importance: 5,
      });
      expect(result.success).toBe(false);
    });

    it("rejects title over 120 chars", () => {
      const result = CompressOutputSchema.safeParse({
        type: "file_edit",
        title: "x".repeat(121),
        facts: ["fact"],
        narrative: "A narrative that is long enough",
        concepts: [],
        files: [],
        importance: 5,
      });
      expect(result.success).toBe(false);
    });

    it("rejects importance outside 1-10", () => {
      const result = CompressOutputSchema.safeParse({
        type: "file_edit",
        title: "Test",
        facts: ["fact"],
        narrative: "A valid narrative here",
        concepts: [],
        files: [],
        importance: 11,
      });
      expect(result.success).toBe(false);
    });

    it("rejects narrative under 10 chars", () => {
      const result = CompressOutputSchema.safeParse({
        type: "file_edit",
        title: "Test",
        facts: ["fact"],
        narrative: "short",
        concepts: [],
        files: [],
        importance: 5,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("SummaryOutputSchema", () => {
    it("accepts valid summary", () => {
      const result = SummaryOutputSchema.safeParse({
        title: "Session Summary",
        narrative: "This session focused on implementing authentication features and fixing bugs",
        keyDecisions: ["Use JWT"],
        filesModified: ["auth.ts"],
        concepts: ["auth"],
      });
      expect(result.success).toBe(true);
    });

    it("rejects short narrative", () => {
      const result = SummaryOutputSchema.safeParse({
        title: "Summary",
        narrative: "Too short",
        keyDecisions: [],
        filesModified: [],
        concepts: [],
      });
      expect(result.success).toBe(false);
    });
  });
});

describe("Validator", () => {
  it("returns valid with correct data", () => {
    const result = validateInput(CompressOutputSchema, {
      type: "file_edit",
      title: "Test",
      facts: ["a"],
      narrative: "A long enough narrative",
      concepts: [],
      files: [],
      importance: 5,
    }, "compress");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.title).toBe("Test");
    }
  });

  it("returns invalid with error details", () => {
    const result = validateInput(CompressOutputSchema, { title: "" }, "compress");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.result.functionId).toBe("compress");
      expect(result.result.errors.length).toBeGreaterThan(0);
    }
  });

  it("validateOutput works same as validateInput", () => {
    const result = validateOutput(
      CompressOutputSchema,
      {
        type: "file_edit",
        title: "Test",
        facts: ["a"],
        narrative: "A long enough narrative",
        concepts: [],
        files: [],
        importance: 5,
      },
      "compress",
    );
    expect(result.valid).toBe(true);
  });
});

describe("Quality Scoring", () => {
  describe("scoreCompression", () => {
    it("returns 0 for empty object", () => {
      expect(scoreCompression({})).toBe(0);
    });

    it("returns 100 for perfect observation", () => {
      const score = scoreCompression({
        type: "file_edit",
        title: "A good title",
        facts: ["fact 1", "fact 2", "fact 3"],
        narrative: "A narrative that is definitely more than fifty characters long and provides good context",
        concepts: ["auth", "jwt"],
        importance: 7,
      });
      expect(score).toBe(100);
    });

    it("scores partial observations between 0 and 100", () => {
      const score = scoreCompression({
        title: "Test",
        facts: ["one"],
        narrative: "Short but valid narrative",
      });
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(100);
    });
  });

  describe("scoreSummary", () => {
    it("returns 0 for empty object", () => {
      expect(scoreSummary({})).toBe(0);
    });

    it("returns high score for complete summary", () => {
      const score = scoreSummary({
        title: "Session Summary Title",
        narrative:
          "This is a detailed narrative about what happened during the session with enough content to be meaningful and complete for review purposes",
        keyDecisions: ["Used JWT for auth", "Chose PostgreSQL"],
        filesModified: ["src/auth.ts", "src/db.ts"],
        concepts: ["authentication", "database"],
      });
      expect(score).toBeGreaterThanOrEqual(90);
    });
  });
});
