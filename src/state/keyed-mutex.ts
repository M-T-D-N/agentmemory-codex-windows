const locks = new Map<string, Promise<void>>();

export function withKeyedLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const cleanup = next.then(
    () => {},
    () => {},
  );
  locks.set(key, cleanup);
  cleanup.then(() => {
    if (locks.get(key) === cleanup) locks.delete(key);
  });
  return next;
}

export function keyedLockBusy(key: string): boolean {
  return locks.has(key);
}

export async function tryWithKeyedLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  if (keyedLockBusy(key)) return { acquired: false };
  const value = await withKeyedLock(key, fn);
  return { acquired: true, value };
}

export function withKeyedLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(keys)].sort();
  const acquire = (index: number): Promise<T> => index === ordered.length
    ? fn()
    : withKeyedLock(ordered[index], () => acquire(index + 1));
  return acquire(0);
}
