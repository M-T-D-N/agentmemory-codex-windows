import { createHash } from "node:crypto";
import { stripPrivateData } from "../functions/privacy.js";

// Exact ordered stripPrivateData rules from 455854b1^; recovery comparison only.
const rules: ReadonlyArray<readonly [RegExp, string]> = [
  [/<private>[\s\S]*?<\/private>/gi, "[REDACTED]"],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, "[REDACTED_SECRET]"],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:"'<>]*:[^\s/?#@"'<>]+@/gi, "$1[REDACTED_SECRET]@"],
  [/Bearer\s+[A-Za-z0-9._\-+/=]{20,}/gi, "[REDACTED_SECRET]"],
  [/sk-proj-[A-Za-z0-9\-_]{20,}/g, "[REDACTED_SECRET]"],
  [/(?:sk|pk|rk|ak)-[A-Za-z0-9][A-Za-z0-9\-_]{19,}/g, "[REDACTED_SECRET]"],
  [/sk-ant-[A-Za-z0-9\-_]{20,}/g, "[REDACTED_SECRET]"],
  [/gh[pus]_[A-Za-z0-9]{36,}/g, "[REDACTED_SECRET]"],
  [/github_pat_[A-Za-z0-9_]{22,}/g, "[REDACTED_SECRET]"],
  [/xoxb-[A-Za-z0-9\-]+/g, "[REDACTED_SECRET]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED_SECRET]"],
  [/AIza[A-Za-z0-9\-_]{35}/g, "[REDACTED_SECRET]"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_SECRET]"],
  [/npm_[A-Za-z0-9]{36}/g, "[REDACTED_SECRET]"],
  [/glpat-[A-Za-z0-9\-_]{20,}/g, "[REDACTED_SECRET]"],
  [/dop_v1_[A-Za-z0-9]{64}/g, "[REDACTED_SECRET]"],
];
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const HISTORICAL_PRIVACY_VERSION = "before-455854b1";
export const HISTORICAL_PRIVACY_RULES_DIGEST = digest(JSON.stringify(rules.map(([pattern, replacement]) =>
  [pattern.source, pattern.flags, replacement])));
export interface HistoricalPrivacyDigest {
  version: typeof HISTORICAL_PRIVACY_VERSION;
  rulesDigest: string;
  textDigest: string;
  currentTextDigest: string;
}

export function historicalPrivacyDigest(parts: string[], currentText: string): HistoricalPrivacyDigest | undefined {
  const historical = parts.map(part => rules.reduce((text, [pattern, replacement]) =>
    text.replace(new RegExp(pattern.source, pattern.flags), replacement), part)).join("\n");
  if (historical === currentText || stripPrivateData(historical) !== historical) return;
  const boundaryOnly = rules.slice(4, 7).reduce((text, [pattern, replacement]) =>
    text.replace(new RegExp(pattern.source, pattern.flags), replacement), currentText);
  if (boundaryOnly !== historical) return;
  return { version: HISTORICAL_PRIVACY_VERSION, rulesDigest: HISTORICAL_PRIVACY_RULES_DIGEST,
    textDigest: digest(historical), currentTextDigest: digest(currentText) };
}
