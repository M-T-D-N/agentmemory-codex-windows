import { scopeDirective } from "./codex-recall-scope.mjs";
import { openSync, closeSync, readSync, fstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const MAX_SOURCES = 4;

export function evidenceDigest(entry) {
  const o = entry.observation;
  return createHash("sha256").update(JSON.stringify([
    entry.project, entry.obsId, entry.sessionId, o?.title, o?.narrative, o?.codexSource?.kind,
  ])).digest("hex");
}

function messageText(payload) {
  return typeof payload.content === "string" ? payload.content
    : Array.isArray(payload.content) ? payload.content.filter(part => ["input_text", "output_text", "text"].includes(part.type))
      .map(part => part.text ?? "").join("\n") : "";
}

function expandedRecords(value, depth = 0) {
  if (depth > 7 || !value) return [];
  if (typeof value === "string") {
    try { return expandedRecords(JSON.parse(value), depth + 1); } catch { return []; }
  }
  if (Array.isArray(value)) return value.flatMap(item => expandedRecords(item, depth + 1));
  if (typeof value !== "object") return [];
  if (value.mode === "expanded" && value.truncated !== true && Array.isArray(value.results)) {
    return value.results.filter(entry => typeof entry.obsId === "string" && entry.obsId.length <= 512
      && typeof entry.project === "string" && entry.project.length <= 200
      && typeof entry.sessionId === "string" && entry.observation?.id === entry.obsId
      && typeof entry.observation.narrative === "string" && entry.observation.narrative.trim());
  }
  return ["content", "text", "output", "structuredContent"].flatMap(key => expandedRecords(value[key], depth + 1));
}

export function parseRecallTranscript(lines, normalPrompt) {
  let users = [], sources = [], plan = null, referent, scopeMode, scopeProject, lastUserAnswered = false;
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const payload = row.payload ?? {};
    const itemType = payload.item?.type;
    if (row.type === "compacted" || payload.type === "compaction" || payload.type === "context_compacted"
      || itemType === "ContextCompaction") {
      users = []; sources = []; plan = null; referent = undefined; lastUserAnswered = false;
      continue;
    }
    if (row.type !== "response_item") continue;
    if (payload.type === "message" && payload.role === "user") {
      const text = normalPrompt(messageText(payload));
      if (text) { users.push(text); scopeMode = scopeDirective(text) ?? scopeMode; lastUserAnswered = false; }
      users = users.slice(-12);
    } else if (payload.type === "message" && payload.role === "assistant" && ["final", "final_answer"].includes(payload.phase)) {
      const text = messageText(payload).trim();
      if (text && users.at(-1)) {
        referent = { text: text.slice(0, 1536), userDigest: promptDigest(users.at(-1)) };
        lastUserAnswered = true;
      }
    } else if (payload.type === "message" && payload.role === "developer") {
      const match = /<agentmemory-recall-plan>([^]*?)<\/agentmemory-recall-plan>/u.exec(messageText(payload));
      if (match) {
        try {
          const parsed = JSON.parse(match[1]);
          if (parsed.version === 1 && parsed.scopeMode === "current" && typeof parsed.scopeProject === "string") scopeProject = parsed.scopeProject;
          if (parsed.version === 1 && typeof parsed.project === "string" && typeof parsed.query === "string"
            && typeof parsed.promptDigest === "string" && parsed.complete === true) {
            if (!parsed.retainSources || plan?.project !== parsed.project || plan?.query !== parsed.query) sources = [];
            plan = parsed;
          } else { plan = null; sources = []; }
        } catch { plan = null; sources = []; }
      }
    } else if (["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
      for (const entry of expandedRecords(payload.output)) {
        const source = { ...entry, digest: evidenceDigest(entry) };
        sources = [...sources.filter(other => other.obsId !== entry.obsId || other.project !== entry.project), source].slice(-MAX_SOURCES);
      }
    }
  }
  return { users, sources, plan, ...(scopeMode ? {scopeMode} : {}), ...(scopeProject ? {scopeProject} : {}), ...(lastUserAnswered ? { lastUserAnswered } : {}), ...(referent ? { referent } : {}) };
}

export const MAX_NATIVE_METADATA_BYTES = 2 * 1024 * 1024;

function sourceBoundaryFailure(reason) {
  return Object.assign(new Error("Managed Codex hook source boundary is unverified (" + reason + "); no memory request was sent"),
    { code: "AGENTMEMORY_SOURCE_BOUNDARY", reason });
}

function readFirstNativeMetadata(fd) {
  const bytes = Buffer.alloc(MAX_NATIVE_METADATA_BYTES);
  let count = 0;
  while (count < bytes.length) {
    const read = readSync(fd, bytes, count, Math.min(64 * 1024, bytes.length - count), count);
    if (read === 0) throw sourceBoundaryFailure("metadata_incomplete");
    const end = bytes.indexOf(10, count);
    count += read;
    if (end < 0 || end >= count) continue;
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end)));
    } catch { throw sourceBoundaryFailure("metadata_invalid"); }
  }
  throw sourceBoundaryFailure("metadata_limit");
}

