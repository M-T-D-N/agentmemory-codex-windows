import { describe, expect, it, vi } from "vitest";
import { StateKV } from "../src/state/kv.js";

describe("bounded StateModule pages", () => {
  it("reads actual keys and does not replace a missing page surface with full enumeration", async () => {
    const response = { entries: [{ key: "stored-key", value: { id: "different-value-id" } }], total: 2, next_offset: 1 };
    const trigger = vi.fn().mockResolvedValue(response);
    const kv = new StateKV({ trigger } as never, { requireDurability: true });
    expect(kv.usesManagedState).toBe(true);
    expect(await kv.listPage("scope")).toEqual(response);
    expect(trigger).toHaveBeenCalledExactlyOnceWith({ function_id: "state::list_page", payload: { scope: "scope", offset: 0, limit: 128 } });
    trigger.mockRejectedValueOnce(new Error("Unknown function: state::list_page"));
    await expect(kv.listPage("scope", 1)).rejects.toThrow("Unknown function");
    expect(trigger.mock.calls.every(([request]) => request.function_id === "state::list_page")).toBe(true);
  });

  it("preserves native pagination when deleted observations are hidden", async () => {
    const trigger = vi.fn().mockResolvedValue({ entries: [{ key: "hidden", value: { emptyDeletion: { state: "deleted" } } }], total: 2, next_offset: 1 });
    const kv = new StateKV({ trigger } as never);
    expect(await kv.listPage("mem:obs:session")).toEqual({ entries: [], total: 2, next_offset: 1 });
    expect((await kv.listPage("mem:obs:session", 0, { includeDeleted: true })).entries).toHaveLength(1);
  });

  it.each([
    null, {}, { entries: [], total: 1, next_offset: 0 },
    { entries: [], total: 1, next_offset: null },
    { entries: [{ key: "key", value: null }], total: 1, next_offset: 1 },
    { entries: [{ key: "key" }], total: 1, next_offset: null },
    { entries: [{ key: 1, value: null }], total: 1, next_offset: null },
    { entries: [{ key: "key", value: null }, { key: "key", value: null }], total: 2, next_offset: null },
    { entries: [], total: -1, next_offset: null },
  ])("rejects invalid page %j", async response => {
    const trigger = vi.fn().mockResolvedValue(response);
    await expect(new StateKV({ trigger } as never).listPage("scope")).rejects.toThrow("Invalid state::list_page response");
  });

  it("rejects oversized payloads and checks graph recovery before reading", async () => {
    const trigger = vi.fn().mockResolvedValue({ entries: [{ key: "k", value: "x".repeat(1_048_576) }], total: 1, next_offset: null });
    await expect(new StateKV({ trigger } as never).listPage("scope")).rejects.toThrow("page exceeds");
    trigger.mockReset().mockRejectedValue(new Error("pending recovery unavailable"));
    await expect(new StateKV({ trigger } as never).listPage("mem:graph:nodes")).rejects.toThrow("pending recovery unavailable");
    expect(trigger).toHaveBeenCalledExactlyOnceWith({ function_id: "state::get", payload: { scope: "mem:graph:write-plan", key: "current" } });
  });

  it("accepts empty terminal pages and rejects invalid offsets before RPC", async () => {
    const trigger = vi.fn().mockResolvedValue({ entries: [], total: 3, next_offset: null });
    const kv = new StateKV({ trigger } as never);
    expect(await kv.listPage("scope", 3)).toEqual({ entries: [], total: 3, next_offset: null });
    trigger.mockClear();
    await expect(kv.listPage("scope", -1)).rejects.toThrow("offset");
    expect(trigger).not.toHaveBeenCalled();
  });
});
