// Only user-authored scope directives can reopen federation.
export function scopeRequestText(value) {
  let text = String(value ?? "");
  const envelope = /^\s*<send_user_message_question_reply>\s*([^]*?)\s*<\/send_user_message_question_reply>\s*$/u.exec(text);
  if (envelope) {
    try { text = JSON.parse(envelope[1]).map(row => String(row.answer ?? "")).join("\n"); }
    catch { return ""; }
  }
  return text.replace(/<([a-z][\w-]*)\b[^>]*>[^]*?<\/\1>/giu, " ")
    .replace(/(?:^|\n)\s*(?:\x60{3}|~{3})[^]*?(?:\n\s*(?:\x60{3}|~{3})[^\n]*(?:\n|$)|$)/gu, " ")
    .replace(/^\s*>.*$/gmu, " ")
    .replace(/\x60[^\x60]*\x60|"[^"]*"|“[^”]*”|‘[^’]*’|(?<!\w)'[^'\n]*'(?!\w)/gu, " ")
    .replace(/\*\*|__/gu, "").trim();
}

const CURRENT_ONLY = /(?:(?:현재|이|해당)\s*프로젝트(?:에서|내에서|내|안에서|로|에)?만|(?:current|this)\s+project\s+only|only\s+(?:the\s+)?(?:current|this)\s+project|(?:현재|이|해당)\s*프로젝트(?:로|에)\s*(?:한정|제한)|(?:limit|restrict)\s+(?:\w+\s+){0,3}to\s+(?:the\s+)?(?:current|this)\s+project)/iu;
const CROSS_PROJECT = /(?:(?:다른|타|외부|모든|전체)\s*프로젝트|(?:all|every|other)\s+projects?|outside\s+(?:the\s+)?(?:current|this)\s+project)/iu;
const NEGATIVE = /(?:하지\s*(?:마|말|않)|하지마|금지|제외|안\s*(?:검색|조회)|(?:do|must|should|can)\s+not|don['’]t|never|exclude|without|no\s+(?:other|cross))/iu;
const ALL_PROJECTS = /(?:(?:모든|전체)\s*프로젝트|all\s+projects|every\s+project)/iu;
const SEARCH_ACTION = /(?:검색|조회|찾아|search|recall|look\s*up|include|across|reopen)/iu;

export function scopeDirective(value) {
  const text = scopeRequestText(value);
  const clauses = text.split(/[.;!?\n]/u);
  // A contradiction within one request stays narrow; a later user request may reopen it.
  if (CURRENT_ONLY.test(text) || clauses.some(part => CROSS_PROJECT.test(part) && NEGATIVE.test(part))) return "current";
  const reopen = /(?:모든|전체)\s*프로젝트[^.!?\n]{0,120}(?:검색|조회)(?:해|해줘|해주세요|하세요|하라|해봐|하자)[.!?。\s]*$/u.test(text)
    || text.split(/[.;:!?\n]/u).some(part => /^\s*(?:please\s+)?(?:search|recall|look\s+up|include|reopen)\b[^.!?\n]*\b(?:all\s+projects|every\s+project)\b/iu.test(part));
  if (ALL_PROJECTS.test(text) && (reopen || scopeOnlyWords(text))) return "all";
  if (CROSS_PROJECT.test(text) && SEARCH_ACTION.test(text)) return "current";
  return null;
}

function scopeOnlyWords(text) {
  const remainder = text.toLowerCase()
    .replace(/(?:current|this|the|project|projects|only|all|every|other|now|then|again|please|search|recall|look|up|include|reopen|across|in|from|do|not|don't|never|limit|restrict|to|scope)\b/gu, "")
    .replace(/(?:프로젝트(?:에서|내에서|안에서|내|로|에|는|를|의)?만?|(?:현재|해당|모든|전체|다른|외부|이제|지금|다시|앞으로|그리고|대신|그럼)|범위(?:는|를|만)?|(?:검색|조회|한정|제한)(?:해줘|해주세요|하지|하지마|해|는|를)?|말고|하지|마|말아|줘|주세요)/gu, "");
  return !remainder.replace(/[\s/,:;.!?。-]/gu, "");
}

export function scopeOnlyRequest(value) {
  const text = scopeRequestText(value);
  return scopeDirective(value) !== null && scopeOnlyWords(text);
}

export function resolveRecallScope(project, request, transcript = {}) {
  let mode = transcript.scopeMode ?? (transcript.scopeProject === project ? "current" : "default");
  for (const text of [...(transcript.users ?? []), request]) mode = scopeDirective(text) ?? mode;
  return Object.freeze({ project, mode });
}

export function scopeAllows(scope, project) {
  return typeof project === "string" && !!project
    && (project === scope.project || ["default", "all"].includes(scope.mode));
}

export function recordMatchesProject(record, project) {
  return (!record?.project || record.project === project)
    && (!record?.properties?.project || record.properties.project === project);
}

export function graphRecordProject(record) {
  const project = record?.project ?? record?.properties?.project;
  return typeof project === "string" && project !== "*" && recordMatchesProject(record, project) ? project : null;
}
