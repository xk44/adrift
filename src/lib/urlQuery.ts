/**
 * Merge `updates` into the current page's query string (null deletes a key).
 * Discrete picks push (Back undoes them); typing replaces. No-op when the
 * query wouldn't change. Shared by the URL-backed filter UIs (Explore,
 * Workflows → Civitai).
 */
export function updateUrlQuery(
  updates: Record<string, string | null>,
  mode: "replace" | "push" = "replace",
): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(updates)) {
    if (v === null) params.delete(k);
    else params.set(k, v);
  }
  const qs = params.toString();
  if (qs === window.location.search.replace(/^\?/, "")) return;
  const href = qs ? `?${qs}` : window.location.pathname;
  if (mode === "push") window.history.pushState(null, "", href);
  else window.history.replaceState(null, "", href);
}
