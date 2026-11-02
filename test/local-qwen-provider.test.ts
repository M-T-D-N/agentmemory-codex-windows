import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
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
import { QwenTestScope, onAbort, QWEN_PROCESS_TEST_MS, QWEN_MULTI_PROCESS_TEST_MS, QWEN_FIXTURE_DRAIN_MS } from "./helpers/qwen-test-scope.js";
import { LocalQwenProvider } from "../src/providers/local-qwen.js";
import { open, rm } from "node:fs/promises";
import { invokeQwenCoordination } from "../src/providers/local-qwen-coordination.js";
const releaseOperation = vi.fn<typeof invokeQwenCoordination>();
const publicationOperation = vi.fn<typeof invokeQwenCoordination>();
let actualCoordination: typeof invokeQwenCoordination;
let fixture: QwenTestScope | undefined;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: vi.fn(actual.unlink), open: vi.fn(actual.open), link: vi.fn(actual.link), rm: vi.fn(actual.rm) };
});

vi.mock("../src/providers/local-qwen-coordination.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/providers/local-qwen-coordination.js")>();
  return { ...actual, invokeQwenCoordination: vi.fn((request: Record<string, unknown>) =>
    requiredFixture().track("coordination:" + String(request.operation), () =>
      request.operation === "release" ? releaseOperation(request) : request.operation === "publish" ? publicationOperation(request) : actualCoordination(request))) };
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
let fixtureName: string;

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

