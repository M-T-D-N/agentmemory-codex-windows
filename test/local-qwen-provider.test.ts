import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalQwenProvider } from "../src/providers/local-qwen.js";

const originalFetch = globalThis.fetch;
const touchedEnv = [
  "AGENTMEMORY_LOCAL_QWEN_COORDINATION_DIR",
  "AGENTMEMORY_LOCAL_QWEN_MAX_INPUT_TOKENS",
  "AGENTMEMORY_LOCAL_QWEN_MAX_OUTPUT_TOKENS",
  "AGENTMEMORY_LOCAL_QWEN_MIN_CONTEXT_TOKENS",
  "AGENTMEMORY_LOCAL_QWEN_TIMEOUT_MS",
];
const originalEnv: Record<string, string | undefined> = {};
let coordinationDir: string;

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(content: string, completed = true): Response {
  const payload = [
    ": keepalive\n\n",
    `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(0, 5) } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(5) } }] })}\n\n`,
    ...(completed ? ["data: [DONE]\n\n"] : []),
  ].join("");
  const encoded = new TextEncoder().encode(payload);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < encoded.length; offset += 7) {
        controller.enqueue(encoded.slice(offset, offset + 7));
      }
      controller.close();
    },
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function installFetchMock(): ReturnType<typeof vi.fn> {
  let completions = 0;
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
    if (url.endsWith("/props")) {
      return jsonResponse({
        default_generation_settings: { n_ctx: 262144 },
        model_alias: "better-qwen",
        build_info: "llama-test",
      });
    }
    if (url.endsWith("/v1/models")) {
      return jsonResponse({ data: [{ id: "better-qwen", meta: { n_ctx: 262144 } }] });
    }
    if (url.endsWith("/slots")) {
      return jsonResponse([{ id: 0, n_ctx: 262144, is_processing: false }]);
    }
    if (url.endsWith("/v1/chat/completions")) {
      completions += 1;
      const body = JSON.parse(String(init?.body)) as { model: string; stream: boolean };
      expect(body.model).toBe("better-qwen");
      expect(body.stream).toBe(true);
      return sseResponse(completions === 1
        ? "<ok>LOCAL_QWEN_OK</ok>"
        : "<entities></entities><relationships></relationships>");
    }
    return new Response("not found", { status: 404 });
  });
  globalThis.fetch = mock as typeof fetch;
  return mock;
}

describe("LocalQwenProvider", () => {
  beforeEach(() => {
    coordinationDir = mkdtempSync(join(tmpdir(), "agentmemory-qwen-"));
    for (const key of touchedEnv) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.AGENTMEMORY_LOCAL_QWEN_COORDINATION_DIR = coordinationDir;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of touchedEnv) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    rmSync(coordinationDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("discovers a changed model and 262K context without an identity pin", async () => {
    installFetchMock();
    const provider = new LocalQwenProvider("auto", 2048, "http://127.0.0.1:8000");

    await expect(provider.probe()).resolves.toMatchObject({
      model: "better-qwen",
      contextTokens: 262144,
      maxInputTokens: 207667,
      maxOutputTokens: 2048,
    });
  });

  it("honors an explicit input cap without pinning the discovered context", async () => {
    process.env.AGENTMEMORY_LOCAL_QWEN_MAX_INPUT_TOKENS = "65536";
    installFetchMock();
    const provider = new LocalQwenProvider("auto", 2048, "http://127.0.0.1:8000");

    await expect(provider.probe()).resolves.toMatchObject({
      contextTokens: 262144,
      maxInputTokens: 65536,
    });
  });

  it("runs one canary per discovered fingerprint before graph generation", async () => {
    const fetchMock = installFetchMock();
    const provider = new LocalQwenProvider("auto", 2048, "http://localhost:8000/v1");

    await expect(provider.compress("system", "user")).resolves.toContain(
      "<entities>",
    );
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/v1/chat/completions"),
      ),
    ).toHaveLength(2);
    expect(provider.getRuntimeInfo()).toMatchObject({
      model: "better-qwen",
      contextTokens: 262144,
    });
  });

  it("fails closed when a streamed completion ends without DONE", async () => {
    let completions = 0;
    const fetchMock = installFetchMock();
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
      if (url.endsWith("/props")) return jsonResponse({
        default_generation_settings: { n_ctx: 262144 },
        model_alias: "better-qwen",
      });
      if (url.endsWith("/v1/models")) return jsonResponse({ data: [{ id: "better-qwen" }] });
      if (url.endsWith("/slots")) return jsonResponse([{ is_processing: false, n_ctx: 262144 }]);
      if (url.endsWith("/v1/chat/completions")) {
        completions += 1;
        return sseResponse(
          completions === 1
            ? "<ok>LOCAL_QWEN_OK</ok>"
            : "<entities></entities><relationships></relationships>",
          completions === 1,
        );
      }
      return new Response("not found", { status: 404 });
    });
    const provider = new LocalQwenProvider("auto", 2048, "http://127.0.0.1:8000");

    await expect(provider.compress("system", "user")).rejects.toThrow(
      "local_qwen_stream_incomplete",
    );
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
  });

  it("rejects non-loopback endpoints before making a request", () => {
    expect(
      () => new LocalQwenProvider("auto", 2048, "https://example.com/v1"),
    ).toThrow(/loopback HTTP/);
  });

  it("defers without calling Qwen while a foreground request is active", async () => {
    const fetchMock = installFetchMock();
    writeFileSync(
      join(coordinationDir, "foreground-request.json"),
      JSON.stringify({ pid: process.pid }),
      "utf8",
    );
    const provider = new LocalQwenProvider("auto", 2048, "http://127.0.0.1:8000");

    await expect(provider.compress("system", "user")).rejects.toThrow(
      "local_qwen_deferred:foreground_requested",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ships the Windows graph budget proven against a real completed response", () => {
    const contract = JSON.parse(readFileSync(
      new URL(
        "../packaging/windows-codex/config/mcp-launcher-environment.json",
        import.meta.url,
      ),
      "utf8",
    )) as {
      fixed_environment: Record<string, string>;
    };

    expect(contract.fixed_environment.AGENTMEMORY_LOCAL_QWEN_MAX_OUTPUT_TOKENS)
      .toBe("4096");
    expect(contract.fixed_environment.AGENTMEMORY_LOCAL_QWEN_TIMEOUT_MS)
      .toBe("180000");
  });

  it("aborts an in-flight background generation when Swarm publishes foreground intent", async () => {
    let completionCount = 0;
    let generationStarted!: () => void;
    const started = new Promise<void>((resolve) => { generationStarted = resolve; });
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
      if (url.endsWith("/props")) return jsonResponse({
        default_generation_settings: { n_ctx: 131072 },
        model_alias: "qwen",
      });
      if (url.endsWith("/v1/models")) return jsonResponse({ data: [{ id: "qwen" }] });
      if (url.endsWith("/slots")) return jsonResponse([{ is_processing: false, n_ctx: 131072 }]);
      if (url.endsWith("/v1/chat/completions")) {
        completionCount += 1;
        if (completionCount === 1) return sseResponse("<ok>LOCAL_QWEN_OK</ok>");
        generationStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const provider = new LocalQwenProvider("auto", 2048, "http://127.0.0.1:8000");
    const pending = provider.compress("system", "user");
    await started;
    writeFileSync(
      join(coordinationDir, "foreground-request.json"),
      JSON.stringify({ pid: process.pid }),
      "utf8",
    );

    await expect(pending).rejects.toThrow("local_qwen_deferred:foreground_requested");
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
  });
});
