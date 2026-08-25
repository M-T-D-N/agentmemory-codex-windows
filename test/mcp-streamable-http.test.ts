import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveMcpHttpAccessToken,
  startStreamableHttpServer,
  type StreamableHttpServer,
} from "../src/mcp/streamable-http.js";

const secret = "unit-test-secret-that-is-never-an-oauth-token";
const servers: StreamableHttpServer[] = [];

async function start() {
  const handler = vi.fn(async (method: string, params: Record<string, unknown>) => ({
    method,
    params,
  }));
  const server = await startStreamableHttpServer({
    host: "127.0.0.1",
    port: 0,
    secret,
    handler,
    serverName: "AgentMemoryCodex test",
  });
  servers.push(server);
  return { server, handler };
}

async function mcp(
  server: StreamableHttpServer,
  authorization: string | undefined,
  payload: unknown,
) {
  return fetch(server.resourceUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(payload),
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe("AgentMemory Streamable HTTP security", () => {
  it("binds IPv4 loopback, fails closed, and never accepts the backend secret", async () => {
    const { server, handler } = await start();
    expect(server.host).toBe("127.0.0.1");
    expect(server.resourceUrl).toBe(`http://127.0.0.1:${server.port}/mcp`);

    const missing = await mcp(server, undefined, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain(
      `${server.baseUrl}/.well-known/oauth-protected-resource`,
    );

    const rawSecret = await mcp(server, `Bearer ${secret}`, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
    });
    expect(rawSecret.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("serves authenticated JSON-RPC requests and suppresses notification responses", async () => {
    const { server, handler } = await start();
    const bearer = `Bearer ${deriveMcpHttpAccessToken(secret)}`;
    const request = await mcp(server, bearer, {
      jsonrpc: "2.0",
      id: "init-1",
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(request.status).toBe(200);
    expect(await request.json()).toEqual({
      jsonrpc: "2.0",
      id: "init-1",
      result: {
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
    });

    const notification = await mcp(server, bearer, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");
    expect(handler).toHaveBeenCalledTimes(2);

    const get = await fetch(server.resourceUrl, { headers: { authorization: bearer } });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
  });
});

describe("AgentMemory local OAuth", () => {
  it("requires explicit PKCE consent and issues only the derived MCP token", async () => {
    const { server } = await start();
    const redirectUri = "http://127.0.0.1:65530/oauth/callback";
    const registration = await fetch(`${server.baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Codex test client",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registration.status).toBe(201);
    const client = await registration.json() as { client_id: string; grant_types: string[] };
    expect(client.grant_types).toEqual(["authorization_code"]);

    const verifier = "v".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeUrl = new URL(`${server.baseUrl}/oauth/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "opaque-state",
      scope: "mcp:tools",
      resource: server.resourceUrl,
    }).toString();
    const consentPage = await fetch(authorizeUrl, { redirect: "manual" });
    expect(consentPage.status).toBe(200);
    const cookie = consentPage.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const page = await consentPage.text();
    expect(page).toContain("Authorize Codex AgentMemory");
    const approvalId = page.match(/name="approval_id" value="([^"]+)"/)?.[1];
    const csrf = page.match(/name="csrf" value="([^"]+)"/)?.[1];
    expect(approvalId).toBeTruthy();
    expect(csrf).toBeTruthy();

    const consent = await fetch(`${server.baseUrl}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookie.split(";", 1)[0]!,
      },
      body: new URLSearchParams({
        approval_id: approvalId!,
        csrf: csrf!,
        decision: "approve",
      }),
    });
    expect(consent.status).toBe(302);
    const callback = new URL(consent.headers.get("location")!);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("state")).toBe("opaque-state");
    const code = callback.searchParams.get("code")!;

    const tokenRequest = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: server.resourceUrl,
    });
    const token = await fetch(`${server.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenRequest,
    });
    expect(token.status).toBe(200);
    const tokenBody = await token.json() as { access_token: string; token_type: string };
    expect(tokenBody.token_type).toBe("Bearer");
    expect(tokenBody.access_token).toBe(deriveMcpHttpAccessToken(secret));
    expect(tokenBody.access_token).not.toBe(secret);

    const reuse = await fetch(`${server.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenRequest,
    });
    expect(reuse.status).toBe(400);
  });

  it("rejects non-loopback redirect registration", async () => {
    const { server } = await start();
    const response = await fetch(`${server.baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://example.com/callback"] }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects unsupported dynamic registration grants", async () => {
    const { server } = await start();
    const response = await fetch(`${server.baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1:65530/oauth/callback"],
        grant_types: ["authorization_code", "client_credentials"],
      }),
    });
    expect(response.status).toBe(400);
  });

  it("keeps concurrent browser consent cookies isolated by approval", async () => {
    const { server } = await start();
    const redirectUri = "http://127.0.0.1:65530/oauth/callback";
    const registration = await fetch(`${server.baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    const client = await registration.json() as { client_id: string };
    const verifier = "v".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const openConsent = async (state: string) => {
      const authorizeUrl = new URL(`${server.baseUrl}/oauth/authorize`);
      authorizeUrl.search = new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        scope: "mcp:tools",
      }).toString();
      const response = await fetch(authorizeUrl);
      const page = await response.text();
      return {
        approvalId: page.match(/name="approval_id" value="([^"]+)"/)?.[1] ?? "",
        csrf: page.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "",
        cookie: (response.headers.get("set-cookie") ?? "").split(";", 1)[0]!,
      };
    };
    const first = await openConsent("first-state");
    const second = await openConsent("second-state");
    expect(first.cookie.split("=", 1)[0]).not.toBe(second.cookie.split("=", 1)[0]);

    const consent = await fetch(`${server.baseUrl}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${first.cookie}; ${second.cookie}`,
      },
      body: new URLSearchParams({
        approval_id: first.approvalId,
        csrf: first.csrf,
        decision: "approve",
      }),
    });
    expect(consent.status).toBe(302);
    expect(new URL(consent.headers.get("location")!).searchParams.get("state")).toBe("first-state");
  });
});
