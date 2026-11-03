import { sameItems, stabilizeByKey } from "@/lib/ui/stableIdentity";

/**
 * Keep a feed run-group's identity while its images are the same objects.
 * Every other group field (prompt, params, …) derives from those images, so
 * equal image identities mean an equal group. Keyed by day + run, since a run
 * that straddles midnight renders as one group per day.
 */
export function stabilizeRunGroups<
  G extends { runId: string; images: readonly unknown[] },
>(
  dayKey: string,
  groups: readonly G[],
  prev: ReadonlyMap<string, G>,
): { items: G[]; cache: Map<string, G> } {
  return stabilizeByKey(
    groups,
    prev,
    (g) => `${dayKey}\u0000${g.runId}`,
    (a, b) => sameItems(a.images, b.images),
  );
}
