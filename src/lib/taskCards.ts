/**
 * Badge math for the Tasks page cards. Pure so it can be unit-tested
 * without the stores.
 */

export interface PairVote {
  imageA: string;
  imageB: string;
}

/**
 * How many distinct still-image pairs are left to vote on. Votes that
 * reference images no longer in the gallery, and repeat votes on the same
 * pair (either order), do not count.
 */
export function remainingPairs(
  imageIds: readonly string[],
  votes: readonly PairVote[],
): number {
  const ids = new Set(imageIds);
  const n = ids.size;
  if (n < 2) return 0;
  const total = (n * (n - 1)) / 2;
  const voted = new Set<string>();
  for (const v of votes) {
    if (v.imageA === v.imageB) continue;
    if (!ids.has(v.imageA) || !ids.has(v.imageB)) continue;
    voted.add(
      v.imageA < v.imageB
        ? `${v.imageA}|${v.imageB}`
        : `${v.imageB}|${v.imageA}`,
    );
  }
  return Math.max(0, total - voted.size);
}

/** Today's challenges marked done, given the day seed and the done keys. */
export function challengesDoneToday(
  seed: string,
  completed: ReadonlySet<string>,
  perDay = 3,
): number {
  let done = 0;
  for (let i = 0; i < perDay; i++) {
    if (completed.has(`${seed}-${i}`)) done++;
  }
  return done;
}

/** "1 pair" / "12 pairs" style pluralisation for badges and stats. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
