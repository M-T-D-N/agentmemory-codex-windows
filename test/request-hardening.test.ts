import { describe, expect, it } from "vitest";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { checkBearerAuth } from "../src/http.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { startViewerServer } from "../src/viewer/server.js";

const token = "upstream-hardening-fixture";

describe("managed upstream request hardening", () => {
  it.each([
    [{ authorization: "Bearer " + token, origin: "https://write-test.invalid", "content-type": "application/json" }, 403],
    [{ authorization: "Bearer " + token, "content-type": "text/plain" }, 415],
  ])("checks writes in the real registered hook middleware", async (headers, status) => {
    const functions = new Map<string, (input: unknown) => unknown>();
    const sdk = {
      registerFunction: (id: string, handler: (input: unknown) => unknown) => functions.set(id, handler),
      registerTrigger: () => {},
    };
    registerApiTriggers(sdk as never, {} as never, (() => ({})) as never, token);
    const result = await functions.get("middleware::api-auth")!({ request: { method: "POST", headers } });
    expect(result).toMatchObject({ action: "respond", response: { status_code: status } });
  });

  it("rejects a browser write from an unrelated origin even with a valid bearer", () => {
    expect(checkBearerAuth({ method: "POST", headers: { authorization: "Bearer " + token, origin: "https://write-test.invalid", "content-type": "application/json" } } as never, token)?.status_code).toBe(403);
  });
  it("rejects non-JSON request bodies", () => {
    expect(checkBearerAuth({ method: "POST", headers: { authorization: "Bearer " + token, "content-type": "text/plain; application/json" } } as never, token)?.status_code).toBe(415);
  });
  it("keeps authenticated non-browser JSON clients working", () => {
    expect(checkBearerAuth({ method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" } } as never, token)).toBeNull();
  });
  it("keeps bearer authentication required", () => {
    expect(checkBearerAuth({ method: "POST", headers: { authorization: "Bearer incorrect", "content-type": "application/json" } } as never, token)?.status_code).toBe(401);
  });
  it("blocks unsafe writes before the real viewer proxy attaches its bearer", async () => {
    let forwarded = 0;
    const upstream = createServer((req, res) => {
      forwarded++;
      req.resume();
      req.on("end", () => { res.writeHead(204); res.end(); });
    });
    let viewer: Server | undefined;
    const listen = async (server: Server) => {
      if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
      return (server.address() as AddressInfo).port;
    };
    const close = (server: Server) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const send = (port: number, headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/agentmemory/remember", method: "POST", headers }, res => {
        res.resume();
        res.once("end", () => resolve(res.statusCode ?? 0));
      });
      req.once("error", reject);
      req.end("{}");
    });
    try {
      upstream.listen(0, "127.0.0.1");
      const restPort = await listen(upstream);
      viewer = startViewerServer(0, {} as never, {} as never, token, restPort);
      const port = await listen(viewer);
      expect(await send(port, { origin: "https://write-test.invalid", "content-type": "application/json" })).toBe(403);
      expect(forwarded).toBe(0);
      expect(await send(port, { "content-type": "application/x-www-form-urlencoded" })).toBe(415);
      expect(forwarded).toBe(0);
      expect(await send(port, { origin: "http://127.0.0.1:" + port, "content-type": "application/json; charset=utf-8" })).toBe(204);
      expect(forwarded).toBe(1);
      expect(await send(port, { "content-type": "application/json" })).toBe(204);
      expect(forwarded).toBe(2);
    } finally {
      if (viewer) await close(viewer);
      await close(upstream);
    }
  });
});
