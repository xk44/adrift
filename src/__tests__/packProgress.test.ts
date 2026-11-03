/**
 * Starter-pack download progress: server snapshot (ComfyUI listing + local
 * .part bytes), the SSE/JSON route, the browser watcher's SSE -> polling
 * fallback, and the honest UI states. No network: deps / fetch / EventSource
 * are fakes; nothing is ever downloaded.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import {
  STARTER_PACKS,
  folderOf,
  resolveAllPacks,
  type Listings,
} from "@/lib/onboarding/starterPacks";
import {
  chosenFiles,
  parsePackIds,
  progressChanged,
  readPackProgress,
  summarizeProgress,
  type PackProgress,
  type ProgressDeps,
} from "@/lib/onboarding/packProgress";
import {
  progressView,
  QUIET_AFTER_MS,
} from "@/lib/onboarding/packProgressView";
import {
  progressUrl,
  watchPackProgress,
  type ProgressUpdate,
} from "@/lib/onboarding/packProgressClient";
import { PackDownloadPanel } from "@/components/onboarding/PackDownloadWatch";

const PACK =
  STARTER_PACKS.packs.find((p) => p.files.length >= 2) ??
  STARTER_PACKS.packs[0];
const ID = PACK.id;
const FILES = chosenFiles(resolveAllPacks(null, null), [ID]);

function emptyListings(): Listings {
  const out: Listings = {};
  for (const p of STARTER_PACKS.packs)
    for (const f of chosenFiles(resolveAllPacks(null, null), [p.id]))
      out[folderOf(f.dest)] = new Set();
  return out;
}

function withInstalled(dests: string[]): Listings {
  const l = emptyListings();
  for (const d of dests)
    (l[folderOf(d)] as Set<string>).add(
      d.split("/").slice(1).join("/").toLowerCase(),
    );
  return l;
}

function deps(over: Partial<ProgressDeps> = {}): ProgressDeps {
  return {
    profile: async () => null,
    listings: async () => emptyListings(),
    partialBytes: null,
    ...over,
  };
}

function snap(over: Partial<PackProgress> = {}): PackProgress {
  return {
    at: 1,
    connected: true,
    bytesKnown: false,
    files: [],
    doneFiles: 0,
    totalFiles: 2,
    doneBytes: 0,
    totalBytes: 10 * 1024 ** 3,
    complete: false,
    ...over,
  };
}

describe("parsePackIds", () => {
  it("keeps known ids in pack order, drops unknown, dedupes", () => {
    const ids = STARTER_PACKS.packs.map((p) => p.id);
    const raw = `${ids[1] ?? ids[0]}, nope ,${ids[0]},${ids[0]}`;
    expect(parsePackIds(raw)).toEqual(ids.slice(0, ids.length > 1 ? 2 : 1));
    expect(parsePackIds("nope")).toBeNull();
    expect(parsePackIds("")).toBeNull();
    expect(parsePackIds(null)).toBeNull();
  });
});

describe("readPackProgress", () => {
  it("remote ComfyUI: whole files only, bytesKnown false, received null", async () => {
    const first = FILES[0].dest;
    const p = await readPackProgress(
      [ID],
      deps({ listings: async () => withInstalled([first]) }),
    );
    expect(p.connected).toBe(true);
    expect(p.bytesKnown).toBe(false);
    expect(p.totalFiles).toBe(FILES.length);
    expect(p.doneFiles).toBe(1);
    expect(p.files.find((f) => f.dest !== first)?.received).toBeNull();
    expect(p.complete).toBe(FILES.length === 1);
  });

  it("local ComfyUI: .part bytes count toward progress", async () => {
    const half = Math.floor(FILES[0].bytes / 2);
    const p = await readPackProgress(
      [ID],
      deps({ partialBytes: (d) => (d === FILES[0].dest ? half : 0) }),
    );
    expect(p.bytesKnown).toBe(true);
    expect(p.doneBytes).toBe(half);
    expect(p.doneFiles).toBe(0);
  });

  it("complete once every file is listed", async () => {
    const p = await readPackProgress(
      [ID],
      deps({ listings: async () => withInstalled(FILES.map((f) => f.dest)) }),
    );
    expect(p.complete).toBe(true);
    expect(p.doneBytes).toBe(p.totalBytes);
  });

  it("ComfyUI unreachable / throwing deps: not connected, never complete", async () => {
    const p = await readPackProgress(
      [ID],
      deps({
        listings: async () => null,
      }),
    );
    expect(p.connected).toBe(false);
    expect(p.complete).toBe(false);
    const q = await readPackProgress(
      [ID],
      deps({
        profile: async () => {
          throw new Error("x");
        },
      }),
    );
    expect(q.connected).toBe(false);
  });
});

describe("summarizeProgress / progressChanged", () => {
  it("caps partial bytes at the file size", () => {
    const s = summarizeProgress(
      [
        {
          dest: "loras/a.safetensors",
          bytes: 100,
          installed: false,
          received: 500,
        },
      ],
      true,
      true,
    );
    expect(s.doneBytes).toBe(100);
    expect(s.complete).toBe(false);
  });
  it("detects changes the UI shows", () => {
    expect(progressChanged(null, snap())).toBe(true);
    expect(progressChanged(snap(), snap({ at: 2 }))).toBe(false);
    expect(progressChanged(snap(), snap({ doneBytes: 5 }))).toBe(true);
    expect(progressChanged(snap(), snap({ connected: false }))).toBe(true);
  });
});

describe("progressView (honest states)", () => {
  it("no data or no ComfyUI: 'progress unavailable', indeterminate, not 0%", () => {
    for (const v of [
      progressView(null),
      progressView(snap({ connected: false })),
    ]) {
      expect(v.tone).toBe("unknown");
      expect(v.percent).toBeNull();
      expect(v.title).toMatch(/Progress unavailable/);
    }
    expect(progressView(null, { lostContact: true }).detail).toMatch(
      /can't check/,
    );
  });

  it("remote before the first file: moving bar, explains why", () => {
    const v = progressView(snap());
    expect(v.percent).toBeNull();
    expect(v.detail).toMatch(/0 of 2 files ready/);
    expect(v.detail).toMatch(/this computer/);
  });

  it("remote after a file: file steps", () => {
    expect(progressView(snap({ doneFiles: 1 })).percent).toBe(50);
  });

  it("local bytes: GB counts, never shows 100 until complete", () => {
    const v = progressView(
      snap({ bytesKnown: true, doneBytes: 10 * 1024 ** 3 - 1 }),
    );
    expect(v.percent).toBe(99);
    expect(v.title).toMatch(/of 10 GB/);
  });

  it("local but no bytes yet (hf CLI writes no .part): moving bar, not 0%", () => {
    const v = progressView(snap({ bytesKnown: true, doneBytes: 0 }));
    expect(v.percent).toBeNull();
    expect(v.detail).not.toMatch(/this computer/);
  });

  it("quiet for a while: says so kindly", () => {
    expect(progressView(snap(), { quietForMs: QUIET_AFTER_MS }).detail).toMatch(
      /Nothing new for a few minutes/,
    );
    expect(progressView(snap()).detail).not.toMatch(/Nothing new/);
  });

  it("complete", () => {
    const v = progressView(snap({ complete: true, doneFiles: 2 }));
    expect(v).toMatchObject({ tone: "done", percent: 100 });
  });

  it("panel renders a progressbar and the status text", () => {
    const html = renderToStaticMarkup(
      React.createElement(PackDownloadPanel, {
        update: { progress: null, transport: "polling", lostContact: true },
        quietForMs: 0,
      }),
    );
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("Progress unavailable");
    expect(html).not.toContain("aria-valuenow");
  });
});

// ------------------------------------------------------------ client watcher

class FakeSource {
  static last: FakeSource | null = null;
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeSource.last = this;
  }
  addEventListener(t: string, fn: (e: MessageEvent) => void) {
    (this.listeners[t] ??= []).push(fn);
  }
  emit(t: string, data: unknown) {
    for (const fn of this.listeners[t] ?? [])
      fn({ data: JSON.stringify(data) } as MessageEvent);
  }
  close() {
    this.closed = true;
  }
}

describe("watchPackProgress", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses Adrift's SSE route (never a ComfyUI host) and stops on complete", () => {
    const updates: ProgressUpdate[] = [];
    const fetchImpl = vi.fn();
    watchPackProgress([ID], (u) => updates.push(u), {
      makeSource: (u) => new FakeSource(u),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const src = FakeSource.last!;
    expect(src.url).toBe(progressUrl([ID], true));
    expect(src.url.startsWith("/api/onboarding/packs/progress?")).toBe(true);
    src.emit("progress", snap({ doneFiles: 1 }));
    src.emit("complete", snap({ doneFiles: 2, complete: true }));
    expect(updates.map((u) => [u.transport, u.progress?.doneFiles])).toEqual([
      ["live", 1],
      ["live", 2],
    ]);
    expect(src.closed).toBe(true);
    src.onerror?.(new Event("error")); // server closing after complete
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stream error -> polls the JSON snapshot; failed polls keep the last data with lostContact", async () => {
    vi.useFakeTimers();
    const updates: ProgressUpdate[] = [];
    let ok = true;
    const fetchImpl = vi.fn(async () =>
      ok
        ? Response.json({ ok: true, progress: snap({ doneFiles: 1 }) })
        : new Response("down", { status: 502 }),
    );
    const stop = watchPackProgress([ID], (u) => updates.push(u), {
      makeSource: (u) => new FakeSource(u),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollMs: 1000,
    });
    const src = FakeSource.last!;
    src.onerror?.(new Event("error"));
    expect(src.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledWith(progressUrl([ID], false), {
      cache: "no-store",
    });
    expect(updates.at(-1)).toMatchObject({
      transport: "polling",
      lostContact: false,
    });
    ok = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(updates.at(-1)).toMatchObject({
      transport: "polling",
      lostContact: true,
    });
    expect(updates.at(-1)?.progress?.doneFiles).toBe(1);
    // A second stream error doesn't start a second poll loop.
    src.onerror?.(new Event("error"));
    const n = fetchImpl.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl.mock.calls.length).toBe(n + 1);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl.mock.calls.length).toBe(n + 1);
  });

  it("no EventSource at all -> polling straight away; stream timeout -> polling", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () =>
      Response.json({ ok: true, progress: snap() }),
    );
    const stop = watchPackProgress([ID], () => {}, {
      makeSource: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    stop();

    const f2 = vi.fn(async () => Response.json({ ok: true, progress: snap() }));
    const stop2 = watchPackProgress([ID], () => {}, {
      makeSource: (u) => new FakeSource(u),
      fetchImpl: f2 as unknown as typeof fetch,
    });
    FakeSource.last!.emit("timeout", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(f2).toHaveBeenCalledTimes(1);
    stop2();
  });
});

// ------------------------------------------------------------------- route

describe("/api/onboarding/packs/progress", () => {
  const BASE = "http://127.0.0.1:3000/api/onboarding/packs/progress";

  async function loadRoute(read: (ids: string[]) => Promise<PackProgress>) {
    vi.resetModules();
    vi.stubEnv("ADMIN_API_KEY", "");
    vi.stubEnv("SESSION_SECRET", "");
    vi.doMock("@/lib/rateLimit", () => ({
      withRateLimit: () => ({ ok: true }),
    }));
    vi.doMock("@/lib/onboarding/packProgress", async (orig) => ({
      ...(await orig<typeof import("@/lib/onboarding/packProgress")>()),
      readPackProgress: vi.fn(read),
    }));
    return import("@/app/api/onboarding/packs/progress/route");
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("@/lib/rateLimit");
    vi.doUnmock("@/lib/onboarding/packProgress");
  });

  const get = (q: string) =>
    new NextRequest(`${BASE}${q}`, { headers: { host: "127.0.0.1:3000" } });

  it("400 without known pack ids", async () => {
    const r = await loadRoute(async () => snap());
    expect((await r.GET(get("?packs=nope"))).status).toBe(400);
    expect((await r.GET(get(""))).status).toBe(400);
  });

  it("JSON snapshot for polling", async () => {
    const r = await loadRoute(async () => snap({ doneFiles: 1 }));
    const res = await r.GET(get(`?packs=${ID}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      progress: { doneFiles: 1 },
    });
  });

  it("stream=1: SSE progress then complete, and the stream ends", async () => {
    vi.useFakeTimers();
    let n = 0;
    const r = await loadRoute(async () =>
      ++n >= 3
        ? snap({ complete: true, doneFiles: 2 })
        : snap({ doneFiles: 1 }),
    );
    const res = await r.GET(get(`?packs=${ID}&stream=1`));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += dec.decode(value);
      }
    })();
    await vi.advanceTimersByTimeAsync(20_000);
    await pump;
    vi.useRealTimers();
    // Unchanged second snapshot is not re-sent.
    expect(text.match(/event: progress/g)?.length).toBe(1);
    expect(text).toContain("event: complete");
    expect(text.indexOf("event: progress")).toBeLessThan(
      text.indexOf("event: complete"),
    );
  });
});
