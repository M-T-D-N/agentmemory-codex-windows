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
import { unlink } from "node:fs/promises";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: vi.fn(actual.unlink) };
});

const originalFetch = globalThis.fetch;
const touchedEnv = [
  "AGENTMEMORY_LOCAL_QWEN_COORDINATION_DIR",
  "AGENTMEMORY_LOCAL_QWEN_LIFECYCLE_SCRIPT",
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

function sseResponse(content: string, finishReason = "stop"): Response {
  const encoded = new TextEncoder().encode(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n` +
      "data: [DONE]\n\n",
  );
  return new Response(new ReadableStream({
    start(controller) {
      const split = Math.max(1, Math.floor(encoded.length / 2));
      controller.enqueue(encoded.slice(0, split));
      controller.enqueue(encoded.slice(split));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function publicSseResponse(content: string, completed = true): Response {
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
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        stream: boolean;
      };
      expect(body.model).toBe("better-qwen");
      expect(body.stream).toBe(true);
      return sseResponse(
        completions === 1
          ? "<ok>LOCAL_QWEN_OK</ok>"
          : "<entities></entities><relationships></relationships>",
      );
    }
    return new Response("not found", { status: 404 });
  });
  globalThis.fetch = mock as typeof fetch;
  return mock;
}

describe("LocalQwenProvider", () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(unlink).mockReset().mockImplementation(actual.unlink);
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

  it("blocks probe and direct extraction during a host hold without network or lease writes", async () => {
    process.env.AGENTMEMORY_LOCAL_QWEN_LIFECYCLE_SCRIPT = join(coordinationDir, "scripts", "Invoke-LocalAI.ps1");
    writeFileSync(join(coordinationDir, "config.json"), JSON.stringify({qwen:{background_start_enabled:false}}));
    const fetch = vi.fn(); globalThis.fetch = fetch;
    const provider = new LocalQwenProvider("auto",2048,"http://127.0.0.1:8000");
    await expect(provider.probe()).rejects.toThrow("local_qwen_deferred:background_held");
    await expect(provider.compress("system","user")).rejects.toThrow("local_qwen_deferred:background_held");
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(join(coordinationDir,"background.lock"))).toBe(false);
    writeFileSync(join(coordinationDir,"config.json"),JSON.stringify({qwen:{background_start_enabled:true}}));
    installFetchMock(); await expect(provider.probe()).resolves.toMatchObject({provider:"local-qwen"});
  });

  it.each([
    [new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) }), "ECONNREFUSED"],
    [new DOMException("expired", "TimeoutError"), "TIMEOUT"],
    [new TypeError("fetch failed"), "UNKNOWN"],
  ])("reports transport cause and loopback address for probe failures (%s)", async (failure, code) => {
    globalThis.fetch = vi.fn().mockRejectedValue(failure);
    const provider = new LocalQwenProvider("auto", 2048, "http://127.0.0.1:8000");
    await expect(provider.probe()).rejects.toMatchObject({
      message: `local_qwen_transport_failed:${code}:127.0.0.1:8000`, cause: failure,
    });
  });

  it("reports generation connection loss and releases the background lease", async () => {
    const mock = installFetchMock();
    const implementation = mock.getMockImplementation()!;
    mock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/chat/completions")) {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
      }
      return implementation(input, init);
    });
    const provider = new LocalQwenProvider("auto", 2048, "http://127.0.0.1:8000");
    await expect(provider.compress("system", "user")).rejects.toThrow("local_qwen_transport_failed:ECONNRESET:127.0.0.1:8000");
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
  });


  it.each(["EBUSY", "EPERM"])("retries a transient %s release without losing the response", async (code) => {
    installFetchMock();
    const failure = Object.assign(new Error("sharing collision"), { code });
    vi.mocked(unlink).mockRejectedValueOnce(failure);
    const provider = new LocalQwenProvider("auto", 2048, "http://127.0.0.1:8000");

    await expect(provider.compress("system", "user")).resolves.toContain("<entities>");
    expect(unlink).toHaveBeenCalledTimes(2);
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
  });

  it("reports exhausted release and recovers only its known lease before the next acquisition", async () => {
    const fetch = installFetchMock();
    const failure = Object.assign(new Error("sharing collision"), { code: "EBUSY" });
    vi.mocked(unlink).mockRejectedValue(failure);
    const provider = new LocalQwenProvider("auto", 2048, "http://127.0.0.1:8000");

    await expect(provider.compress("system", "user")).rejects.toMatchObject({
      message: "local_qwen_lease_release_failed:EBUSY", cause: failure,
    });
    expect(unlink).toHaveBeenCalledTimes(3);
    const lease = JSON.parse(readFileSync(join(coordinationDir, "qwen-use.lock"), "utf8"));
    expect(lease).toMatchObject({ owner: "agentmemory-background", pid: process.pid });
    vi.mocked(unlink).mockImplementation((await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).unlink);

    await expect(provider.compress("system", "user again")).resolves.toContain("<entities>");
    expect(unlink).toHaveBeenCalledTimes(5);
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/chat/completions"))).toHaveLength(3);
  });

  it("shares pending cleanup across concurrent next acquisitions", async () => {
    installFetchMock();
    vi.mocked(unlink).mockRejectedValue(Object.assign(new Error("sharing collision"), { code: "EBUSY" }));
    const provider = new LocalQwenProvider("auto", 2048, "http://127.0.0.1:8000");
    await expect(provider.compress("system", "user")).rejects.toThrow("local_qwen_lease_release_failed:EBUSY");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let signalStarted!: () => void;
    let unblock!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    let releases = 0;
    vi.mocked(unlink).mockImplementation(async path => {
      if (releases++ === 0) {
        signalStarted();
        await blocked;
      }
      await actual.unlink(path);
    });

    const pending = [provider.compress("system", "first"), provider.compress("system", "second")];
    await started;
    unblock();
    const outcomes = await Promise.allSettled(pending);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.message).toBe("local_qwen_deferred:lease_busy");
    expect(unlink).toHaveBeenCalledTimes(5);
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
  });

  it("preserves the request error and exhausted cleanup error together", async () => {
    const fetch = installFetchMock();
    const implementation = fetch.getMockImplementation()!;
    const requestFailure = new TypeError("fetch failed", {
      cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
    });
    fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/chat/completions")) throw requestFailure;
      return implementation(input, init);
    });
    const cleanupFailure = Object.assign(new Error("sharing collision"), { code: "EBUSY" });
    vi.mocked(unlink).mockRejectedValue(cleanupFailure);
    const provider = new LocalQwenProvider("auto", 2048, "http://127.0.0.1:8000");

    const failure = await provider.compress("system", "user").catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toMatchObject({
      message: "local_qwen_transport_failed:ECONNRESET:127.0.0.1:8000", cause: requestFailure,
    });
    expect(failure.errors[1]).toMatchObject({
      message: "local_qwen_lease_release_failed:EBUSY", cause: cleanupFailure,
    });
    expect(failure.cause).toBe(failure.errors[0]);
    expect(failure.message).toContain(failure.errors[0].message);
    expect(failure.message).toContain(failure.errors[1].message);
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(true);
  });

  it.each(["token", "pid", "processStartUtc", "owner"])("rechecks %s and preserves a replacement lease during cleanup retry", async (field) => {
    installFetchMock();
    const leasePath = join(coordinationDir, "qwen-use.lock");
    let replacement: Record<string, unknown>;
    vi.mocked(unlink).mockImplementationOnce(async () => {
      const lease = JSON.parse(readFileSync(leasePath, "utf8"));
      replacement = { ...lease, [field]: field === "pid" ? process.pid + 1 : "replacement" };
      writeFileSync(leasePath, JSON.stringify(replacement));
      throw Object.assign(new Error("sharing collision"), { code: "EBUSY" });
    });
    const provider = new LocalQwenProvider("auto", 2048, "http://127.0.0.1:8000");

    await expect(provider.compress("system", "user")).resolves.toContain("<entities>");
    expect(unlink).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(leasePath, "utf8"))).toEqual(replacement!);
  });

  it("preserves a replacement token when retrying a previously exhausted release", async () => {
    const fetch = installFetchMock();
    vi.mocked(unlink).mockRejectedValue(Object.assign(new Error("sharing collision"), { code: "EBUSY" }));
    const provider = new LocalQwenProvider("auto", 2048, "http://127.0.0.1:8000");
    await expect(provider.compress("system", "user")).rejects.toThrow("local_qwen_lease_release_failed:EBUSY");
    const leasePath = join(coordinationDir, "qwen-use.lock");
    const replacement = { ...JSON.parse(readFileSync(leasePath, "utf8")), token: "other-consumer" };
    writeFileSync(leasePath, JSON.stringify(replacement));
    const calls = fetch.mock.calls.length;

    await expect(provider.compress("system", "user again")).rejects.toThrow("local_qwen_deferred:lease_busy");
    expect(unlink).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls).toHaveLength(calls);
    expect(JSON.parse(readFileSync(leasePath, "utf8"))).toEqual(replacement);
  });

  it("cleans its pending released lease while preserving foreground intent", async () => {
    const fetch = installFetchMock();
    vi.mocked(unlink).mockRejectedValue(Object.assign(new Error("sharing collision"), { code: "EBUSY" }));
    const provider = new LocalQwenProvider("auto", 2048, "http://127.0.0.1:8000");
    await expect(provider.compress("system", "user")).rejects.toThrow("local_qwen_lease_release_failed:EBUSY");
    const foregroundPath = join(coordinationDir, "foreground-request.json");
    const foreground = { pid: process.pid, token: "foreground-consumer" };
    writeFileSync(foregroundPath, JSON.stringify(foreground));
    vi.mocked(unlink).mockImplementation((await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).unlink);
    const calls = fetch.mock.calls.length;

    await expect(provider.compress("system", "user again")).rejects.toThrow("local_qwen_deferred:foreground_requested");
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
    expect(JSON.parse(readFileSync(foregroundPath, "utf8"))).toEqual(foreground);
    expect(fetch.mock.calls).toHaveLength(calls);
  });

  it("reports a stream-body transport cause and releases the lease", async () => {
    const fetch = installFetchMock();
    const implementation = fetch.getMockImplementation()!;
    const failure = new TypeError("terminated", {
      cause: Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }),
    });
    fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/chat/completions")) {
        return new Response(new ReadableStream({ start(controller) { controller.error(failure); } }), {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return implementation(input, init);
    });
    const provider = new LocalQwenProvider("auto", 2048, "http://127.0.0.1:8000");

    await expect(provider.compress("system", "user")).rejects.toMatchObject({
      message: "local_qwen_transport_failed:UND_ERR_SOCKET:127.0.0.1:8000", cause: failure,
    });
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
  });

  it("keeps streamed foreground cancellation distinct from transport failure", async () => {
    const fetch = installFetchMock();
    const implementation = fetch.getMockImplementation()!;
    let completions = 0;
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/chat/completions") && ++completions > 1) {
        return new Response(new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () => {
              controller.error(new DOMException("aborted", "AbortError"));
            }, { once: true });
            signalStarted();
          },
        }), { headers: { "Content-Type": "text/event-stream" } });
      }
      return implementation(input, init);
    });
    const provider = new LocalQwenProvider("auto", 2048, "http://127.0.0.1:8000");
    const pending = provider.compress("system", "user");
    await started;
    const foreground = { pid: process.pid, token: "foreground-consumer" };
    const foregroundPath = join(coordinationDir, "foreground-request.json");
    writeFileSync(foregroundPath, JSON.stringify(foreground));

    await expect(pending).rejects.toThrow("local_qwen_deferred:foreground_requested");
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
    expect(JSON.parse(readFileSync(foregroundPath, "utf8"))).toEqual(foreground);
  });

  it.each([1, 2])("cancels streamed inference at worker shutdown and releases its lease: request %s", async (requestNumber) => {
    const fetch = installFetchMock();
    const implementation = fetch.getMockImplementation()!;
    let completions = 0;
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/chat/completions") && ++completions === requestNumber) {
        return new Response(new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () => {
              controller.error(new DOMException("aborted", "AbortError"));
            }, { once: true });
            signalStarted();
          },
        }), { headers: { "Content-Type": "text/event-stream" } });
      }
      return implementation(input, init);
    });
    const shutdown = new AbortController();
    const provider = new LocalQwenProvider("auto", 2048, "http://127.0.0.1:8000", shutdown.signal);
    const pending = provider.compress("system", "user");
    const outcome = expect(pending).rejects.toThrow("local_qwen_deferred:shutdown");
    await started;
    shutdown.abort();
    await outcome;
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
    const calls = fetch.mock.calls.length;
    await expect(provider.compress("system", "retry")).rejects.toThrow("local_qwen_deferred:shutdown");
    await expect(provider.probe()).rejects.toThrow("local_qwen_deferred:shutdown");
    expect(fetch.mock.calls).toHaveLength(calls);
  }, 1000);

  it("keeps stream validation failures distinct from transport failures", async () => {
    const fetch = installFetchMock();
    const implementation = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/chat/completions")) {
        return new Response("data: {invalid-json}\n\n", { headers: { "Content-Type": "text/event-stream" } });
      }
      return implementation(input, init);
    });
    const provider = new LocalQwenProvider("auto", 2048, "http://127.0.0.1:8000");

    await expect(provider.compress("system", "user")).rejects.toThrow("local_qwen_invalid_stream_chunk");
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
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

  it("reports a hard output cutoff instead of returning partial XML for repair", async () => {
    let completionCount = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
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
        return completionCount === 1
          ? sseResponse("<ok>LOCAL_QWEN_OK</ok>")
          : sseResponse("<entities><entity", "length");
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const provider = new LocalQwenProvider("auto", 2048, "http://127.0.0.1:8000");

    await expect(provider.compress("system", "user")).rejects.toThrow(
      "local_qwen_output_truncated:2048",
    );
    expect(completionCount).toBe(2);
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
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
        return publicSseResponse(
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
      .toBe("32768");
    expect(contract.fixed_environment.AGENTMEMORY_LOCAL_QWEN_TIMEOUT_MS)
      .toBe("1200000");
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
