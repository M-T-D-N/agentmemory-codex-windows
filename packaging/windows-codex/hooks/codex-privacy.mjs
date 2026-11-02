const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/gi;

const SECRET_PATTERN_SOURCES = [
  /Bearer\s+[A-Za-z0-9._\-+/=]{20,}/gi,
  /(?<![\p{L}\p{N}\p{M}_])sk-proj-[A-Za-z0-9\-_]{20,}/gu,
  /(?<![\p{L}\p{N}\p{M}_])(?:sk|pk|rk|ak)-[A-Za-z0-9][A-Za-z0-9\-_]{19,}/gu,
  /(?<![\p{L}\p{N}\p{M}_])sk-ant-[A-Za-z0-9\-_]{20,}/gu,
  /gh[pus]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /xoxb-[A-Za-z0-9\-]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[A-Za-z0-9\-_]{35}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /npm_[A-Za-z0-9]{36}/g,
  /glpat-[A-Za-z0-9\-_]{20,}/g,
  /dop_v1_[A-Za-z0-9]{64}/g,
];

const PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;

const URL_CREDENTIALS_RE =
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:"'<>]*:[^\s/?#@"'<>]+@/gi;

export function stripPrivateData(input) {
  let result = input.replace(PRIVATE_TAG_RE, "[REDACTED]");
  result = result.replace(new RegExp(PRIVATE_KEY_BLOCK_RE.source, PRIVATE_KEY_BLOCK_RE.flags), "[REDACTED_SECRET]");
  result = result.replace(new RegExp(URL_CREDENTIALS_RE.source, URL_CREDENTIALS_RE.flags), "$1[REDACTED_SECRET]@");
  for (const source of SECRET_PATTERN_SOURCES) {
    const pattern = new RegExp(source.source, source.flags);
    result = result.replace(pattern, "[REDACTED_SECRET]");
  }
  return result;
}

