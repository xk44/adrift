/**
 * Which state a data-backed view is in. One rule for every page:
 * an error always wins over "empty" (a failed load must never read as
 * "nothing here yet"), loading only shows while there is nothing to show,
 * and "ready" means render the content.
 *
 * Pure so the rule is unit-tested; StateView (components/ui/StateView.tsx)
 * renders it.
 */

export type ViewStatus = "loading" | "error" | "empty" | "ready";

export interface ViewStateInput {
  loading: boolean;
  /** Error message (or true) from the last load; null/undefined/false = none. */
  error?: string | boolean | null;
  /** Number of items the view would render. */
  count: number;
}

export function viewStatus({
  loading,
  error,
  count,
}: ViewStateInput): ViewStatus {
  if (count > 0) return "ready";
  if (error) return "error";
  if (loading) return "loading";
  return "empty";
}

/**
 * Plain-language message for a thrown fetch error. Network failures
 * ("Failed to fetch", "NetworkError", "Load failed") become a sentence a
 * beginner can act on; anything else is passed through.
 */
export function friendlyLoadError(
  err: unknown,
  fallback = "Something went wrong.",
): string {
  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!raw) return fallback;
  if (
    /failed to fetch|networkerror|load failed|network request failed/i.test(raw)
  )
    return "Couldn't reach the Adrift server. Check that it is running.";
  return raw;
}
