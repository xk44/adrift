/**
 * Identity-preserving helpers for derived lists.
 *
 * Memoized rows/editors (React.memo) only skip a render when their props keep
 * the same identity. Derived lists (`controls.map(c => ({ ...c }))`, groupBy)
 * hand out fresh objects on every recompute, so one changed item re-renders
 * every row. These helpers reuse the previous object for any item whose
 * content did not change.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Shallow equality with one optional extra level for nested plain objects and
 * arrays (e.g. a control's `remote` or `options`, rebuilt on every spec pass).
 */
export function shallowEqualDeep1(a: unknown, b: unknown, depth = 1): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (Object.is(a[i], b[i])) continue;
      if (depth <= 0 || !shallowEqualDeep1(a[i], b[i], depth - 1)) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    if (ak.length !== Object.keys(b).length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (Object.is(a[k], b[k])) continue;
      if (depth <= 0 || !shallowEqualDeep1(a[k], b[k], depth - 1)) return false;
    }
    return true;
  }
  return false;
}

/** True when both arrays hold the same element identities in order. */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/**
 * Reuse `prev` entries (by key) whose content is `same` as the new one.
 * Returns the stabilized list plus the cache to pass in next time; the
 * cache only holds keys from this pass, so it never grows unbounded.
 */
export function stabilizeByKey<T>(
  next: readonly T[],
  prev: ReadonlyMap<string, T>,
  keyOf: (item: T) => string,
  same: (prevItem: T, nextItem: T) => boolean,
): { items: T[]; cache: Map<string, T> } {
  const cache = new Map<string, T>();
  const items = next.map((item) => {
    const key = keyOf(item);
    const old = prev.get(key);
    const out = old !== undefined && same(old, item) ? old : item;
    cache.set(key, out);
    return out;
  });
  return { items, cache };
}
