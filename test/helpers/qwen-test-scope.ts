import { performance } from "node:perf_hooks";

// One Windows coordination process has a 10 s bound. A compress path may use
// identity, publication and three release attempts; retries/concurrency add more.
export const QWEN_PROCESS_TEST_MS = 60_000;
export const QWEN_MULTI_PROCESS_TEST_MS = 90_000;
export const QWEN_FIXTURE_DRAIN_MS = 60_000;

export class QwenTestScope {
  readonly abort = new AbortController();
  readonly timings: { label: string; ms: number }[] = [];
  private state: "open" | "closing" | "closed" = "open";
  private readonly pending = new Map<Promise<unknown>, string>();
  private readonly releases = new Set<() => void>();
  private closeResult?: Promise<void>;

  assertOpen(): void {
    if (this.state !== "open") throw Error("qwen_test_fixture_closing");
  }

  assertClosed(): void {
    if (this.state !== "closed" || this.pending.size) {
      throw Error("qwen_test_previous_fixture_unsettled");
    }
  }

  run<T>(label: string, operation: () => T | PromiseLike<T>): Promise<T> {
    this.assertOpen();
    return this.track(label, operation);
  }

  // Releases may start during shutdown. The provider/body must remain tracked
  // until these real child-process callbacks have settled.
  track<T>(label: string, operation: () => T | PromiseLike<T>): Promise<T> {
    if (this.state === "closed") throw Error("qwen_test_fixture_closed");
    const start = performance.now();
    const promise = Promise.resolve().then(operation);
    this.pending.set(promise, label);
    const settled = () => {
      this.pending.delete(promise);
      this.timings.push({ label, ms: Math.round(performance.now() - start) });
    };
    void promise.then(settled, settled);
    return promise;
  }

  barrier(): { promise: Promise<void>; release: () => void } {
    this.assertOpen();
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    const release = () => { this.releases.delete(release); resolve(); };
    this.releases.add(release);
    return { promise, release };
  }

  waitFor<T>(promise: Promise<T>): Promise<T> {
    this.assertOpen();
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(this.abort.signal.reason);
      const remove = onAbort(this.abort.signal, aborted);
      void promise.then(
        value => { remove(); resolve(value); },
        error => { remove(); reject(error); },
      );
    });
  }

  close(finalize: () => void, timeoutMs = QWEN_FIXTURE_DRAIN_MS): Promise<void> {
    if (this.closeResult) return this.closeResult;
    this.state = "closing";
    this.abort.abort(Error("qwen_test_fixture_closing"));
    for (const release of [...this.releases]) release();
    this.closeResult = this.drain(finalize, timeoutMs);
    return this.closeResult;
  }

  private async drain(finalize: () => void, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error(
        "qwen_test_fixture_unsettled:" + [...this.pending.values()].join(","),
      )), timeoutMs);
    });
    try {
      while (this.pending.size) {
        await Promise.race([Promise.allSettled([...this.pending.keys()]), expired]);
      }
      finalize();
      this.state = "closed";
    } finally {
      clearTimeout(timer);
    }
  }
}

export function onAbort(signal: AbortSignal | null | undefined, callback: () => void): () => void {
  if (!signal) throw Error("qwen_test_missing_abort_signal");
  if (signal.aborted) {
    callback();
    return () => {};
  }
  signal.addEventListener("abort", callback, { once: true });
  return () => signal.removeEventListener("abort", callback);
}
