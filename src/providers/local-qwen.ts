import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type {
  MemoryProvider,
  ProviderRuntimeInfo,
} from "../types.js";
import { getEnvVar } from "../config.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MIN_CONTEXT_TOKENS = 8_192;
const PROBE_TIMEOUT_MS = 3_000;
const FOREGROUND_POLL_MS = 250;

interface LeaseRecord {
  owner: "agentmemory-background" | "qwen-foreground";
  pid: number;
  processStartUtc: string;
  token: string;
  createdAtUtc: string;
}

interface LocalQwenDiscovery {
  info: ProviderRuntimeInfo;
  slotsIdle: boolean;
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

function processStartUtc(): string {
  return new Date(Date.now() - process.uptime() * 1000).toISOString();
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

async function fetchJson(
  url: string,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
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
      await unlink(path).catch(() => {});
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

  constructor(model: string, maxTokens: number, baseURL?: string) {
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

  async probe(): Promise<ProviderRuntimeInfo> {
    return (await this.discover()).info;
  }

  async compress(systemPrompt: string, userPrompt: string): Promise<string> {
    const release = await this.acquireBackgroundLease();
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
    } finally {
      await release();
    }
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.compress(systemPrompt, userPrompt);
  }

  private async discover(): Promise<LocalQwenDiscovery> {
    const [healthRaw, propsRaw, modelsRaw, slotsRaw] = await Promise.all([
      fetchJson(endpoint(this.baseUrl, "/health"), PROBE_TIMEOUT_MS),
      fetchJson(endpoint(this.baseUrl, "/props"), PROBE_TIMEOUT_MS),
      fetchJson(v1Endpoint(this.baseUrl, "/models"), PROBE_TIMEOUT_MS),
      fetchJson(endpoint(this.baseUrl, "/slots"), PROBE_TIMEOUT_MS),
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
      const response = await fetch(v1Endpoint(this.baseUrl, "/chat/completions"), {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: info.model,
          max_tokens: maxTokens,
          temperature: 0,
          stream: false,
          reasoning_effort: "none",
          chat_template_kwargs: { enable_thinking: false },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 1000);
        throw new Error(`local_qwen_http_${response.status}:${detail}`);
      }
      const data = (await response.json()) as {
        choices?: Array<{
          message?: {
            content?: string;
            reasoning?: string;
            reasoning_content?: string;
          };
        }>;
      };
      const message = data.choices?.[0]?.message;
      const content =
        message?.content ?? message?.reasoning_content ?? message?.reasoning;
      if (!content?.trim()) throw new Error("local_qwen_empty_response");
      return content;
    } catch (error) {
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
    const foregroundPath = join(this.coordinationDir, "foreground-request.json");
    if (await activeMarker(foregroundPath)) {
      throw new Error("local_qwen_deferred:foreground_requested");
    }
    const leasePath = join(this.coordinationDir, "qwen-use.lock");
    const token = crypto.randomUUID();
    const record: LeaseRecord = {
      owner: "agentmemory-background",
      pid: process.pid,
      processStartUtc: processStartUtc(),
      token,
      createdAtUtc: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(leasePath, "wx");
        try {
          await handle.writeFile(JSON.stringify(record), "utf8");
        } finally {
          await handle.close();
        }
        if (await activeMarker(foregroundPath)) {
          await this.releaseLease(leasePath, token);
          throw new Error("local_qwen_deferred:foreground_requested");
        }
        return () => this.releaseLease(leasePath, token);
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

  private async releaseLease(path: string, token: string): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
      if (parsed.token === token) await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
