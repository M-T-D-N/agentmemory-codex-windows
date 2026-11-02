/** Import-safe metadata helpers. Importing this module never starts a worker.
 * File access occurs only when readCodexSourceIdentity is explicitly called.
 * The package root and hashed runtime chunks are executable worker internals.
 */
export {
  canonicalCodexCwd,
  parseCodexSourceIdentity,
  readCodexSourceIdentity,
  type CodexSourceIdentity,
} from "./functions/codex-source-identity.js";
