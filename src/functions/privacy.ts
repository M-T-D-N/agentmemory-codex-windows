import type { IIIClient } from "iii-sdk";

import { stripPrivateData } from "../../packaging/windows-codex/hooks/codex-privacy.mjs";
export { stripPrivateData } from "../../packaging/windows-codex/hooks/codex-privacy.mjs";

export function scrubRecord<T>(value: T): T {
  if (typeof value === "string") return stripPrivateData(value) as T;
  if (Array.isArray(value)) return value.map((item) => scrubRecord(item)) as T;
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubRecord(item);
    }
    return out as T;
  }
  return value;
}

export const SCRUBBED_WRITE_FUNCTIONS: ReadonlySet<string> = new Set([
  "mem::remember",
  "mem::evolve",
  "mem::slot-create",
  "mem::slot-append",
  "mem::slot-replace",
  "mem::lesson-save",
  "mem::action-create",
  "mem::action-update",
  "mem::sketch-create",
  "mem::sketch-add",
  "mem::import",
  "mem::mesh-receive",
  "mem::team-share",
  "mem::signal-send",
  "mem::routine-create",
  "mem::checkpoint-create",
  "mem::checkpoint-resolve",
  "mem::sentinel-create",
  "mem::sentinel-trigger",
  "mem::core-add",
  "mem::facet-tag",
]);

type RegisterFunction = (id: string, handler: unknown, ...rest: unknown[]) => unknown;

export function withWriteScrubbing<T extends object>(sdk: T): T {
  return new Proxy(sdk, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (prop !== "registerFunction") return value.bind(target);
      const register = value as RegisterFunction;
      return (id: string, handler: unknown, ...rest: unknown[]) => {
        if (!SCRUBBED_WRITE_FUNCTIONS.has(id) || typeof handler !== "function") {
          return register.call(target, id, handler, ...rest);
        }
        const original = handler as (data: unknown, ...args: unknown[]) => unknown;
        const scrubbed = (data: unknown, ...args: unknown[]) => original(scrubRecord(data), ...args);
        return register.call(target, id, scrubbed, ...rest);
      };
    },
  });
}

export function registerPrivacyFunction(sdk: IIIClient): void {
  sdk.registerFunction("mem::privacy", 
    async (data: { input?: unknown } | undefined) => {
      if (!data || typeof data.input !== "string") {
        return { output: "", error: "invalid input: expected string field 'input'" };
      }
      return { output: stripPrivateData(data.input) };
    },
  );
}
