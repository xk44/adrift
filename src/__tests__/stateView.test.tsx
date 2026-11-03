import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateView } from "@/components/ui/StateView";
import { friendlyLoadError, viewStatus } from "@/lib/ui/viewState";

vi.mock("@/components/Toast", () => ({ showToast: vi.fn() }));

const src = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");

describe("viewStatus", () => {
  it("an error wins over empty, content wins over everything", () => {
    expect(viewStatus({ loading: false, error: "boom", count: 0 })).toBe(
      "error",
    );
    expect(viewStatus({ loading: true, error: "boom", count: 0 })).toBe(
      "error",
    );
    expect(viewStatus({ loading: true, count: 0 })).toBe("loading");
    expect(viewStatus({ loading: false, count: 0 })).toBe("empty");
    expect(viewStatus({ loading: true, error: "x", count: 3 })).toBe("ready");
  });
});

describe("friendlyLoadError", () => {
  it("turns network failures into a plain sentence", () => {
    expect(friendlyLoadError(new TypeError("Failed to fetch"))).toMatch(
      /Couldn't reach the Adrift server/,
    );
    expect(friendlyLoadError(new Error("Load failed"))).toMatch(
      /Adrift server/,
    );
  });
  it("passes other messages through and falls back when empty", () => {
    expect(friendlyLoadError(new Error("HTTP 500"))).toBe("HTTP 500");
    expect(friendlyLoadError(null, "Nope.")).toBe("Nope.");
  });
});

describe("StateView", () => {
  const html = (el: React.ReactElement) => renderToStaticMarkup(el);

  it("error shows the message and a Try again button when retryable", () => {
    const out = html(
      <StateView
        status="error"
        title="Couldn't load X"
        message="HTTP 500"
        onRetry={() => {}}
      />,
    );
    expect(out).toContain('role="alert"');
    expect(out).toContain("Couldn&#x27;t load X");
    expect(out).toContain("HTTP 500");
    expect(out).toContain("Try again");
  });

  it("error without onRetry has no button; empty shows its action", () => {
    expect(html(<StateView status="error" />)).not.toContain("<button");
    const empty = html(
      <StateView
        status="empty"
        action={{ label: "Create one", onClick: () => {} }}
      />,
    );
    expect(empty).toContain("Nothing here yet");
    expect(empty).toContain("Create one");
    expect(empty).not.toContain("Try again");
  });

  it("loading renders a provided skeleton with an accessible label", () => {
    const out = html(
      <StateView
        status="loading"
        title="Loading images"
        skeleton={<i data-sk="1" />}
      />,
    );
    expect(out).toContain('role="status"');
    expect(out).toContain('data-sk="1"');
    expect(out).toContain("Loading images");
  });
});

describe("styleStore.fetchMoodboards", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function run(fetchImpl: () => Promise<Response>) {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(fetchImpl));
    const { useStyleStore } = await import("@/store/styleStore");
    await useStyleStore.getState().fetchMoodboards();
    return useStyleStore.getState();
  }

  it("a failed load sets moodboardsError instead of looking empty", async () => {
    const s = await run(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(s.moodboards).toEqual([]);
    expect(s.moodboardsLoading).toBe(false);
    expect(s.moodboardsError).toMatch(/Adrift server/);
  });

  it("a non-ok reply names the status; success clears the error", async () => {
    const bad = await run(
      async () => new Response(JSON.stringify({ ok: false }), { status: 503 }),
    );
    expect(bad.moodboardsError).toContain("503");
    const good = await run(
      async () =>
        new Response(JSON.stringify({ ok: true, moodboards: [] }), {
          status: 200,
        }),
    );
    expect(good.moodboardsError).toBeNull();
  });
});

describe("pages route errors through StateView with retry", () => {
  it("Gallery: first-load skeleton and an error state that never reads as empty", () => {
    const g = src("components/Gallery.tsx");
    expect(g).toContain("<SkeletonGrid count={8} />");
    expect(g).toContain("setHistoryError(friendlyLoadError(err))");
    expect(g).toContain("onRetry={() => void loadHistory(0)}");
    // the error/skeleton branch precedes the "No images yet" empty state
    expect(g.indexOf('title="Couldn\'t load your images"')).toBeLessThan(
      g.indexOf(
        "activeRuns.length === 0 && gallery.length === 0 && !historyLoading",
      ),
    );
  });

  it("Manager uses the shared toast and offers retry", () => {
    const m = src("components/ManagerPage.tsx");
    expect(m).toContain('import { showToast } from "@/components/Toast"');
    expect(m).not.toMatch(/const \[toast, setToast\]/);
    expect(m).toContain("onRetry={() => void retry()}");
  });

  it("Workflows, Moodboards and the moodboard panel retry on error", () => {
    expect(src("components/WorkflowsPage.tsx")).toContain(
      "onRetry={() => setReloadKey((k) => k + 1)}",
    );
    for (const p of [
      "components/MoodboardsPage.tsx",
      "components/style/MoodboardPanel.tsx",
    ]) {
      const s = src(p);
      expect(s, p).toContain("moodboardsError");
      expect(s, p).toContain("onRetry={() => void fetchMoodboards()}");
    }
  });
});
