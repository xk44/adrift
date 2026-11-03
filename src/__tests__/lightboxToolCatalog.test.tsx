import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  fetchToolCatalog,
  loadToolCatalog,
  resetToolCatalogCache,
  LightboxToolsPanel,
} from "@/components/LightboxToolsPanel";

const okBody = { ok: true, tools: [{ key: "upscale" }] };

function stubFetch(...responses: Array<Response | Error>) {
  const fn = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => resetToolCatalogCache());
afterEach(() => {
  vi.unstubAllGlobals();
  resetToolCatalogCache();
});

describe("lightbox tool catalog", () => {
  it("does not cache an HTTP error: the next call refetches", async () => {
    const fn = stubFetch(
      new Response("boom", { status: 500 }),
      new Response(JSON.stringify(okBody), { status: 200 }),
    );
    await expect(fetchToolCatalog()).rejects.toThrow("HTTP 500");
    await expect(fetchToolCatalog()).resolves.toEqual(okBody.tools);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not cache a malformed body or network failure", async () => {
    const fn = stubFetch(
      new Response(JSON.stringify({ ok: false }), { status: 200 }),
      new TypeError("Failed to fetch"),
      new Response(JSON.stringify(okBody), { status: 200 }),
    );
    await expect(fetchToolCatalog()).rejects.toThrow();
    await expect(fetchToolCatalog()).rejects.toThrow("Failed to fetch");
    await expect(fetchToolCatalog()).resolves.toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("caches a successful catalog", async () => {
    const fn = stubFetch(new Response(JSON.stringify(okBody), { status: 200 }));
    await fetchToolCatalog();
    await fetchToolCatalog();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("loadToolCatalog resolves [] on failure for legacy callers", async () => {
    stubFetch(new Response("nope", { status: 404 }));
    await expect(loadToolCatalog()).resolves.toEqual([]);
  });

  it("panel shows a loading skeleton, not 'No tools', before the catalog arrives", () => {
    stubFetch(new Response(JSON.stringify(okBody), { status: 200 }));
    const out = renderToStaticMarkup(
      createElement(LightboxToolsPanel, {
        media: "mesh",
        external: false,
        onRun: () => {},
        isRunning: () => false,
        onOpenTool: () => {},
      }),
    );
    expect(out).toContain('aria-label="Loading tools"');
    expect(out).not.toContain("No tools");
  });
});
