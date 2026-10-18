import { invokeQwenCoordination } from "./local-qwen-coordination.js";
import { mkdir, open, readFile, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  MemoryProvider,
  ProviderRuntimeInfo,
} from "../types.js";
import { getEnvVar } from "../config.js";
import { localQwenBackgroundDeferral } from "./local-qwen-lifecycle.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MIN_CONTEXT_TOKENS = 8_192;
const PROBE_TIMEOUT_MS = 3_000;
const FOREGROUND_POLL_MS = 250;
const LEASE_RELEASE_ATTEMPTS = 3;
const LEASE_RELEASE_RETRY_MS = 50;

interface LeaseRecord {
  owner: "agentmemory-background" | "qwen-foreground";
  pid: number;
  processStartUtc: string;
  started_filetime_utc: string;
  token: string;
  createdAtUtc: string;
}

interface LocalQwenDiscovery {
  info: ProviderRuntimeInfo;
  slotsIdle: boolean;
}

interface ChatCompletionChoice {
  finish_reason?: string | null;
  delta?: {
    content?: string;
    reasoning?: string;
    reasoning_content?: string;
  };
  message?: {
    content?: string;
    reasoning?: string;
    reasoning_content?: string;
  };
}

function choiceContent(choice: ChatCompletionChoice | undefined): string {
  return (
    choice?.delta?.content ??
    choice?.delta?.reasoning_content ??
    choice?.delta?.reasoning ??
    choice?.message?.content ??
    choice?.message?.reasoning_content ??
    choice?.message?.reasoning ??
    ""
  );
}

async function streamingChatContent(
  response: Response,
  maxTokens: number,
  url: string,
): Promise<string> {
  if (!response.body) throw new Error("local_qwen_empty_stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let content = "";
  let finishReason: string | null = null;
  let completed = false;

  const consumeLine = (rawLine: string): void => {
    const line = rawLine.trim();
    if (!line || line.startsWith(":")) return;
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") { completed = true; return; }
    let parsed: { choices?: ChatCompletionChoice[] };
    try {
      parsed = JSON.parse(data) as { choices?: ChatCompletionChoice[] };
    } catch {
      throw new Error("local_qwen_invalid_stream_chunk");
    }
    const choice = parsed.choices?.[0];
    content += choiceContent(choice);
    if (typeof choice?.finish_reason === "string") {
      finishReason = choice.finish_reason;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read().catch((error) => {
        throw localQwenTransportError(error, url);
      });
      buffered += decoder.decode(value, { stream: !done });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
      if (done) break;
    }
    if (buffered) consumeLine(buffered);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (finishReason === "length") {
    throw new Error(`local_qwen_output_truncated:${maxTokens}`);
  }
  if (!completed) throw new Error("local_qwen_stream_incomplete");
  return content;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || !/^\d+$/.test(raw.trim())) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalPositiveInt(raw: string | undefined): number | null {
  if (!raw || raw.trim().toLowerCase() === "auto") return null;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error("AGENTMEMORY_LOCAL_QWEN_MAX_INPUT_TOKENS must be auto or a positive integer");
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("AGENTMEMORY_LOCAL_QWEN_MAX_INPUT_TOKENS must be auto or a positive integer");
  }
  return parsed;
}

function loopbackBaseUrl(raw: string): URL {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(host) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "local_qwen_invalid_base_url: only credential-free loopback HTTP URLs are allowed",
    );
  }
  return url;
}

function endpoint(base: URL, route: string): string {
  const url = new URL(base.toString());
  const current = url.pathname.replace(/\/+$/, "");
  const root = current.endsWith("/v1") ? current.slice(0, -3) : current;
  url.pathname = `${root}${route.startsWith("/") ? route : `/${route}`}`;
  return url.toString();
}

