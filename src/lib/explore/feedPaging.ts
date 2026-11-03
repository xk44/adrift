/**
 * Infinite-scroll paging policy for the model feed (pure, unit-tested).
 *
 * - Never auto-page after an error (a 429 would hot-loop: every
 *   loading→false flip re-arms the observer, which fires again at once).
 * - Never auto-page while no card is visible (e.g. "Fits my GPU" hides the
 *   whole page): the sentinel would stay on screen and walk the entire
 *   catalog. Offer a manual "Load more" instead.
 */
export interface FeedPagingState {
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  /** Cards actually rendered after client-side filters. */
  visibleCount: number;
}

export function shouldAutoPage(s: FeedPagingState): boolean {
  return s.hasMore && !s.error && s.visibleCount > 0;
}

export function shouldOfferLoadMore(s: FeedPagingState): boolean {
  return s.hasMore && !s.error && !s.loading && s.visibleCount === 0;
}
