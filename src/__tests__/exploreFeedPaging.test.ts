import { describe, expect, it } from "vitest";
import {
  shouldAutoPage,
  shouldOfferLoadMore,
  type FeedPagingState,
} from "@/lib/explore/feedPaging";

const S = (p: Partial<FeedPagingState> = {}): FeedPagingState => ({
  hasMore: true,
  loading: false,
  error: null,
  visibleCount: 12,
  ...p,
});

describe("model feed paging policy (F2)", () => {
  it("auto-pages while cards are visible and more exist", () => {
    expect(shouldAutoPage(S())).toBe(true);
    expect(shouldAutoPage(S({ hasMore: false }))).toBe(false);
  });

  it("stops auto-paging after an error (no 429 retry loop)", () => {
    expect(shouldAutoPage(S({ error: "Civitai API error 429" }))).toBe(false);
    expect(shouldOfferLoadMore(S({ error: "429", visibleCount: 0 }))).toBe(
      false,
    );
  });

  it("does not walk the catalog when a client filter hides every card", () => {
    expect(shouldAutoPage(S({ visibleCount: 0 }))).toBe(false);
    expect(shouldOfferLoadMore(S({ visibleCount: 0 }))).toBe(true);
    expect(shouldOfferLoadMore(S({ visibleCount: 0, loading: true }))).toBe(
      false,
    );
    expect(shouldOfferLoadMore(S({ visibleCount: 0, hasMore: false }))).toBe(
      false,
    );
  });
});
