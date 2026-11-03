const locks = new Map<string, Promise<unknown>>();

export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const chain = run
    .catch(() => undefined)
    .finally(() => {
      if (locks.get(key) === chain) {
        locks.delete(key);
      }
    });

  locks.set(key, chain);
  return run;
}
