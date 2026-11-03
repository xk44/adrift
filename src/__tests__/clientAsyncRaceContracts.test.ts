/**
 * Client-side async race / stale-event contracts (source-level, node env —
 * same idiom as the other *Contracts tests; no jsdom or WebSocket mock).
 *
 * useComfyWS:
 *  - close/error events from a socket that is no longer wsRef.current (it was
 *    replaced by reconnect() or nulled by closeNow) must be ignored, otherwise
 *    they flip wsConnected=false, leave wsReconnecting stuck, and clear the
 *    live socket's reachability interval.
 *  - checkReachability's 5s debounce must return the cached result, not
 *    undefined (onerror always checks just before onclose, so the max-attempts
 *    branch always saw `undefined` and raised a spurious "Lost connection").
 *  - after exhausting fast retries, the HTTP fallback must retry the socket
 *    once ComfyUI is reachable again instead of polling until reload.
 *
 * Style library views: search-as-you-type and cluster/page loads guard every
 * setState with a latest-request generation so out-of-order responses (or
 * ones landing after the query was cleared / panel unmounted) are dropped.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

function between(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  expect(a, `missing marker: ${start}`).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(end, a + start.length);
  expect(b, `missing marker: ${end}`).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe("useComfyWS stale-socket + reachability contracts", () => {
  const src = read("src/hooks/useComfyWS.ts");

  it("onclose ignores sockets that are no longer current, before touching state", () => {
    const body = between(src, "ws.onclose", "ws.onerror");
    const guard = body.indexOf("if (wsRef.current !== ws) return;");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(body.indexOf("setWsConnected(false)"));
    expect(guard).toBeLessThan(
      body.indexOf("clearInterval(reachabilityInterval.current)"),
    );
  });

  it("onerror ignores stale sockets", () => {
    const body = between(src, "ws.onerror", "ws.onmessage");
    expect(body.indexOf("if (wsRef.current !== ws) return;")).toBeGreaterThan(
      0,
    );
    expect(body.indexOf("if (wsRef.current !== ws) return;")).toBeLessThan(
      body.indexOf("checkReachability()"),
    );
  });

  it("debounced checkReachability returns the cached result, not undefined", () => {
    const body = between(src, "const checkReachability", "}, [");
    expect(body).toMatch(
      /< 5000\)\s*\{\s*return lastReachable\.current \?\? true;/,
    );
    expect(body).toContain("lastReachable.current = reachable;");
    expect(body).toContain("lastReachable.current = false;");
  });

  it("HTTP fallback retries the socket with a fresh budget once reachable", () => {
    const body = between(
      src,
      "Max reconnection attempts reached",
      "ws.onerror",
    );
    const interval = between(
      body,
      "reachabilityInterval.current = setInterval",
      "REACHABILITY_CHECK_MS",
    );
    expect(interval).toContain("pollJobStatus()");
    expect(interval).toContain("checkReachability()");
    expect(interval).toContain("wsRef.current === ws");
    expect(interval).toContain("!isIntentionalClose.current");
    // Re-arm with a small budget (not a full reset): the counter only goes
    // back to 0 via the stability window, so an HTTP-up / WS-dropping server
    // can't regain the fast-retry burst every cycle.
    expect(interval).not.toContain("reconnectAttempts.current = 0");
    expect(
      interval.indexOf(
        "reconnectAttempts.current = MAX_RECONNECT_ATTEMPTS - 1",
      ),
    ).toBeLessThan(interval.indexOf("connect()"));
  });

  it("socket drops warn instead of error (no Next dev overlay when ComfyUI is down)", () => {
    const onError = between(src, "ws.onerror", "ws.onmessage");
    expect(onError).toContain("console.warn");
    expect(onError).not.toContain("console.error(");
    const at = src.indexOf("Max reconnection attempts reached");
    expect(src.slice(at - 60, at)).toContain("console.warn(");
  });
});

describe("style library latest-request guards", () => {
  const shared = read("src/components/style/library/shared.tsx");
  const mix = read("src/components/style/library/StyleMixPanel.tsx");
  const clusters = read("src/components/style/library/ClustersView.tsx");
  const images = read("src/components/style/library/ImagesView.tsx");

  it("useLatestRequest invalidates and clears its debounce on unmount", () => {
    const hook = between(shared, "function useLatestRequest", "\n}\n");
    expect(hook).toMatch(
      /\(\) => \(\) => \{\s*gen\.current\+\+;\s*if \(timer\.current\) clearTimeout\(timer\.current\);/,
    );
  });

  it("StylePickerInput search bumps the generation and guards every result write", () => {
    const body = between(mix, "function StylePickerInput", "function StyleMixPanel");
    const search = between(body, "const search = useCallback", "}, [req]);");
    expect(search.indexOf("req.next()")).toBeLessThan(
      search.indexOf("if (!q.trim())"),
    );
    expect(search).toContain(
      "if (req.isCurrent(g)) setResults(normalizeStyleSearch(data));",
    );
    expect(search).toContain("if (req.isCurrent(g)) setResults([]);");
    expect(search).toContain("if (req.isCurrent(g)) setSearching(false);");
    expect(search).not.toMatch(/\n\s*setResults\(data\);/);
  });

  it("ClustersView search + cluster select invalidate in-flight searches", () => {
    const body = clusters;
    const search = between(
      body,
      "const handleSearch = useCallback",
      "}, [searchReq]);",
    );
    expect(search).toContain(
      "if (searchReq.isCurrent(g)) setSearchResults(normalizeStyleSearch(data));",
    );
    const select = between(body, "setSelectedCluster(id);", "loadMembers(id);");
    expect(select).toContain("searchReq.next()");
  });

  it("cluster member loads only apply to the still-active cluster", () => {
    const body = clusters;
    const load = between(
      body,
      "const loadMembers = useCallback",
      "[fetchMemberPage],",
    );
    expect(load.indexOf("activeClusterRef.current = clusterId;")).toBeLessThan(
      load.indexOf("memberCache.current.get(clusterId)"),
    );
    const afterFetch = load.slice(load.indexOf("await fetchMemberPage"));
    expect(
      afterFetch.indexOf("if (activeClusterRef.current !== clusterId) return;"),
    ).toBeLessThan(afterFetch.indexOf("setMembers(entry.items)"));
    const cachedBranch = between(load, "if (cached) {", "return;");
    expect(cachedBranch).toContain("setLoadingMembers(false)");

    const more = between(
      body,
      "const loadMoreMembers = useCallback",
      "}, [fetchMemberPage",
    );
    expect(more).toContain("memberCache.current.set(clusterId, next);");
    expect(
      more.indexOf("if (activeClusterRef.current !== clusterId) return;"),
    ).toBeLessThan(more.indexOf("setMembers(next.items)"));
  });

  it("ImagesView drops stale first pages and load-more pages from an older query", () => {
    const body = images;
    const first = between(
      body,
      "const loadFirstPage = useCallback",
      "}, [fetchAssetPage, req]);",
    );
    expect(first.indexOf("req.next()")).toBeLessThan(
      first.indexOf("await fetchAssetPage"),
    );
    const afterFetch = first.slice(first.indexOf("await fetchAssetPage"));
    expect(afterFetch.indexOf("if (!req.isCurrent(g)) return;")).toBeLessThan(
      afterFetch.indexOf("setResults(data)"),
    );
    const more = between(body, "const loadMore = useCallback", "]);");
    expect(more).toContain("const g = req.current();");
    const moreAfter = more.slice(more.indexOf("await fetchAssetPage"));
    expect(
      moreAfter.indexOf("if (!req.isCurrent(g)) return;"),
    ).toBeGreaterThanOrEqual(0);
    expect(moreAfter.indexOf("if (!req.isCurrent(g)) return;")).toBeLessThan(
      moreAfter.indexOf("setResults("),
    );
  });
});

describe("DescribeDialog / Krea2 / Manager stale-response guards", () => {
  it("DescribeDialog drops responses for a replaced image or reset dialog", () => {
    const src = read("src/components/DescribeDialog.tsx");
    const describe = between(
      src,
      "const describe = useCallback",
      "}, [imageFile, isLoading]);",
    );
    expect(describe).toContain("const gen = ++describeGen.current;");
    const afterFetch = describe.slice(
      describe.indexOf("await response.json()"),
    );
    expect(
      afterFetch.indexOf("if (gen !== describeGen.current) return;"),
    ).toBeLessThan(afterFetch.indexOf("setSuggestions("));
    const select = between(src, "const selectFile = useCallback", "}, []);");
    expect(select).toContain("describeGen.current++");
  });

  it("Krea2 browser: only the current request clears the spinner; abort on unmount", () => {
    const src = read("src/components/style/Krea2StyleLoraBrowser.tsx");
    expect(src).toContain("if (abortRef.current === ac) setLoading(false);");
    expect(src).toContain(
      "useEffect(() => () => abortRef.current?.abort(), []);",
    );
  });

  it("ManagerPage keeps packs/models loading + error separate and dedupes loads", () => {
    const src = read("src/components/ManagerPage.tsx");
    expect(src).not.toMatch(/\bsetLoading\(/);
    expect(src).not.toMatch(/\bsetError\(/);
    for (const k of ["packs", "models"]) {
      expect(src).toContain(`if (inflight.current.${k}) return;`);
      expect(src).toContain(`inflight.current.${k} = false;`);
    }
    expect(src).toContain(
      'loading && (kind === "models" ? models : packs).length === 0',
    );
  });
});

describe("keyboard handling", () => {
  it("Lightbox owns Escape in capture phase and ignores keys for other modals", () => {
    const src = read("src/components/Lightbox.tsx");
    const effect = between(
      src,
      "// Keyboard navigation",
      "useEffect(() => {\n    setShowMoreMenu(false);",
    );
    expect(effect).toContain(
      'window.addEventListener("keydown", handleKeyDown, true);',
    );
    expect(effect).toContain(
      'window.removeEventListener("keydown", handleKeyDown, true);',
    );
    expect(effect).toContain("otherModal !== rootRef.current");
    // Typing fields keep Escape (lightboxKeyIntent returns null for them,
    // see lightboxKeys.test.ts); a close stops propagation before closing.
    const dispatch = effect.slice(effect.indexOf("const intent = lightboxKeyIntent("));
    expect(dispatch).toContain("if (!intent) return;");
    expect(dispatch.indexOf("e.stopPropagation()")).toBeLessThan(
      dispatch.indexOf("closeLightbox()"),
    );
    // Phone: full-screen fixed sheet; md+: overlays the content area at z-40.
    expect(src).toMatch(
      /ref=\{rootRef\}\s*className="fixed inset-0 z-50 [^"]*md:absolute md:z-40/,
    );
  });

  it("Lightbox 'c' compare toggle leaves Cmd/Ctrl+C (copy) alone", () => {
    const src = read("src/components/Lightbox.tsx");
    // The modifier guard lives in lightboxKeyIntent (unit-tested in
    // lightboxKeys.test.ts); the lightbox only toggles on the "compare" intent.
    expect(src).toMatch(/case "compare":\s*setZoomed\(false\);\s*toggleCompare\(\);/);
    const keys = read("src/lib/ui/lightboxKeys.ts");
    expect(keys).toContain("if (modified) return null;");
  });

  it("WorkflowControlPanel undo/redo: Cmd on mac, case-insensitive Shift+Z", () => {
    const src = read("src/components/WorkflowControlPanel.tsx");
    const h = between(
      src,
      "// Keyboard shortcut for undo/redo",
      "}, [selectionKey, undo, redo]);",
    );
    expect(h).toContain("(e.ctrlKey || e.metaKey)");
    expect(h).toContain("e.key.toLowerCase()");
    const code = h.replace(/\/\/.*$/gm, "");
    expect(code).not.toContain('e.key === "z"');
    expect(h).toContain('(key === "z" && e.shiftKey)');
  });

  it("Explore cards and editor layer rows are keyboard-activatable", () => {
    const explore = read("src/components/ExplorePage.tsx");
    // Cards are <article>s with a real full-card Open <button> named from
    // the author/prompt (no role="button" wrapper around nested buttons)
    expect(explore).not.toMatch(/role="button"\s*tabIndex=\{0\}/);
    expect(explore.match(/exploreOpenLabel\(/g)?.length).toBe(2);
    expect(explore.match(/<article\b/g)?.length).toBe(2);
    const layers = read("src/components/editor/EditorLayers.tsx");
    expect(layers).toMatch(
      /onClick=\{onSelect\}\s*role="button"\s*tabIndex=\{0\}/,
    );
    expect(layers).toContain("if (e.target !== e.currentTarget) return;");
  });

  it("toasts render in an always-mounted polite live region", () => {
    const src = read("src/components/Toast.tsx");
    const container = between(
      src,
      "export function ToastContainer",
      "function ToastCard",
    );
    expect(container).toMatch(/role="status"\s*aria-live="polite"/);
  });
});

describe("store subscriptions don't re-render big pages on progress ticks", () => {
  it("MoodboardsPage compares completed runs shallowly", () => {
    const src = read("src/components/MoodboardsPage.tsx");
    expect(src).toContain("useGenerationStore(selectCompletedRuns, shallow)");
  });

  it("ExplorePage subscribes only to video-bearing runs", () => {
    const src = read("src/components/ExplorePage.tsx");
    expect(src).not.toContain("useGenerationStore((s) => s.runs)");
    expect(src).toContain("useGenerationStore(selectRunsWithVideos, shallow)");
  });
});
