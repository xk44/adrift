// Node >=22 exposes a `localStorage` global that is undefined unless
// --localstorage-file is passed; zustand's persist middleware then passes its
// existence check but crashes on setItem. Older Node threw ReferenceError and
// zustand fell back to a no-op. Shim an in-memory store so tests behave the
// same on every Node version/platform.
const g = globalThis as { localStorage?: Storage };
if (typeof g.localStorage === "undefined" || g.localStorage === undefined) {
  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    key: (i) => [...store.keys()][i] ?? null,
    removeItem: (k) => void store.delete(k),
    setItem: (k, v) => void store.set(k, String(v)),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage,
    configurable: true,
    writable: true,
  });
}

// Route tests isolate rate-limit buckets with distinct X-Forwarded-For values,
// which lib/rateLimit only honours behind a trusted proxy. Tests that cover
// the untrusted default delete it locally.
process.env.TRUST_PROXY ??= "1";
