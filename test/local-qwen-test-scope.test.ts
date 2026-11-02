import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { QwenTestScope, onAbort } from "./helpers/qwen-test-scope.js";

describe("Qwen test fixture lifecycle", () => {
  it("awaits the body and late coordination before restoring shared state", async () => {
    const scope = new QwenTestScope();
    const held = scope.barrier();
    const events: string[] = [];
    let finishProcess!: () => void;
    const processDone = new Promise<void>(resolve => { finishProcess = resolve; });
    const body = scope.run("test body", async () => {
      await held.promise;
      await scope.track("coordination:release", () => processDone);
      events.push("body done");
    });
    const closing = scope.close(() => events.push("restored"));
    await Promise.resolve();
    expect(scope.abort.signal.aborted).toBe(true);
    expect(events).toEqual([]);
    expect(() => scope.assertClosed()).toThrow("previous_fixture_unsettled");
    finishProcess();
    await closing;
    await body;
    expect(events).toEqual(["body done", "restored"]);
    scope.assertClosed();
  });

  it("retains the fixture and refuses reuse when the drain deadline expires", async () => {
    const scope = new QwenTestScope();
    const dir = mkdtempSync(join(tmpdir(), "agentmemory-qwen-fixture-"));
    writeFileSync(join(dir, "synthetic.txt"), "synthetic fixture");
    let finish!: () => void;
    const pending = scope.run("real callback pending", () => new Promise<void>(resolve => { finish = resolve; }));
    const finalize = vi.fn(() => rmSync(dir, { recursive: true }));
    try {
      await expect(scope.close(finalize, 5)).rejects.toThrow("fixture_unsettled:real callback pending");
      expect(finalize).not.toHaveBeenCalled();
      expect(existsSync(dir)).toBe(true);
      expect(() => scope.assertClosed()).toThrow("previous_fixture_unsettled");
      expect(() => scope.run("next test", () => {})).toThrow("fixture_closing");
      finish();
      await pending;
      // Completion after the deadline is not a successful teardown or retry.
      await expect(scope.close(finalize)).rejects.toThrow("fixture_unsettled");
      expect(finalize).not.toHaveBeenCalled();
    } finally {
      finish();
      await pending;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps cleanup errors visible and prevents the next fixture", async () => {
    const scope = new QwenTestScope();
    const failure = Object.assign(Error("synthetic cleanup denied"), { code: "EPERM" });
    await expect(scope.close(() => { throw failure; })).rejects.toBe(failure);
    expect(() => scope.assertClosed()).toThrow("previous_fixture_unsettled");
  });

  it("cancels a body waiting for a signal that never arrived", async () => {
    const scope = new QwenTestScope();
    const started = new Promise<void>(() => {});
    const body = scope.run("test body", () => scope.waitFor(started));
    await Promise.resolve();
    const outcome = expect(body).rejects.toThrow("fixture_closing");
    await scope.close(() => {});
    await outcome;
    scope.assertClosed();
  });

  it("handles already-aborted mock requests and removes active listeners", () => {
    const controller = new AbortController();
    const callback = vi.fn();
    const remove = onAbort(controller.signal, callback);
    remove();
    controller.abort();
    expect(callback).not.toHaveBeenCalled();
    onAbort(controller.signal, callback);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
