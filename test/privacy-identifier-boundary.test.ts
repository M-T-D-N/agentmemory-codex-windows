import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripPrivateData } from "../src/functions/privacy.js";

const keys = ["sk-", "pk-", "rk-", "ak-", "sk-proj-", "sk-ant-"].map(p => p + "1234567890abcdefghijklmnopqrstuv");
const capture = readFileSync(new URL("../plugin/scripts/_capture.mjs", import.meta.url), "utf8");
const privacyRegion = capture.split("//#region src/functions/privacy.ts\n")[1]?.split("//#endregion")[0];
describe("secret key identifier boundaries", () => {
  it("keeps the shipped capture scrubber equivalent to the server", () => {
    expect(privacyRegion).toBeTruthy();
    const scrubCapture = new Function(`${privacyRegion}; return stripPrivateData;`)() as typeof stripPrivateData;
    const samples = ["task-runner-that-does-something-long", "bookmark-this-long-reference-identifier", ...keys,
      ...keys.flatMap(key => ["한" + key, "_" + key, "\u0301" + key, "😀" + key, "/" + key]),
      "https://user:pass@example.test", "<private>hidden</private>",
      "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----"];
    for (const sample of samples) expect(scrubCapture(sample)).toBe(stripPrivateData(sample));
  });
  it.each(["task-runner-that-does-something-long", "bookmark-this-long-reference-identifier"])("preserves %s", text => {
    expect(stripPrivateData(text)).toBe(text);
  });
  it.each(["a", "7", "_", "한", "漢", "\u0301"])("preserves identifier prefix %s", prefix => {
    for (const key of keys) expect(stripPrivateData(prefix + key)).toBe(prefix + key);
  });
  it.each(["", "\"", "'", "/", "(", " ", "😀"])("masks separate keys after %s", prefix => {
    for (const key of keys) expect(stripPrivateData(prefix + key)).toBe(prefix + "[REDACTED_SECRET]");
  });
  it("preserves adjacent ordinary identifiers and remains idempotent", () => {
    const text = keys[0] + " task-runner-that-does-something-long " + keys[1];
    const expected = "[REDACTED_SECRET] task-runner-that-does-something-long [REDACTED_SECRET]";
    expect(stripPrivateData(text)).toBe(expected);
    expect(stripPrivateData(stripPrivateData(text))).toBe(expected);
  });
});
