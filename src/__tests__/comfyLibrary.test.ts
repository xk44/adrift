/**
 * ComfyUI user-library import (read-only /api/userdata) and the remote combo
 * route allowlist, with a mocked fetch.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  fetchComfyLibraryWorkflow,
  isAllowedRemoteRoute,
  isSafeLibraryPath,
  listComfyLibrary,
  normalizeRemoteOptions,
} from "@/lib/comfy/comfyLibrary";

const BASE = "http://comfy.test";
const nested = fs.readFileSync(
  path.join(__dirname, "fixtures", "subgraphs", "nested.json"),
  "utf8",
);

function mockFetch(routes: Record<string, { status?: number; body: string }>) {
  return vi.fn(async (url: string) => {
    const r = routes[url];
    if (!r) return new Response("not found", { status: 404 });
    return new Response(r.body, { status: r.status ?? 200 });
  });
}

const LIST_URL = `${BASE}/api/userdata?dir=workflows&recurse=true&split=false&full_info=true`;
const fileUrl = (f: string) =>
  `${BASE}/api/userdata/${encodeURIComponent(`workflows/${f}`)}`;

describe("isSafeLibraryPath", () => {
  it.each([
    ["a.json", true],
    ["3d/Figure.json", true],
    ["../secret.json", false],
    ["a/../../b.json", false],
    ["/abs.json", false],
    ["a\\b.json", false],
    ["a.txt", false],
    ["", false],
    ["a//b.json", false],
  ])("%s → %s", (p, ok) => expect(isSafeLibraryPath(p)).toBe(ok));
});

describe("listComfyLibrary", () => {
  it("lists full_info entries sorted, dropping unsafe/non-json", async () => {
    const f = mockFetch({
      [LIST_URL]: {
        body: JSON.stringify([
          { path: "z/b.json", size: 10, modified: 1 },
          "a.json",
          { path: "../evil.json" },
          { path: "notes.txt" },
        ]),
      },
    });
    const list = await listComfyLibrary(BASE, f);
    expect(list.map((e) => e.path)).toEqual(["a.json", "z/b.json"]);
    expect(list[1]).toMatchObject({ name: "b", folder: "z", size: 10 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("404 (no workflows dir) → empty list", async () => {
    expect(await listComfyLibrary(BASE, mockFetch({}))).toEqual([]);
  });

  it("other HTTP errors throw", async () => {
    const f = mockFetch({ [LIST_URL]: { status: 500, body: "x" } });
    await expect(listComfyLibrary(BASE, f)).rejects.toThrow(/HTTP 500/);
  });
});

describe("fetchComfyLibraryWorkflow", () => {
  it("loads a subgraph workflow and reports flattened node count", async () => {
    const f = mockFetch({ [fileUrl("dir/nested.json")]: { body: nested } });
    const wf = await fetchComfyLibraryWorkflow(BASE, "dir/nested.json", f);
    expect(wf).toMatchObject({
      name: "nested",
      format: "ui",
      subgraphCount: 2,
    });
    expect(wf.nodeCount).toBeGreaterThan(0);
    expect(f.mock.calls[0][0]).toContain("workflows%2Fdir%2Fnested.json");
  });

  it("rejects unsafe paths without fetching", async () => {
    const f = mockFetch({});
    await expect(
      fetchComfyLibraryWorkflow(BASE, "../x.json", f),
    ).rejects.toThrow(/Invalid library path/);
    expect(f).not.toHaveBeenCalled();
  });

  it("404 / invalid JSON give specific messages", async () => {
    await expect(
      fetchComfyLibraryWorkflow(BASE, "gone.json", mockFetch({})),
    ).rejects.toThrow(/"gone.json" is not in the ComfyUI library/);
    const bad = mockFetch({ [fileUrl("bad.json")]: { body: "{nope" } });
    await expect(
      fetchComfyLibraryWorkflow(BASE, "bad.json", bad),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("graph errors carry the WorkflowGraphError code", async () => {
    const broken = JSON.parse(nested);
    broken.definitions.subgraphs = [broken.definitions.subgraphs[0]];
    const f = mockFetch({
      [fileUrl("broken.json")]: { body: JSON.stringify(broken) },
    });
    const err = await fetchComfyLibraryWorkflow(BASE, "broken.json", f).catch(
      (e) => e,
    );
    expect(err.message).toMatch(/^Can't import "broken.json": /);
    expect(err.code).toBe("missing_subgraph");
  });
});

describe("remote combo routes", () => {
  it.each([
    ["/internal/files/output", true],
    ["/api/models/loras", true],
    ["/prompt", false],
    ["/api/prompt", false],
    ["/api/queue", false],
    ["/api/userdata/x", false],
    ["/internal/../prompt", false],
    ["https://evil.test/x", false],
    ["/internal/files?x=1", false],
    [42, false],
  ])("%s → %s", (r, ok) => expect(isAllowedRemoteRoute(r)).toBe(ok));

  it("normalizes option payloads", () => {
    expect(normalizeRemoteOptions(["a", 2])).toEqual(["a", "2"]);
    expect(
      normalizeRemoteOptions([
        { value: "v" },
        { name: "n" },
        { filename: "f" },
        {},
      ]),
    ).toEqual(["v", "n", "f"]);
    expect(normalizeRemoteOptions({ files: ["x"] }, "files")).toEqual(["x"]);
    expect(normalizeRemoteOptions({ files: ["x"] })).toEqual([]);
    expect(normalizeRemoteOptions(null)).toEqual([]);
  });
});
