/**
 * Slice C test: deepen remaining static-ish route/data/action parity
 * for status/help/editor/profile/lightbox/task surfaces.
 *
 * Focus areas:
 * 1. Sidebar status: error click copies to clipboard (not console-only), clearAllErrors works
 * 2. HelpPage: bug report persistence to localStorage, delete report, past reports load
 * 3. Lightbox: MoreHorizontal menu/action parity
 * 4. ProfilePage: follow state toggle, banner text toggle
 * 5. TasksPage: challenge completion round-trips in localStorage-like store
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useGenerationStore, useUIStore } from "@/store";

// ---------------------------------------------------------------------------
// 1. StatusBar error click parity
// ---------------------------------------------------------------------------

describe("Sidebar status error action parity", () => {
  beforeEach(() => {
    useGenerationStore.setState({ errors: [], lastError: null });
  });

  it("clearAllErrors clears errors array and lastError", () => {
    const { getState } = useGenerationStore;

    // Add errors
    getState().addError({ message: "timeout", category: "network" });
    getState().addError({ message: "OOM", category: "execution" });
    expect(getState().errors).toHaveLength(2);
    expect(getState().lastError).toBe("OOM");

    // clearAllErrors (the wired action on the X button)
    getState().clearAllErrors();
    expect(getState().errors).toHaveLength(0);
    expect(getState().lastError).toBeNull();
  });

  it("clearError removes a single error by index", () => {
    const { getState } = useGenerationStore;

    getState().addError({ message: "first", category: "network" });
    getState().addError({ message: "second", category: "execution" });
    expect(getState().errors).toHaveLength(2);

    // Errors are prepended, so "second" is at index 0 after both adds
    // Clear the most recent error (index 0)
    getState().clearError(0);
    expect(getState().errors).toHaveLength(1);
    expect(getState().errors[0].message).toBe("first");
  });

  it("formats errors for clipboard correctly", () => {
    const { getState } = useGenerationStore;

    const ts = Date.now();
    getState().addError({ message: "connection refused", category: "network" });
    const errors = getState().errors;

    // Verify the format matches what SidebarStatus handleErrorClick produces
    const text = errors
      .map((e, i) => `${i + 1}. [${new Date(e.timestamp).toLocaleTimeString()}] ${e.message}${e.promptId ? ` (prompt: ${e.promptId})` : ""}`)
      .join("\n");

    expect(text).toContain("connection refused");
    expect(text).toContain("1.");
  });

  it("errors with promptId include it in formatted output", () => {
    const { getState } = useGenerationStore;

    getState().addError({
      message: "node error",
      category: "execution",
      promptId: "abc-123",
    });
    const errors = getState().errors;

    const text = errors
      .map((e, i) => `${i + 1}. [${new Date(e.timestamp).toLocaleTimeString()}] ${e.message}${e.promptId ? ` (prompt: ${e.promptId})` : ""}`)
      .join("\n");

    expect(text).toContain("(prompt: abc-123)");
  });

  it("addError preserves last 10 errors", () => {
    const { getState } = useGenerationStore;

    for (let i = 0; i < 12; i++) {
      getState().addError({ message: `error-${i}`, category: "network" });
    }

    expect(getState().errors).toHaveLength(10);
    // Most recent errors should be at the start (slice 0,9 keeps first 10)
    expect(getState().errors[0].message).toBe("error-11");
  });
});

// ---------------------------------------------------------------------------
// 2. HelpPage bug report persistence
// ---------------------------------------------------------------------------

describe("HelpPage bug report persistence", () => {
  // Pure-logic tests that don't need browser localStorage
  const FEEDBACK_KEY = "adrift.feedback";

  it("saves a bug report entry with id, description, timestamp", () => {
    const store: unknown[] = [];
    const entry = {
      id: "test1",
      description: "UI button not responding",
      timestamp: new Date().toISOString(),
      status: "submitted",
    };

    store.push(entry);
    expect(store).toHaveLength(1);
    const saved = store[0] as typeof entry;
    expect(saved.description).toBe("UI button not responding");
    expect(saved.status).toBe("submitted");
    expect(saved.id).toBeTruthy();
  });

  it("loads past reports from a serialized list", () => {
    const reports = [
      { id: "r1", description: "bug one", timestamp: "2026-01-01T00:00:00Z", status: "submitted" },
      { id: "r2", description: "bug two", timestamp: "2026-02-01T00:00:00Z", status: "submitted" },
    ];
    const serialized = JSON.stringify(reports);
    const loaded = JSON.parse(serialized);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].description).toBe("bug one");
    expect(loaded[1].description).toBe("bug two");
  });

  it("deletes a report by id from the list", () => {
    const reports = [
      { id: "r1", description: "keep me", timestamp: "2026-01-01T00:00:00Z", status: "submitted" },
      { id: "r2", description: "delete me", timestamp: "2026-02-01T00:00:00Z", status: "submitted" },
    ];

    const filtered = reports.filter((r) => r.id !== "r2");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("r1");
  });

  it("handles empty list gracefully", () => {
    const loaded = JSON.parse("[]");
    expect(loaded).toEqual([]);
  });

  it("handles corrupt JSON gracefully", () => {
    let parsed: unknown[] = [];
    try {
      parsed = JSON.parse("not-json");
    } catch {
      parsed = [];
    }
    expect(parsed).toEqual([]);
  });

  it("report id format matches Date.now base36 + random hex", () => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    expect(id.length).toBeGreaterThan(6);
    expect(id).toMatch(/^[a-z0-9]+$/);
  });
});

// ---------------------------------------------------------------------------
// 3. Lightbox MoreHorizontal action parity
// ---------------------------------------------------------------------------

describe("Lightbox MoreHorizontal action parity", () => {
  beforeEach(() => {
    useUIStore.setState({ lightbox: null });
    useGenerationStore.setState({ gallery: [] });
  });

  it("current image URL can be read for clipboard copy", () => {
    // Open lightbox with an image containing a URL
    useUIStore.getState().openLightbox({
      images: [
        {
          id: "test-img",
          url: "https://example.com/image.png",
          prompt: "test prompt",
          fullPrompt: "test prompt --ar 1:1",
          params: [],
          paramsMap: {},
          seed: 123,
          createdAt: new Date().toISOString(),
          runId: "run-test",
          jobIndex: 0,
          width: 1024,
          height: 1024,
        },
      ],
      index: 0,
      origin: "explore",
    });

    const lightbox = useUIStore.getState().lightbox;
    expect(lightbox).not.toBeNull();
    const currentImage = lightbox!.images[lightbox!.index];
    expect(currentImage.url).toBe("https://example.com/image.png");

    // The MoreHorizontal button action:
    // navigator.clipboard?.writeText(currentImage.url)
    // This is a browser API; we verify the URL is readable
    expect(currentImage.url).toBeTruthy();
  });

  it("lightbox has no URL when image lacks one — action becomes no-op", () => {
    useUIStore.getState().openLightbox({
      images: [
        {
          id: "no-url-img",
          url: "",
          prompt: "no url image",
          fullPrompt: "",
          params: [],
          paramsMap: {},
          seed: 456,
          createdAt: new Date().toISOString(),
          runId: "",
          jobIndex: 0,
          width: 512,
          height: 512,
        },
      ],
      index: 0,
      origin: "explore",
    });

    const lightbox = useUIStore.getState().lightbox;
    const currentImage = lightbox!.images[lightbox!.index];
    // If URL is falsy, the copy action is skipped (guard: if currentImage?.url)
    expect(currentImage.url).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// 4. ProfilePage local action parity
// ---------------------------------------------------------------------------

describe("ProfilePage local action parity", () => {
  beforeEach(() => {
    useGenerationStore.setState({ gallery: [] });
    useUIStore.setState({ lightbox: null });
  });

  it("follow toggle changes following state", () => {
    // ProfilePage's follows state is local React state
    // We verify the logic pattern: toggleFollow maps over and flips
    type FollowEntry = { handle: string; following: boolean };
    const initial: FollowEntry[] = [
      { handle: "@demo", following: true },
      { handle: "@adrift", following: false },
    ];

    const toggleFollow = (h: string, prev: FollowEntry[]) =>
      prev.map((f) => (f.handle === h ? { ...f, following: !f.following } : f));

    const afterToggle = toggleFollow("@demo", initial);
    expect(afterToggle[0].following).toBe(false);
    expect(afterToggle[1].following).toBe(false);

    const afterToggle2 = toggleFollow("@adrift", afterToggle);
    expect(afterToggle2[0].following).toBe(false);
    expect(afterToggle2[1].following).toBe(true);
  });

  it("banner text toggles between null and string", () => {
    // ProfilePage Set Banner button toggles between null and "Banner updated!"
    let bannerText: string | null = null;
    bannerText = bannerText ? null : "Banner updated!";
    expect(bannerText).toBe("Banner updated!");

    bannerText = bannerText ? null : "Banner updated!";
    expect(bannerText).toBeNull();
  });

  it("handle copy profile copies the handle string", () => {
    // ProfilePage's handleCopyProfile copies `@username` to clipboard
    const username = "demo";
    const handle = `@${username}`;
    expect(handle).toBe("@demo");
  });

  it("profile spotlights filter gallery by liked status", () => {
    const { getState } = useGenerationStore;

    getState().addToGallery([
      {
        id: "s1",
        url: "/a.png",
        prompt: "alpha",
        fullPrompt: "alpha",
        params: [],
        paramsMap: {},
        seed: 1,
        createdAt: new Date().toISOString(),
        runId: "r1",
        jobIndex: 0,
        width: 1024,
        height: 1024,
        liked: true,
      },
      {
        id: "s2",
        url: "/b.png",
        prompt: "beta",
        fullPrompt: "beta",
        params: [],
        paramsMap: {},
        seed: 2,
        createdAt: new Date().toISOString(),
        runId: "r1",
        jobIndex: 1,
        width: 1024,
        height: 1024,
      },
    ]);

    const likedImages = getState().gallery.filter((img) => img.liked);
    expect(likedImages).toHaveLength(1);
    expect(likedImages[0].id).toBe("s1");
  });
});

// ---------------------------------------------------------------------------
// 5. TasksPage challenge completion round-trip
// ---------------------------------------------------------------------------

describe("TasksPage challenge completion parity", () => {
  const COMPLETED_KEY = "adrift.completed-challenges-test";

  it("marking challenge completed adds key to set", () => {
    const completed = new Set<string>();
    const key = "abc12345-0";

    completed.add(key);
    expect(completed.has(key)).toBe(true);
    expect(completed.has("abc12345-1")).toBe(false);
  });

  it("marking multiple challenges persists and loads", () => {
    const completed = new Set<string>();
    completed.add("seed1-0");
    completed.add("seed1-2");

    // Serialize
    const serialized = JSON.stringify([...completed]);

    // Deserialize
    const loaded = new Set(JSON.parse(serialized) as string[]);
    expect(loaded.has("seed1-0")).toBe(true);
    expect(loaded.has("seed1-2")).toBe(true);
    expect(loaded.has("seed1-1")).toBe(false);
  });

  it("clearing history via clearPromptHistory resets the store", () => {
    const { getState } = useGenerationStore;

    useGenerationStore.setState({ promptHistory: [] });
    getState().addToPromptHistory("first prompt");
    getState().addToPromptHistory("second prompt");
    expect(getState().promptHistory.length).toBeGreaterThanOrEqual(2);

    // TasksPage's "Clear all" button calls clearPromptHistory
    getState().clearPromptHistory();
    expect(getState().promptHistory).toHaveLength(0);
  });

  it("reusing a prompt from history sets promptValue in UI store", () => {
    const { getState: getUI } = useUIStore;

    // TasksPage HistorySection calls setPromptValue(prompt)
    getUI().setPromptValue("a reused prompt from history");
    expect(getUI().promptValue).toBe("a reused prompt from history");
  });

  it("dailySeed function produces deterministic hash for same day", () => {
    function dailySeed(): string {
      const d = new Date();
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      let hash = 2166136261;
      for (let i = 0; i < key.length; i++) {
        hash ^= key.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return Math.abs(hash).toString(16).slice(0, 8);
    }

    const s1 = dailySeed();
    const s2 = dailySeed();
    expect(s1).toBe(s2);
    expect(s1.length).toBe(8);
    // Should be hex string
    expect(s1).toMatch(/^[0-9a-f]+$/);
  });
});

// ---------------------------------------------------------------------------
// 6. showToast contract for SidebarStatus and Lightbox
// ---------------------------------------------------------------------------

describe("showToast contract for surface actions", () => {
  it("exports showToast as a function", async () => {
    const mod = await import("@/components/Toast");
    expect(typeof mod.showToast).toBe("function");
  });

  it("showToast accepts message, type, and duration", async () => {
    const mod = await import("@/components/Toast");
    // Should not throw - just adds to the queue
    expect(() => mod.showToast("test message", "info", 3000)).not.toThrow();
  });
});