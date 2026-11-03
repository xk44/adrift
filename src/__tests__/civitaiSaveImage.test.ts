import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

const h = vi.hoisted(() => ({ root: "" }));
vi.mock("@/lib/env", () => ({
  env: {
    get COMFY_ROOT() {
      return h.root;
    },
  },
}));
vi.mock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));

import { POST } from "@/app/api/civitai/save-image/route";

const IMG = "https://image.civitai.com/abc/width=450/123.jpeg";
let fetchMock: Mock;

function req(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/civitai/save-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.root = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-save-"));
  fetchMock = vi.fn(
    async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(h.root, { recursive: true, force: true });
});

const explore = () => path.join(fs.realpathSync(h.root), "output", "explore");

describe("POST /api/civitai/save-image", () => {
  it("saves into output/explore and never overwrites an existing image", async () => {
    const first = await (await POST(req({ url: IMG }))).json();
    expect(first.path).toBe(path.join(explore(), "123.jpeg"));
    const second = await (await POST(req({ url: IMG }))).json();
    expect(second.path).toBe(path.join(explore(), "123-2.jpeg"));
    expect(fs.readdirSync(explore()).sort()).toEqual([
      "123-2.jpeg",
      "123.jpeg",
    ]);
  });

  it("rejects disallowed extensions and hidden/traversal names", async () => {
    for (const filename of ["evil.sh", ".bashrc.png", "x.html"]) {
      const res = await POST(req({ url: IMG, filename }));
      expect(res.status).toBe(400);
    }
    const trav = await (
      await POST(req({ url: IMG, filename: "../../a.png" }))
    ).json();
    expect(trav.path).toBe(path.join(explore(), "a.png"));
  });

  it("refuses an explore folder that links outside output/", async () => {
    const outside = path.join(h.root, "outside");
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(h.root, "output"));
    fs.symlinkSync(outside, path.join(h.root, "output", "explore"));
    const res = await POST(req({ url: IMG }));
    expect(res.status).toBe(400);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses redirects off Civitai", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/x.png" },
        }),
    );
    const res = await POST(req({ url: IMG }));
    expect(res.status).toBe(400);
  });

  it("caps size", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(new Uint8Array(1), {
          status: 200,
          headers: { "content-length": String(60 * 1024 * 1024) },
        }),
    );
    expect((await POST(req({ url: IMG }))).status).toBe(413);
  });
});
