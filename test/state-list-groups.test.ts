import { describe, expect, it, vi } from "vitest";
import { StateKV } from "../src/state/kv.js";
describe("official state scope enumeration", () => {
  it("forwards the official input and preserves exact scope strings", async () => {
    const trigger = vi.fn().mockResolvedValue({ groups: ["mem:obs:legacy", "mem:enriched:orphan", "mem:obs:legacy"] });
    expect(await new StateKV({ trigger } as never).listGroups()).toEqual(["mem:obs:legacy", "mem:enriched:orphan"]);
    expect(trigger).toHaveBeenCalledWith({ function_id: "state::list_groups", payload: {} });
  });
  it.each([null, {}, { groups: null }, { groups: [42] }, { groups: [""] }])("rejects malformed enumeration %j", async (response) => {
    const trigger = vi.fn().mockResolvedValue(response);
    await expect(new StateKV({ trigger } as never).listGroups()).rejects.toThrow("Invalid state::list_groups response");
  });
});
