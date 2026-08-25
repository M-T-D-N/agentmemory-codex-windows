import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { processJsonRpcRequest, type RequestHandler } from "./transport.js";

const TOKEN_DOMAIN = "Codex.AgentMemory.McpHttp.v1";
const MCP_SCOPE = "mcp:tools";
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_FORM_BYTES = 64 * 1024;
const CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
const CONSENT_TTL_MS = 5 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const MAX_CLIENTS = 64;
const MAX_PENDING = 32;

interface RegisteredClient {
  redirectUris: string[];
  expiresAt: number;
  clientName: string;
}

interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope: string;
  resource?: string;
}

interface PendingConsent extends AuthorizationRequest {
  csrfHash: Buffer;
  expiresAt: number;
}

interface AuthorizationCode extends AuthorizationRequest {
  expiresAt: number;
}

export interface StreamableHttpOptions {
  host: "127.0.0.1";
  port: number;
  secret: string;
  handler: RequestHandler;
  serverName?: string;
}

export interface StreamableHttpServer {
  host: "127.0.0.1";
  port: number;
  baseUrl: string;
  resourceUrl: string;
  stop: () => Promise<void>;
}

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function safeEqualText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function deriveMcpHttpAccessToken(secret: string): string {
  if (!secret) throw new Error("AgentMemory MCP HTTP secret is required");
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(TOKEN_DOMAIN, "utf8")
    .digest("base64url");
}

function json(
  response: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(body);
}

function html(response: ServerResponse, status: number, body: string, cookie?: string): void {
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
  if (cookie) headers["set-cookie"] = cookie;
  response.writeHead(status, headers);
  response.end(body);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char] ?? char);
}