function installFetchMock(): Mock<typeof globalThis.fetch> {
  let completions = 0;
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
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

function requiredFixture(): QwenTestScope {
  if (!fixture) throw Error("qwen_test_fixture_missing");
  return fixture;
}

function inFixture<Args extends unknown[]>(body: (...args: Args) => void | Promise<void>) {
  return (...args: Args) => requiredFixture().run("test body", () => body(...args));
}

function createProvider(...args: ConstructorParameters<typeof LocalQwenProvider>): LocalQwenProvider {
  const scope = requiredFixture();
  scope.assertOpen();
  const [model, maxTokens, endpoint, shutdown] = args;
  const signal = shutdown ? AbortSignal.any([shutdown, scope.abort.signal]) : scope.abort.signal;
  const provider = new LocalQwenProvider(model, maxTokens, endpoint, signal);
  return new Proxy(provider, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (["compress", "summarize", "probe"].includes(String(key)) && typeof value === "function") {
        return (...params: unknown[]) => scope.run("provider:" + String(key), () => Reflect.apply(value, target, params));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function finalizeFixture(): void {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  for (const key of touchedEnv) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  rmSync(coordinationDir, { recursive: true, force: true });
  const processes = requiredFixture().timings.filter(entry => entry.label.startsWith("process:"));
  if (processes.length) process.stdout.write("QWEN_TEST_COORDINATION " + JSON.stringify({
    test: fixtureName, calls: processes.length, totalMs: processes.reduce((sum, entry) => sum + entry.ms, 0), processes,
  }) + "\n");
}

async function setupFixture(name = "next fixture after abandoned work"): Promise<void> {
    fixture?.assertClosed();
    fixture = new QwenTestScope();
    fixtureName = name;
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const realCoordination = (await vi.importActual<typeof import("../src/providers/local-qwen-coordination.js")>("../src/providers/local-qwen-coordination.js")).invokeQwenCoordination;
    actualCoordination = request => requiredFixture().track("process:" + String(request.operation), () => realCoordination(request));
    globalThis.fetch = async () => { throw Error("qwen_test_unmocked_fetch"); };
    releaseOperation.mockReset().mockImplementation(actualCoordination);
    vi.mocked(open).mockReset().mockImplementation(actual.open);
    publicationOperation.mockReset().mockImplementation(actualCoordination);
    vi.mocked(rm).mockReset().mockImplementation(actual.rm);
    coordinationDir = mkdtempSync(join(tmpdir(), "agentmemory-qwen-"));
    for (const key of touchedEnv) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.AGENTMEMORY_LOCAL_QWEN_COORDINATION_DIR = coordinationDir;
}

describe("LocalQwenProvider", { concurrent: false }, () => {
  beforeEach(context => setupFixture(context.task.name));

  afterEach(async () => {
    const scope = requiredFixture();
    await scope.close(finalizeFixture);
  }, QWEN_FIXTURE_DRAIN_MS + 5_000);

  it("blocks probe and direct extraction during a host hold without network or lease writes", inFixture(async () => {
    process.env.AGENTMEMORY_LOCAL_QWEN_LIFECYCLE_SCRIPT = join(coordinationDir, "scripts", "Invoke-LocalAI.ps1");
    writeFileSync(join(coordinationDir, "config.json"), JSON.stringify({qwen:{background_start_enabled:false}}));
    const fetch = vi.fn(); globalThis.fetch = fetch;
    const provider = createProvider("auto",2048,"http://127.0.0.1:8000");
    await expect(provider.probe()).rejects.toThrow("local_qwen_deferred:background_held");
    await expect(provider.compress("system","user")).rejects.toThrow("local_qwen_deferred:background_held");
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(join(coordinationDir,"background.lock"))).toBe(false);
    writeFileSync(join(coordinationDir,"config.json"),JSON.stringify({qwen:{background_start_enabled:true}}));
    installFetchMock(); await expect(provider.probe()).resolves.toMatchObject({provider:"local-qwen"});
  }));

  it.each([
    [new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) }), "ECONNREFUSED"],
    [new DOMException("expired", "TimeoutError"), "TIMEOUT"],
    [new TypeError("fetch failed"), "UNKNOWN"],
  ])("reports transport cause and loopback address for probe failures (%s)", inFixture(async (failure: unknown, code: unknown) => {
    globalThis.fetch = vi.fn().mockRejectedValue(failure);
    const provider = createProvider("auto", 2048, "http://127.0.0.1:8000");
    await expect(provider.probe()).rejects.toMatchObject({
      message: `local_qwen_transport_failed:${code}:127.0.0.1:8000`, cause: failure,
    });
  }));

  it("reports generation connection loss and releases the background lease", inFixture(async () => {
    const mock = installFetchMock();
    const implementation = mock.getMockImplementation()!;
    mock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/chat/completions")) {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
      }
      return implementation(input, init);
    });
    const provider = createProvider("auto", 2048, "http://127.0.0.1:8000");
    await expect(provider.compress("system", "user")).rejects.toThrow("local_qwen_transport_failed:ECONNRESET:127.0.0.1:8000");
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
  }), QWEN_PROCESS_TEST_MS);


  it.each(["EBUSY", "EPERM"])("retries a transient %s release without losing the response", inFixture(async (code: string) => {
    installFetchMock();
    const failure = Object.assign(new Error("sharing collision"), { code });
    releaseOperation.mockRejectedValueOnce(failure);
    const provider = createProvider("auto", 2048, "http://127.0.0.1:8000");

    await expect(provider.compress("system", "user")).resolves.toContain("<entities>");
    expect(releaseOperation).toHaveBeenCalledTimes(2);
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
  }), QWEN_PROCESS_TEST_MS);

  it("reports exhausted release and recovers only its known lease before the next acquisition", inFixture(async () => {
    const fetch = installFetchMock();
    const failure = Object.assign(new Error("sharing collision"), { code: "EBUSY" });
    releaseOperation.mockRejectedValue(failure);
    const provider = createProvider("auto", 2048, "http://127.0.0.1:8000");

    await expect(provider.compress("system", "user")).rejects.toMatchObject({
      message: "local_qwen_lease_release_failed:EBUSY", cause: failure,
    });
    expect(releaseOperation).toHaveBeenCalledTimes(3);
    const lease = JSON.parse(readFileSync(join(coordinationDir, "qwen-use.lock"), "utf8"));
    expect(lease).toMatchObject({ owner: "agentmemory-background", pid: process.pid });
    releaseOperation.mockImplementation(actualCoordination);

    await expect(provider.compress("system", "user again")).resolves.toContain("<entities>");
    expect(releaseOperation).toHaveBeenCalledTimes(5);
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/chat/completions"))).toHaveLength(3);
  }), QWEN_MULTI_PROCESS_TEST_MS);

  it("shares pending cleanup across concurrent next acquisitions", inFixture(async () => {
    installFetchMock();
    releaseOperation.mockRejectedValue(Object.assign(new Error("sharing collision"), { code: "EBUSY" }));
    const provider = createProvider("auto", 2048, "http://127.0.0.1:8000");
    await expect(provider.compress("system", "user")).rejects.toThrow("local_qwen_lease_release_failed:EBUSY");
    const { promise: started, release: signalStarted } = requiredFixture().barrier();
    const { promise: blocked, release: unblock } = requiredFixture().barrier();
    let releases = 0;
    releaseOperation.mockImplementation(async request => {
      if (releases++ === 0) {
        signalStarted();
        await blocked;
      }
      return actualCoordination(request);
    });

    const { promise: publicationHeld, release: releasePublication } = requiredFixture().barrier();
    let publications = 0;
    publicationOperation.mockImplementation(async request => {
      const result = await actualCoordination(request);
      if (++publications === 1) await publicationHeld;
      return result;
    });
    const pending = [provider.compress("system", "first"), provider.compress("system", "second")];
    for (const request of pending) void request.catch(() => releasePublication());
    await requiredFixture().waitFor(started);
    unblock();
    const outcomes = await Promise.allSettled(pending);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.message).toBe("local_qwen_deferred:lease_busy");
    expect(releaseOperation).toHaveBeenCalledTimes(5);
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
  }), QWEN_MULTI_PROCESS_TEST_MS);

  it("preserves the request error and exhausted cleanup error together", inFixture(async () => {
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
    releaseOperation.mockRejectedValue(cleanupFailure);
    const provider = createProvider("auto", 2048, "http://127.0.0.1:8000");

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
  }), QWEN_PROCESS_TEST_MS);

  it.each(["token", "pid", "processStartUtc", "owner"])("rechecks %s and preserves a replacement lease during cleanup retry", inFixture(async (field) => {
    installFetchMock();
    const leasePath = join(coordinationDir, "qwen-use.lock");
    let replacement: Record<string, unknown>;
    releaseOperation.mockImplementationOnce(async () => {
      const lease = JSON.parse(readFileSync(leasePath, "utf8"));
      replacement = { ...lease, [field]: field === "pid" ? process.pid + 1 : "replacement" };
      writeFileSync(leasePath, JSON.stringify(replacement));
      throw Object.assign(new Error("sharing collision"), { code: "EBUSY" });
    });
    const provider = createProvider("auto", 2048, "http://127.0.0.1:8000");

    await expect(provider.compress("system", "user")).resolves.toContain("<entities>");
    expect(releaseOperation).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(leasePath, "utf8"))).toEqual(replacement!);
  }), QWEN_PROCESS_TEST_MS);

  it("preserves a replacement token when retrying a previously exhausted release", inFixture(async () => {
    const fetch = installFetchMock();
    releaseOperation.mockRejectedValue(Object.assign(new Error("sharing collision"), { code: "EBUSY" }));
    const provider = createProvider("auto", 2048, "http://127.0.0.1:8000");
    await expect(provider.compress("system", "user")).rejects.toThrow("local_qwen_lease_release_failed:EBUSY");
    const leasePath = join(coordinationDir, "qwen-use.lock");
    const replacement = { ...JSON.parse(readFileSync(leasePath, "utf8")), token: "other-consumer" };
    writeFileSync(leasePath, JSON.stringify(replacement));
    releaseOperation.mockImplementation(actualCoordination);
    const calls = fetch.mock.calls.length;

    await expect(provider.compress("system", "user again")).rejects.toThrow("local_qwen_deferred:lease_busy");
    expect(releaseOperation).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls).toHaveLength(calls);
    expect(JSON.parse(readFileSync(leasePath, "utf8"))).toEqual(replacement);
  }), QWEN_MULTI_PROCESS_TEST_MS);

  it("cleans its pending released lease while preserving foreground intent", inFixture(async () => {
    const fetch = installFetchMock();
    releaseOperation.mockRejectedValue(Object.assign(new Error("sharing collision"), { code: "EBUSY" }));
    const provider = createProvider("auto", 2048, "http://127.0.0.1:8000");
    await expect(provider.compress("system", "user")).rejects.toThrow("local_qwen_lease_release_failed:EBUSY");
    const foregroundPath = join(coordinationDir, "foreground-request.json");
    const foreground = { pid: process.pid, token: "foreground-consumer" };
    writeFileSync(foregroundPath, JSON.stringify(foreground));
    releaseOperation.mockImplementation(actualCoordination);
    const calls = fetch.mock.calls.length;

    await expect(provider.compress("system", "user again")).rejects.toThrow("local_qwen_deferred:foreground_requested");
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
    expect(JSON.parse(readFileSync(foregroundPath, "utf8"))).toEqual(foreground);
    expect(fetch.mock.calls).toHaveLength(calls);
  }), QWEN_MULTI_PROCESS_TEST_MS);

  it("reports a stream-body transport cause and releases the lease", inFixture(async () => {
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
    const provider = createProvider("auto", 2048, "http://127.0.0.1:8000");

    await expect(provider.compress("system", "user")).rejects.toMatchObject({
      message: "local_qwen_transport_failed:UND_ERR_SOCKET:127.0.0.1:8000", cause: failure,
    });
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
  }), QWEN_PROCESS_TEST_MS);

  it("keeps streamed foreground cancellation distinct from transport failure", inFixture(async () => {
    const fetch = installFetchMock();
    const implementation = fetch.getMockImplementation()!;
    let completions = 0;
    const { promise: started, release: signalStarted } = requiredFixture().barrier();
    fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/chat/completions") && ++completions > 1) {
        return new Response(new ReadableStream({
          start(controller) {
            onAbort(init?.signal, () => {
              controller.error(new DOMException("aborted", "AbortError"));
            });
            signalStarted();
          },
        }), { headers: { "Content-Type": "text/event-stream" } });
      }
      return implementation(input, init);
    });
    const provider = createProvider("auto", 2048, "http://127.0.0.1:8000");
    const pending = provider.compress("system", "user");
    await requiredFixture().waitFor(started);
    const foreground = { pid: process.pid, token: "foreground-consumer" };
    const foregroundPath = join(coordinationDir, "foreground-request.json");
    writeFileSync(foregroundPath, JSON.stringify(foreground));

    await expect(pending).rejects.toThrow("local_qwen_deferred:foreground_requested");
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
    expect(JSON.parse(readFileSync(foregroundPath, "utf8"))).toEqual(foreground);
  }), QWEN_PROCESS_TEST_MS);

  it.each([1, 2])("cancels streamed inference at worker shutdown and releases its lease: request %s", inFixture(async (requestNumber: number) => {
    const fetch = installFetchMock();
    const implementation = fetch.getMockImplementation()!;
    let completions = 0;
    const { promise: started, release: signalStarted } = requiredFixture().barrier();
    fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/chat/completions") && ++completions === requestNumber) {
        return new Response(new ReadableStream({
          start(controller) {
            onAbort(init?.signal, () => {
              controller.error(new DOMException("aborted", "AbortError"));
            });
            signalStarted();
          },
        }), { headers: { "Content-Type": "text/event-stream" } });
      }
      return implementation(input, init);
    });
    const shutdown = new AbortController();
    const provider = createProvider("auto", 2048, "http://127.0.0.1:8000", shutdown.signal);
    const pending = provider.compress("system", "user");
    const outcome = expect(pending).rejects.toThrow("local_qwen_deferred:shutdown");
    await requiredFixture().waitFor(started);
    shutdown.abort();
    await outcome;
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
    const calls = fetch.mock.calls.length;
    await expect(provider.compress("system", "retry")).rejects.toThrow("local_qwen_deferred:shutdown");
    await expect(provider.probe()).rejects.toThrow("local_qwen_deferred:shutdown");
    expect(fetch.mock.calls).toHaveLength(calls);
  }), QWEN_PROCESS_TEST_MS);

  it("keeps stream validation failures distinct from transport failures", inFixture(async () => {
    const fetch = installFetchMock();
    const implementation = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/chat/completions")) {
        return new Response("data: {invalid-json}\n\n", { headers: { "Content-Type": "text/event-stream" } });
      }
      return implementation(input, init);
    });
    const provider = createProvider("auto", 2048, "http://127.0.0.1:8000");

    await expect(provider.compress("system", "user")).rejects.toThrow("local_qwen_invalid_stream_chunk");
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
  }), QWEN_PROCESS_TEST_MS);

  it("discovers a changed model and 262K context without an identity pin", inFixture(async () => {
    installFetchMock();
    const provider = createProvider("auto", 2048, "http://127.0.0.1:8000");

    await expect(provider.probe()).resolves.toMatchObject({
      model: "better-qwen",
      contextTokens: 262144,
      maxInputTokens: 207667,
      maxOutputTokens: 2048,
    });
  }));

  it("honors an explicit input cap without pinning the discovered context", inFixture(async () => {
    process.env.AGENTMEMORY_LOCAL_QWEN_MAX_INPUT_TOKENS = "65536";
    installFetchMock();
    const provider = createProvider("auto", 2048, "http://127.0.0.1:8000");

    await expect(provider.probe()).resolves.toMatchObject({
      contextTokens: 262144,
      maxInputTokens: 65536,
    });
  }));

  it.each(["http://localhost:8000/v1", "http://127.0.0.1:8890"])("runs the health probe and canary at the configured endpoint %s", inFixture(async (endpoint: string) => {
    const fetchMock = installFetchMock();
    const provider = createProvider("auto", 2048, endpoint);

    await expect(provider.compress("system", "user")).resolves.toContain(
      "<entities>",
    );
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/v1/chat/completions"),
      ),
    ).toHaveLength(2);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(new URL(String(url)).origin).toBe(new URL(endpoint).origin);
      expect(options?.redirect).toBe("error");
    }
    expect(provider.getRuntimeInfo()).toMatchObject({
      model: "better-qwen",
      contextTokens: 262144,
    });
  }), QWEN_PROCESS_TEST_MS);

  it("reports a hard output cutoff instead of returning partial XML for repair", inFixture(async () => {
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
    const provider = createProvider("auto", 2048, "http://127.0.0.1:8000");

    await expect(provider.compress("system", "user")).rejects.toThrow(
      "local_qwen_output_truncated:2048",
    );
    expect(completionCount).toBe(2);
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
  }), QWEN_PROCESS_TEST_MS);

  it("fails closed when a streamed completion ends without DONE", inFixture(async () => {
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
    const provider = createProvider("auto", 2048, "http://127.0.0.1:8000");

    await expect(provider.compress("system", "user")).rejects.toThrow(
      "local_qwen_stream_incomplete",
    );
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
  }), QWEN_PROCESS_TEST_MS);

  it("rejects non-loopback endpoints before making a request", inFixture(() => {
    expect(
      () => createProvider("auto", 2048, "https://example.com/v1"),
    ).toThrow(/loopback HTTP/);
  }));

  it("defers without calling Qwen while a foreground request is active", inFixture(async () => {
    const fetchMock = installFetchMock();
    writeFileSync(
      join(coordinationDir, "foreground-request.json"),
      JSON.stringify({ pid: process.pid }),
      "utf8",
    );
    const provider = createProvider("auto", 2048, "http://127.0.0.1:8000");

    await expect(provider.compress("system", "user")).rejects.toThrow(
      "local_qwen_deferred:foreground_requested",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  }), QWEN_PROCESS_TEST_MS);

  it("ships the Windows graph budget proven against a real completed response", inFixture(() => {
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
  }));

  it("aborts an in-flight background generation when Swarm publishes foreground intent", inFixture(async () => {
    let completionCount = 0;
    const { promise: started, release: generationStarted } = requiredFixture().barrier();
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
          onAbort(init?.signal, () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const provider = createProvider("auto", 2048, "http://127.0.0.1:8000");
    const pending = provider.compress("system", "user");
    await requiredFixture().waitFor(started);
    writeFileSync(
      join(coordinationDir, "foreground-request.json"),
      JSON.stringify({ pid: process.pid }),
      "utf8",
    );

    await expect(pending).rejects.toThrow("local_qwen_deferred:foreground_requested");
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
  }), QWEN_PROCESS_TEST_MS);
  it.each(["write-before", "partial-write", "close"])("dot F3 acquisition failure %s leaves no busy lease and permits retry", inFixture(async (mode: string) => {
    const fetch=installFetchMock();
    const actual=await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementationOnce(async(...args)=>{
      const handle=await actual.open(...args);
      return new Proxy(handle,{get(target,key){
        if(key==="writeFile"&&mode!=="close")return async(data:string)=>{if(mode==="partial-write")await target.writeFile(data.slice(0,8));throw Object.assign(Error("acquisition write failed"),{code:"ENOSPC"});};
        if(key==="close"&&mode==="close")return async()=>{await target.close();throw Object.assign(Error("acquisition close failed"),{code:"EIO"});};
        const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
      }});
    });
    const provider=createProvider("auto",2048,"http://127.0.0.1:8000");
    await expect(provider.compress("system","user")).rejects.toThrow(mode==="close"?"acquisition close failed":"acquisition write failed");
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(join(coordinationDir,"qwen-use.lock"))).toBe(false);
    await expect(createProvider("auto",2048,"http://127.0.0.1:8000").compress("system","retry")).resolves.toContain("<entities>");
  }), QWEN_MULTI_PROCESS_TEST_MS);

  it("dot F3 keeps a public lease published by a competing owner", inFixture(async () => {
    const fetch=installFetchMock(),lease=join(coordinationDir,"qwen-use.lock");
    const replacement={owner:"qwen-foreground",pid:process.pid,token:"replacement-owner"};
    publicationOperation.mockImplementationOnce(async()=>{writeFileSync(lease,JSON.stringify(replacement));throw Object.assign(Error("competing lease"),{code:"EEXIST"});});
    await expect(createProvider("auto",2048,"http://127.0.0.1:8000").compress("system","user")).rejects.toThrow("local_qwen_deferred:lease_busy");
    expect(JSON.parse(readFileSync(lease,"utf8"))).toEqual(replacement);expect(fetch).not.toHaveBeenCalled();
  }), QWEN_PROCESS_TEST_MS);
  it("dot F3 preserves a replacement prepared file and does not publish it", inFixture(async () => {
    const fetch=installFetchMock();const actual=await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");let replaced="";
    vi.mocked(open).mockImplementationOnce(async(...args)=>{const handle=await actual.open(...args);replaced=String(args[0]);return new Proxy(handle,{get(target,key){if(key==="close")return async()=>{await target.close();await actual.rename(replaced,replaced+".original");writeFileSync(replaced,'{"owner":"another"}');};const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;}});});
    await expect(createProvider("auto",2048,"http://127.0.0.1:8000").compress("system","user")).rejects.toThrow("local_qwen_lease_prepare_replaced");
    expect(readFileSync(replaced,"utf8")).toBe('{"owner":"another"}');expect(existsSync(join(coordinationDir,"qwen-use.lock"))).toBe(false);expect(fetch).not.toHaveBeenCalled();
  }), QWEN_PROCESS_TEST_MS);
  it("dot F3 prepared cleanup failure releases its published lease and permits retry",inFixture(async()=>{
    installFetchMock();vi.mocked(rm).mockRejectedValueOnce(Object.assign(Error("prepared cleanup failed"),{code:"EPERM"}));
    const provider=createProvider("auto",2048,"http://127.0.0.1:8000");await expect(provider.compress("system","user")).rejects.toThrow("prepared cleanup failed");expect(existsSync(join(coordinationDir,"qwen-use.lock"))).toBe(false);
    await expect(provider.compress("system","retry")).resolves.toContain("<entities>");
  }), QWEN_MULTI_PROCESS_TEST_MS);

  it("allows a real published lease to settle beyond the former five-second test budget", inFixture(async () => {
    installFetchMock();
    publicationOperation.mockImplementationOnce(async request => {
      const result = await actualCoordination(request);
      await new Promise(resolve => setTimeout(resolve, 5_100));
      return result;
    });
    const start = performance.now();
    await expect(createProvider("auto", 2048, "http://127.0.0.1:8000").compress("system", "delayed"))
      .resolves.toContain("<entities>");
    expect(performance.now() - start).toBeGreaterThanOrEqual(5_100);
    expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(false);
  }), QWEN_PROCESS_TEST_MS);

  for (const mode of ["timeout", "assertion"]) {
    describe(`abandoned request ${mode}`, { concurrent: false, shuffle: false }, () => {
      let previous: {
        scope: QwenTestScope;
        dir: string;
        fetch: Mock<typeof globalThis.fetch>;
        calls: number;
        bodySettled: () => boolean;
        requestOutcome: Promise<unknown>;
        bodyOutcome: Promise<unknown>;
      } | undefined;

      it("returns with abandoned work registered for the real afterEach", inFixture(async () => {
        const scope = requiredFixture();
        const fetch = installFetchMock();
        const published = scope.barrier();
        const held = scope.barrier();
        publicationOperation.mockImplementationOnce(async request => {
          const result = await actualCoordination(request);
          published.release();
          await held.promise;
          return result;
        });
        let bodySettled = false;
        let requestOutcome!: Promise<unknown>;
        const body = scope.run("abandoned inner body", async () => {
          try {
            const pending = createProvider("auto", 2048, "http://127.0.0.1:8000").compress("system", "abandoned");
            requestOutcome = pending.catch(error => error);
            await scope.waitFor(published.promise);
            if (mode === "assertion") throw Error("synthetic assertion failure");
            await pending;
          } finally {
            bodySettled = true;
          }
        });
        const bodyOutcome = body.catch(error => error);
        await scope.waitFor(published.promise);
        if (mode === "timeout") {
          // Returning from the runner's deadline is not termination of body.
          const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(Error("synthetic runner timeout")), 1));
          await expect(Promise.race([body, deadline])).rejects.toThrow("synthetic runner timeout");
          expect(bodySettled).toBe(false);
        } else {
          await expect(bodyOutcome).resolves.toMatchObject({ message: "synthetic assertion failure" });
        }
        expect(existsSync(join(coordinationDir, "qwen-use.lock"))).toBe(true);
        previous = { scope, dir: coordinationDir, fetch, calls: fetch.mock.calls.length,
          bodySettled: () => bodySettled, requestOutcome, bodyOutcome };
        // Only the actual afterEach closes this fixture. The next sequential
        // test verifies its outcome before exercising a fresh canary.
      }), QWEN_PROCESS_TEST_MS);

      it("verifies actual afterEach completion and the following fixture's independent response", inFixture(async () => {
        expect(previous).toBeDefined();
        const prior = previous!;
        prior.scope.assertClosed();
        expect(prior.bodySettled()).toBe(true);
        expect(existsSync(prior.dir)).toBe(false);
        await expect(prior.requestOutcome).resolves.toMatchObject({ message: "local_qwen_deferred:shutdown" });
        await expect(prior.bodyOutcome).resolves.toMatchObject({
          message: mode === "timeout" ? "local_qwen_deferred:shutdown" : "synthetic assertion failure",
        });
        const fetch = installFetchMock();
        await expect(createProvider("auto", 2048, "http://127.0.0.1:8000").compress("system", "next fixture"))
          .resolves.toContain("<entities>");
        expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/chat/completions"))).toHaveLength(2);
        expect(prior.fetch.mock.calls).toHaveLength(prior.calls);
      }), QWEN_PROCESS_TEST_MS);
    });
  }
});
