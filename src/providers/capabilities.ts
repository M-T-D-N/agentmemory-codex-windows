import type { MemoryProvider } from "../types.js";

export function isNoopProvider(
  provider: Pick<MemoryProvider, "name">,
): boolean {
  return provider.name === "noop" || provider.name === "resilient(noop)";
}