async function readBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximumBytes) {
      request.resume();
      throw new HttpStatusError(413, "Request body is too large");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function contentType(request: IncomingMessage): string {
  return String(request.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function parseCookies(request: IncomingMessage): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of String(request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    result.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return result;
}

function oauthCsrfCookieName(approvalId: string): string {
  return `agentmemory_oauth_csrf_${approvalId}`;
}

function isValidLoopbackRedirect(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" || url.username || url.password || url.hash) return false;
    if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") return false;
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 && port <= 65535;
  } catch {
    return false;
  }
}

function isValidPkceValue(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

function appendOAuthResult(redirectUri: string, values: Record<string, string>): string {
  const redirect = new URL(redirectUri);
  for (const [name, value] of Object.entries(values)) redirect.searchParams.set(name, value);
  return redirect.toString();
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, {
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  response.end();
}

function cleanupExpired<T extends { expiresAt: number }>(map: Map<string, T>): void {
  const now = Date.now();
  for (const [key, value] of map) {
    if (value.expiresAt <= now) map.delete(key);
  }
}

export async function startStreamableHttpServer(
  options: StreamableHttpOptions,
): Promise<StreamableHttpServer> {
  if (options.host !== "127.0.0.1") {
    throw new Error("AgentMemory MCP HTTP must bind exactly to 127.0.0.1");
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("AgentMemory MCP HTTP port is invalid");
  }
  const accessToken = deriveMcpHttpAccessToken(options.secret);
  const clients = new Map<string, RegisteredClient>();
  const pending = new Map<string, PendingConsent>();
  const codes = new Map<string, AuthorizationCode>();
  const sockets = new Set<Socket>();
  let actualPort = options.port;
  let baseUrl = "";
  let resourceUrl = "";

  const server = createServer(async (request, response) => {
    try {
      if (request.socket.remoteAddress !== "127.0.0.1") {
        throw new HttpStatusError(403, "IPv4 loopback access is required");
      }
      const expectedHost = `127.0.0.1:${actualPort}`;
      if (request.headers.host !== expectedHost) {
        throw new HttpStatusError(400, "Invalid Host header");
      }
      const requestUrl = new URL(request.url ?? "/", baseUrl);
      cleanupExpired(clients);
      cleanupExpired(pending);
      cleanupExpired(codes);

      if (request.method === "GET" && requestUrl.pathname === "/.well-known/oauth-protected-resource") {
        json(response, 200, {
          resource: resourceUrl,
          authorization_servers: [baseUrl],
          scopes_supported: [MCP_SCOPE],
          bearer_methods_supported: ["header"],
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/.well-known/oauth-authorization-server") {
        json(response, 200, {
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/oauth/authorize`,
          token_endpoint: `${baseUrl}/oauth/token`,
          registration_endpoint: `${baseUrl}/oauth/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: [MCP_SCOPE],
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/oauth/register") {
        if (contentType(request) !== "application/json") {
          throw new HttpStatusError(415, "Dynamic registration requires application/json");
        }
        const body = JSON.parse((await readBody(request, MAX_FORM_BYTES)).toString("utf8")) as {
          redirect_uris?: unknown;
          token_endpoint_auth_method?: unknown;
          grant_types?: unknown;
          response_types?: unknown;
          client_name?: unknown;
        };
        if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length < 1 || body.redirect_uris.length > 8) {
          throw new HttpStatusError(400, "redirect_uris must contain one to eight loopback URLs");
        }
        const redirectUris = body.redirect_uris.filter((value): value is string => typeof value === "string");
        if (redirectUris.length !== body.redirect_uris.length || !redirectUris.every(isValidLoopbackRedirect)) {
          throw new HttpStatusError(400, "Only explicit IPv4 or IPv6 loopback redirect URLs are accepted");
        }
        if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
          throw new HttpStatusError(400, "Only public PKCE clients are accepted");
        }
        if (body.grant_types !== undefined) {
          const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : [];
          const acceptedRegistrationGrants = new Set(["authorization_code", "refresh_token"]);
          if (
            grantTypes.length < 1 ||
            !grantTypes.includes("authorization_code") ||
            grantTypes.some((grant) => typeof grant !== "string" || !acceptedRegistrationGrants.has(grant))
          ) {
            throw new HttpStatusError(400, "Only authorization_code with optional refresh_token registration is accepted");
          }
        }
        if (body.response_types !== undefined && JSON.stringify(body.response_types) !== '["code"]') {
          throw new HttpStatusError(400, "Only the code response type is accepted");
        }
        if (clients.size >= MAX_CLIENTS) throw new HttpStatusError(429, "Too many registered clients");
        const clientId = base64Url(randomBytes(24));
        clients.set(clientId, {
          redirectUris,
          expiresAt: Date.now() + CLIENT_TTL_MS,
          clientName: typeof body.client_name === "string" ? body.client_name.slice(0, 120) : "Codex MCP client",
        });
        json(response, 201, {
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          redirect_uris: redirectUris,
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/oauth/authorize") {
        const clientId = requestUrl.searchParams.get("client_id") ?? "";
        const client = clients.get(clientId);
        const redirectUri = requestUrl.searchParams.get("redirect_uri") ?? "";
        if (!client || !client.redirectUris.includes(redirectUri)) {
          throw new HttpStatusError(400, "Unknown client or redirect URL");
        }
        const responseType = requestUrl.searchParams.get("response_type") ?? "";
        const codeChallenge = requestUrl.searchParams.get("code_challenge") ?? "";
        const challengeMethod = requestUrl.searchParams.get("code_challenge_method") ?? "";
        const state = requestUrl.searchParams.get("state") ?? "";
        const scope = requestUrl.searchParams.get("scope") || MCP_SCOPE;
        const resource = requestUrl.searchParams.get("resource") ?? undefined;
        if (responseType !== "code" || challengeMethod !== "S256" || !isValidPkceValue(codeChallenge) || !state) {
          redirect(response, appendOAuthResult(redirectUri, { error: "invalid_request", state }));
          return;
        }
        if (scope !== MCP_SCOPE || (resource !== undefined && resource !== resourceUrl)) {
          redirect(response, appendOAuthResult(redirectUri, { error: "invalid_scope", state }));
          return;
        }
        if (pending.size >= MAX_PENDING) throw new HttpStatusError(429, "Too many pending authorization requests");
        const approvalId = base64Url(randomBytes(24));
        const csrf = base64Url(randomBytes(24));
        pending.set(approvalId, {
          clientId,
          redirectUri,
          codeChallenge,
          state,
          scope,
          ...(resource ? { resource } : {}),
          csrfHash: sha256(csrf),
          expiresAt: Date.now() + CONSENT_TTL_MS,
        });
        const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize AgentMemory</title><style>body{font:16px system-ui;max-width:42rem;margin:4rem auto;padding:0 1.5rem;color:#18212b}main{border:1px solid #ccd4dc;border-radius:12px;padding:1.5rem}button{font:inherit;padding:.65rem 1rem;margin:.5rem .5rem 0 0}.allow{background:#1267d6;color:white;border:0;border-radius:6px}</style><main><h1>Authorize Codex AgentMemory</h1><p><strong>${escapeHtml(client.clientName)}</strong> is requesting access to the local AgentMemory MCP tools.</p><p>The server is bound to IPv4 loopback and will not expose the underlying AgentMemory secret.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="approval_id" value="${approvalId}"><input type="hidden" name="csrf" value="${csrf}"><button class="allow" name="decision" value="approve" type="submit">Allow</button><button name="decision" value="deny" type="submit">Deny</button></form></main></html>`;
        html(response, 200, page, `${oauthCsrfCookieName(approvalId)}=${csrf}; HttpOnly; SameSite=Strict; Path=/oauth/authorize; Max-Age=300`);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/oauth/authorize") {
        if (contentType(request) !== "application/x-www-form-urlencoded") {
          throw new HttpStatusError(415, "Authorization consent requires form data");
        }
        const form = new URLSearchParams((await readBody(request, MAX_FORM_BYTES)).toString("utf8"));
        const approvalId = form.get("approval_id") ?? "";
        const consent = pending.get(approvalId);
        const csrf = form.get("csrf") ?? "";
        const cookieCsrf = parseCookies(request).get(oauthCsrfCookieName(approvalId)) ?? "";
        if (!consent || !csrf || !safeEqualText(csrf, cookieCsrf) || !timingSafeEqual(sha256(csrf), consent.csrfHash)) {
          throw new HttpStatusError(400, "Authorization consent is invalid or expired");
        }
        pending.delete(approvalId);
        if (form.get("decision") !== "approve") {
          redirect(response, appendOAuthResult(consent.redirectUri, { error: "access_denied", state: consent.state }));
          return;
        }
        const code = base64Url(randomBytes(32));
        codes.set(code, {
          clientId: consent.clientId,
          redirectUri: consent.redirectUri,
          codeChallenge: consent.codeChallenge,
          state: consent.state,
          scope: consent.scope,
          ...(consent.resource ? { resource: consent.resource } : {}),
          expiresAt: Date.now() + CODE_TTL_MS,
        });
        redirect(response, appendOAuthResult(consent.redirectUri, { code, state: consent.state }));
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/oauth/token") {
        if (contentType(request) !== "application/x-www-form-urlencoded") {
          throw new HttpStatusError(415, "Token requests require form data");
        }
        const form = new URLSearchParams((await readBody(request, MAX_FORM_BYTES)).toString("utf8"));
        const codeValue = form.get("code") ?? "";
        const code = codes.get(codeValue);
        const verifier = form.get("code_verifier") ?? "";
        const resource = form.get("resource") ?? undefined;
        if (
          form.get("grant_type") !== "authorization_code" ||
          !code ||
          form.get("client_id") !== code.clientId ||
          form.get("redirect_uri") !== code.redirectUri ||
          !isValidPkceValue(verifier) ||
          base64Url(sha256(verifier)) !== code.codeChallenge ||
          (resource !== undefined && resource !== resourceUrl)
        ) {
          json(response, 400, { error: "invalid_grant" });
          return;
        }
        codes.delete(codeValue);
        json(response, 200, {
          access_token: accessToken,
          token_type: "Bearer",
          scope: code.scope,
        });
        return;
      }

      if (requestUrl.pathname === "/mcp") {
        const unauthorized = () => json(response, 401, { error: "invalid_token" }, {
          "www-authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
        });
        const authorization = request.headers.authorization ?? "";
        const prefix = "Bearer ";
        if (!authorization.startsWith(prefix) || !safeEqualText(authorization.slice(prefix.length), accessToken)) {
          unauthorized();
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405, { allow: "POST", "cache-control": "no-store" });
          response.end();
          return;
        }
        if (contentType(request) !== "application/json") {
          throw new HttpStatusError(415, "MCP requests require application/json");
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse((await readBody(request, MAX_JSON_BYTES)).toString("utf8"));
        } catch (error) {
          if (error instanceof HttpStatusError) throw error;
          json(response, 200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
          return;
        }
        const rpcResponse = await processJsonRpcRequest(parsed, options.handler, () => undefined);
        if (!rpcResponse) {
          response.writeHead(202, { "cache-control": "no-store" });
          response.end();
          return;
        }
        json(response, 200, rpcResponse);
        return;
      }
      throw new HttpStatusError(404, "Not found");
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof SyntaxError) {
        json(response, 400, { error: "invalid_request", error_description: "Invalid JSON" });
        return;
      }
      const status = error instanceof HttpStatusError ? error.status : 500;
      const message = error instanceof HttpStatusError ? error.message : "Internal server error";
      json(response, status, { error: status === 500 ? "server_error" : "invalid_request", error_description: message });
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("AgentMemory MCP HTTP did not acquire an IPv4 listener"));
        return;
      }
      actualPort = address.port;
      baseUrl = `http://127.0.0.1:${actualPort}`;
      resourceUrl = `${baseUrl}/mcp`;
      resolve();
    });
  });

  let stopPromise: Promise<void> | undefined;
  return {
    host: options.host,
    port: actualPort,
    baseUrl,
    resourceUrl,
    stop() {
      stopPromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        for (const socket of sockets) socket.destroy();
      });
      return stopPromise;
    },
  };
}