export function assertManagedHookSource(event, environment = process.env, managed = false) {
  const sourceRoot = environment.AGENTMEMORY_CODEX_SOURCE_ROOT;
  if (!sourceRoot && !managed) return;
  if (!sourceRoot) throw sourceBoundaryFailure("source_root_missing");
  const path = event.transcript_path ?? event.transcriptPath;
  const sessionId = event.session_id ?? event.sessionId;
  const canonical = value => process.platform === "win32" ? value.toLowerCase() : value;
  let fd;
  try {
    if (!isAbsolute(sourceRoot) || typeof path !== "string" || !isAbsolute(path)
        || typeof sessionId !== "string" || !sessionId.trim()) throw sourceBoundaryFailure("source_identity_missing");
    const root = realpathSync.native(sourceRoot);
    if (environment.CODEX_HOME && (!isAbsolute(environment.CODEX_HOME)
        || canonical(realpathSync.native(environment.CODEX_HOME)) !== canonical(root))) throw sourceBoundaryFailure("codex_home_mismatch");
    const file = realpathSync.native(path);
    if (!canonical(file).startsWith(canonical(root + sep))) throw sourceBoundaryFailure("source_outside_root");
    fd = openSync(file, "r");
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) throw sourceBoundaryFailure("source_not_file");
    const verifyPath = () => {
      const current = statSync(path, { bigint: true });
      if (canonical(realpathSync.native(sourceRoot)) !== canonical(root) || canonical(realpathSync.native(path)) !== canonical(file)
          || current.dev !== opened.dev || current.ino !== opened.ino) throw sourceBoundaryFailure("source_path_changed");
    };
    verifyPath();
    const record = readFirstNativeMetadata(fd);
    const payload = record?.payload;
    if (!record || Array.isArray(record) || record.type !== "session_meta" || !payload || Array.isArray(payload)
        || typeof payload !== "object" || payload.id !== sessionId
        || (Object.hasOwn(payload, "session_id") && payload.session_id !== sessionId)) throw sourceBoundaryFailure("metadata_identity_mismatch");
    verifyPath();
  } catch (error) {
    if (error?.code === "AGENTMEMORY_SOURCE_BOUNDARY") throw error;
    throw sourceBoundaryFailure("source_unavailable");
  } finally { if (fd !== undefined) closeSync(fd); }
}


export function readRecallTranscript(event, normalPrompt) {
  const empty = { users: [], sources: [], plan: null };
  const path = event.transcript_path ?? event.transcriptPath;
  const sessionId = event.session_id ?? event.sessionId;
  const sourceRoot = process.env.AGENTMEMORY_CODEX_SOURCE_ROOT;
  if (typeof path !== "string" || typeof sessionId !== "string" || !sourceRoot) return empty;
  let fd;
  try {
    const root = realpathSync.native(resolve(sourceRoot));
    const file = realpathSync.native(resolve(path));
    if (!file.toLowerCase().startsWith((root + sep).toLowerCase())) return empty;
    fd = openSync(file, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) return empty;
    const record = readFirstNativeMetadata(fd);
    if (record?.type !== "session_meta" || record.payload?.id !== sessionId
        || (Object.hasOwn(record.payload, "session_id") && record.payload.session_id !== sessionId)) return empty;
    const start = Math.max(0, stat.size - MAX_TRANSCRIPT_BYTES);
    const bytes = Buffer.alloc(stat.size - start);
    const read = readSync(fd, bytes, 0, bytes.length, start);
    const lines = bytes.subarray(0, read).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return parseRecallTranscript(lines, normalPrompt);
  } catch { return empty; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function promptDigest(text) {
  return createHash("sha256").update(String(text).trim()).digest("hex");
}

export function recallPlanContext(project, query, prompt, retainSources = false, scope) {
  const encode = value => JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  // A truncated query cannot define task identity. Fall back to actual user text.
  const complete = typeof query === "string" && !!query.trim() && encode(query).length <= 400 && encode(project).length <= 200;
  const value = encode({ version: 1, project: complete ? project : "", query: complete ? query : "",
    promptDigest: promptDigest(prompt), complete, retainSources: complete && retainSources,
    ...(scope?.mode === "current" && scope.project === project ? { scopeMode: "current", scopeProject: project } : {}) });
  return `<agentmemory-recall-plan>${value}</agentmemory-recall-plan>`;
}