function v1Endpoint(base: URL, route: string): string {
  const url = new URL(base.toString());
  const current = url.pathname.replace(/\/+$/, "");
  const root = current.endsWith("/v1") ? current : `${current}/v1`;
  url.pathname = `${root}${route.startsWith("/") ? route : `/${route}`}`;
  return url.toString();
}

function localQwenTransportError(error: unknown, url: string): Error {
  if (error instanceof Error && error.name === "AbortError") return error;
  const detail = objectValue(error);
  const cause = objectValue(detail?.cause);
  const rawCode = cause?.code ?? detail?.code;
  const code = typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(rawCode)
    ? rawCode
    : error instanceof Error && error.name === "TimeoutError" ? "TIMEOUT" : "UNKNOWN";
  return new Error("local_qwen_transport_failed:" + code + ":" + new URL(url).host, { cause: error });
}

function requestAndCleanupError(requestError: unknown, cleanupError: unknown): AggregateError {
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  return new AggregateError([requestError, cleanupError],
    "local_qwen_request_and_lease_release_failed:" + message(requestError) + "; " + message(cleanupError),
    { cause: requestError });
}

async function fetchLocalQwen(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw localQwenTransportError(error, url);
  }
}

async function fetchJson(
  url: string,
  timeoutMs: number,
  shutdownSignal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchLocalQwen(url, {
    method: "GET",
    redirect: "error",
    signal: shutdownSignal
      ? AbortSignal.any([shutdownSignal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`local_qwen_probe_http_${response.status}`);
  }
  return response.json();
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

async function activeMarker(path: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    if (typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid)) {
      return true;
    }
    try {
      process.kill(parsed.pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") return true;
      // Read-only foreground polling never reclaims a marker.
      return false;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ENOENT";
  }
}

export class LocalQwenProvider implements MemoryProvider {
  readonly name = "local-qwen";
  private readonly baseUrl: URL;
  private readonly configuredModel: string;
  private readonly maxOutputTokens: number;
  private readonly maxInputCap: number | null;
  private readonly minContextTokens: number;
  private readonly timeoutMs: number;
  private readonly coordinationDir: string;
  private runtimeInfo: ProviderRuntimeInfo | null = null;
  private validatedFingerprint: string | null = null;
  private pendingLeaseRelease: LeaseRecord | null = null;
  private pendingLeaseRecovery: Promise<void> | null = null;

  constructor(
    model: string,
    maxTokens: number,
    baseURL?: string,
    private readonly shutdownSignal?: AbortSignal,
  ) {
    this.baseUrl = loopbackBaseUrl(
      baseURL ||
        getEnvVar("AGENTMEMORY_LOCAL_QWEN_BASE_URL") ||
        "http://127.0.0.1:8000",
    );
    this.configuredModel = model.trim() || "auto";
    this.maxOutputTokens = positiveInt(
      getEnvVar("AGENTMEMORY_LOCAL_QWEN_MAX_OUTPUT_TOKENS"),
      maxTokens > 0 ? maxTokens : 2048,
    );
    this.maxInputCap = optionalPositiveInt(
      getEnvVar("AGENTMEMORY_LOCAL_QWEN_MAX_INPUT_TOKENS"),
    );
    this.minContextTokens = positiveInt(
      getEnvVar("AGENTMEMORY_LOCAL_QWEN_MIN_CONTEXT_TOKENS"),
      DEFAULT_MIN_CONTEXT_TOKENS,
    );
    this.timeoutMs = positiveInt(
      getEnvVar("AGENTMEMORY_LOCAL_QWEN_TIMEOUT_MS"),
      DEFAULT_TIMEOUT_MS,
    );
    this.coordinationDir =
      getEnvVar("AGENTMEMORY_LOCAL_QWEN_COORDINATION_DIR") || "";
    if (!this.coordinationDir) {
      throw new Error(
        "AGENTMEMORY_LOCAL_QWEN_COORDINATION_DIR is required for foreground priority protection",
      );
    }
  }

  getRuntimeInfo(): ProviderRuntimeInfo | null {
    return this.runtimeInfo ? { ...this.runtimeInfo } : null;
  }

  private assertBackgroundAllowed(): void {
    if (this.shutdownSignal?.aborted) throw new Error("local_qwen_deferred:shutdown");
    const reason = localQwenBackgroundDeferral();
    if (reason) throw new Error(`local_qwen_deferred:${reason}`);
  }

  async probe(): Promise<ProviderRuntimeInfo> {
    this.assertBackgroundAllowed();
    return (await this.discover()).info;
  }

  async compress(systemPrompt: string, userPrompt: string): Promise<string> {
    this.assertBackgroundAllowed();
    const release = await this.acquireBackgroundLease();
    let requestFailed = false;
    let requestError: unknown;
    try {
      const discovered = await this.discover();
      if (!discovered.slotsIdle) {
        throw new Error("local_qwen_deferred:slot_busy");
      }
      if (this.validatedFingerprint !== discovered.info.fingerprint) {
        const canary = await this.request(
          "Return only the requested XML. <|think_off|>",
          "Return exactly <ok>LOCAL_QWEN_OK</ok>.",
          32,
          discovered.info,
        );
        if (!/<ok>\s*LOCAL_QWEN_OK\s*<\/ok>/i.test(canary)) {
          throw new Error("local_qwen_canary_failed");
        }
        this.validatedFingerprint = discovered.info.fingerprint;
      }
      const estimatedInputTokens = Math.ceil(
        (systemPrompt.length + userPrompt.length) / 4,
      );
      if (estimatedInputTokens > discovered.info.maxInputTokens) {
        throw new Error(
          `local_qwen_input_too_large:${estimatedInputTokens}>${discovered.info.maxInputTokens}`,
        );
      }
      return await this.request(
        systemPrompt,
        userPrompt,
        this.maxOutputTokens,
        discovered.info,
      );
    } catch (error) {
      requestFailed = true;
      requestError = error;
      throw error;
    } finally {
      try {
        await release();
      } catch (cleanupError) {
        if (requestFailed) throw requestAndCleanupError(requestError, cleanupError);
        throw cleanupError;
      }
    }
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.compress(systemPrompt, userPrompt);
  }

  private async discover(): Promise<LocalQwenDiscovery> {
    this.assertBackgroundAllowed();
    const [healthRaw, propsRaw, modelsRaw, slotsRaw] = await Promise.all([
      fetchJson(endpoint(this.baseUrl, "/health"), PROBE_TIMEOUT_MS, this.shutdownSignal),
      fetchJson(endpoint(this.baseUrl, "/props"), PROBE_TIMEOUT_MS, this.shutdownSignal),
      fetchJson(v1Endpoint(this.baseUrl, "/models"), PROBE_TIMEOUT_MS, this.shutdownSignal),
      fetchJson(endpoint(this.baseUrl, "/slots"), PROBE_TIMEOUT_MS, this.shutdownSignal),
    ]);
    const health = objectValue(healthRaw);
    if (health?.status !== "ok") throw new Error("local_qwen_unhealthy");
    const props = objectValue(propsRaw) ?? {};
    const settings = objectValue(props.default_generation_settings) ?? {};
    const modelData = objectValue(modelsRaw)?.data;
    const models = Array.isArray(modelData)
      ? modelData.map(objectValue).filter((item): item is Record<string, unknown> => item !== null)
      : [];
    const firstModel = models[0] ?? {};
    const firstMeta = objectValue(firstModel.meta) ?? {};
    const slots = Array.isArray(slotsRaw)
      ? slotsRaw.map(objectValue).filter((item): item is Record<string, unknown> => item !== null)
      : [];
    const contextTokens = numberValue(
      settings.n_ctx,
      firstMeta.n_ctx,
      slots[0]?.n_ctx,
    );
    if (!contextTokens || contextTokens < this.minContextTokens) {
      throw new Error(
        `local_qwen_context_insufficient:${contextTokens ?? "unknown"}<${this.minContextTokens}`,
      );
    }
    const discoveredModel = stringValue(props.model_alias, firstModel.id);
    const model =
      this.configuredModel.toLowerCase() === "auto"
        ? discoveredModel
        : this.configuredModel;
    if (!model) throw new Error("local_qwen_model_not_discovered");
    const build = stringValue(props.build_info);
    const available = Math.floor(contextTokens * 0.8) - this.maxOutputTokens;
    if (available < 1024) throw new Error("local_qwen_context_budget_exhausted");
    const maxInputTokens = this.maxInputCap === null
      ? available
      : Math.min(this.maxInputCap, available);
    const fingerprint = [model, contextTokens, build ?? "unknown"].join("|");
    const info: ProviderRuntimeInfo = {
      provider: this.name,
      model,
      contextTokens,
      maxInputTokens,
      maxOutputTokens: this.maxOutputTokens,
      fingerprint,
      ...(build ? { build } : {}),
    };
    this.runtimeInfo = info;
    return {
      info,
      slotsIdle: slots.length > 0 && slots.every((slot) => slot.is_processing === false),
    };
  }

  private async request(
    systemPrompt: string,
    userPrompt: string,
    maxTokens: number,
    info: ProviderRuntimeInfo,
  ): Promise<string> {
    this.assertBackgroundAllowed();
    const foregroundPath = join(this.coordinationDir, "foreground-request.json");
    if (await activeMarker(foregroundPath)) {
      throw new Error("local_qwen_deferred:foreground_requested");
    }
    const controller = new AbortController();
    let foregroundRequested = false;
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const poll = setInterval(() => {
      void activeMarker(foregroundPath).then((active) => {
        if (active) {
          foregroundRequested = true;
          controller.abort();
        }
      });
    }, FOREGROUND_POLL_MS);
    poll.unref();
    try {
      const response = await fetchLocalQwen(v1Endpoint(this.baseUrl, "/chat/completions"), {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: info.model,
          max_tokens: maxTokens,
          temperature: 0,
          stream: true,
          reasoning_effort: "none",
          chat_template_kwargs: { enable_thinking: false },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
        signal: this.shutdownSignal
          ? AbortSignal.any([controller.signal, this.shutdownSignal])
          : controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 1000);
        throw new Error(`local_qwen_http_${response.status}:${detail}`);
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      let content: string;
      if (contentType.includes("text/event-stream")) {
        content = await streamingChatContent(response, maxTokens, v1Endpoint(this.baseUrl, "/chat/completions"));
      } else {
        const choice = (
          (await response.json()) as { choices?: ChatCompletionChoice[] }
        ).choices?.[0];
        if (choice?.finish_reason === "length") {
          throw new Error(`local_qwen_output_truncated:${maxTokens}`);
        }
        content = choiceContent(choice);
      }
      if (!content?.trim()) throw new Error("local_qwen_empty_response");
      this.assertBackgroundAllowed();
      return content;
    } catch (error) {
      if (this.shutdownSignal?.aborted) throw new Error("local_qwen_deferred:shutdown");
      if (foregroundRequested) {
        throw new Error("local_qwen_deferred:foreground_requested");
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`local_qwen_timeout:${this.timeoutMs}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      clearInterval(poll);
    }
  }

  private async acquireBackgroundLease(): Promise<() => Promise<void>> {
    await mkdir(this.coordinationDir, { recursive: true });
    const leasePath = join(this.coordinationDir, "qwen-use.lock");
    if (this.pendingLeaseRelease) await this.retryPendingLease(leasePath);
    const foregroundPath = join(this.coordinationDir, "foreground-request.json");
    const identity = (await invokeQwenCoordination({ operation: "identity", pid: process.pid })).identity;
    const token = crypto.randomUUID();
    const record: LeaseRecord = {
      owner: "agentmemory-background",
      pid: process.pid,
      processStartUtc: identity.processStartUtc,
      started_filetime_utc: identity.started_filetime_utc,
      token,
      createdAtUtc: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.publishBackgroundLease(leasePath, record);
        if (await activeMarker(foregroundPath)) {
          const deferred = new Error("local_qwen_deferred:foreground_requested");
          try {
            await this.releaseLease(leasePath, record);
          } catch (cleanupError) {
            throw requestAndCleanupError(deferred, cleanupError);
          }
          throw deferred;
        }
        return () => this.releaseLease(leasePath, record);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        if (await activeMarker(leasePath)) {
          throw new Error("local_qwen_deferred:lease_busy");
        }
      }
    }
    throw new Error("local_qwen_deferred:lease_busy");
  }

  private async publishBackgroundLease(path: string, record: LeaseRecord): Promise<void> {
    const candidate = `${path}.pending-${record.token}`;
    const bytes = JSON.stringify(record);
    const handle = await open(candidate, "wx");
    let identity: import("node:fs").Stats | undefined;
    let published = false;
    try {
      try {
        try {
          identity = await handle.stat();
          await handle.writeFile(bytes, "utf8");
        } finally {
          await handle.close();
        }
        const prepared = await lstat(candidate);
        if (!prepared.isFile() || prepared.ino !== identity!.ino || prepared.dev !== identity!.dev ||
            prepared.birthtimeMs !== identity!.birthtimeMs || await readFile(candidate, "utf8") !== bytes) {
          throw new Error("local_qwen_lease_prepare_replaced");
        }
        published = true;
        await invokeQwenCoordination({ operation: "publish", directory: this.coordinationDir, record, recordBytes: bytes });
        const installed = await lstat(path);
        if (installed.ino !== identity!.ino || installed.dev !== identity!.dev || await readFile(path, "utf8") !== bytes) {
          throw new Error("local_qwen_lease_prepare_replaced");
        }
      } finally {
        if (identity) {
          const current = await lstat(candidate).catch(error => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          });
          if (current?.isFile() && current.ino === identity.ino && current.dev === identity.dev &&
              current.birthtimeMs === identity.birthtimeMs && bytes.startsWith(await readFile(candidate, "utf8"))) {
            await rm(candidate);
          }
        }
      }
    } catch (error) {
      if (published && !(error as { notPublished?: boolean }).notPublished) {
        try { await this.releaseLease(path, record); }
        catch (cleanupError) { throw requestAndCleanupError(error, cleanupError); }
      }
      throw error;
    }
  }

  private async retryPendingLease(path: string): Promise<void> {
    if (!this.pendingLeaseRelease) return;
    const recovery = this.pendingLeaseRecovery ?? this.releaseLease(path, this.pendingLeaseRelease);
    this.pendingLeaseRecovery = recovery;
    try {
      await recovery;
    } finally {
      if (this.pendingLeaseRecovery === recovery) this.pendingLeaseRecovery = null;
    }
  }

  private async releaseLease(path: string, record: LeaseRecord): Promise<void> {
    if (path !== join(this.coordinationDir, "qwen-use.lock")) throw Error("local_qwen_lease_invalid_path");
    const clearPending = () => {
      if (this.pendingLeaseRelease?.token === record.token) this.pendingLeaseRelease = null;
    };
    for (let attempt = 0; attempt < LEASE_RELEASE_ATTEMPTS; attempt++) {
      try {
        await invokeQwenCoordination({ operation: "release", directory: this.coordinationDir, record });
        clearPending();
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          clearPending();
          return;
        }
        if ((code === "EBUSY" || code === "EPERM") && attempt + 1 < LEASE_RELEASE_ATTEMPTS) {
          await delay(LEASE_RELEASE_RETRY_MS);
          continue;
        }
        this.pendingLeaseRelease = record;
        throw new Error("local_qwen_lease_release_failed:" + (code ?? "UNKNOWN"), { cause: error });
      }
    }
  }
}
