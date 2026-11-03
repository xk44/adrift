import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const KEY = "test-admin-key-123";
let root: string;

function mockComfy(objectInfo: unknown) {
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method && init.method !== "GET") throw new Error("no POSTs");
    if (u.endsWith("/models/loras")) {
      return Response.json(["chars/alice.safetensors", "plain.safetensors"]);
    }
    if (
      u.endsWith("/object_info/AnimaRefAdapterLoader") ||
      u.endsWith("/object_info/AnimaRefAdapter")
    ) {
      return Response.json(objectInfo);
    }
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const auth = { authorization: `Bearer ${KEY}` };

beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-comfy-"));
  const loras = path.join(root, "models", "loras", "chars");
  fs.mkdirSync(loras, { recursive: true });
  fs.writeFileSync(
    path.join(loras, "alice.metadata.json"),
    JSON.stringify({ tags: ["character"], base_model: "SDXL" }),
  );
  fs.writeFileSync(path.join(loras, "alice.png"), "pngbytes");
  vi.stubEnv("ADMIN_API_KEY", KEY);
  vi.stubEnv("SESSION_SECRET", "");
  vi.stubEnv("COMFY_ROOT", root);
  vi.stubEnv("COMFY_HTTP_URL", "http://127.0.0.1:18188");
  vi.doMock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("GET /api/comfy/character-loras", () => {
  it("needs credentials", async () => {
    mockComfy({});
    const { GET } = await import("@/app/api/comfy/character-loras/route");
    const res = await GET(new NextRequest("http://localhost/api/comfy/character-loras"));
    expect(res.status).toBe(401);
  });

  it("lists LoRAs with local sidecars and detects the Anima adapter", async () => {
    const fetchMock = mockComfy({ AnimaRefAdapterLoader: { input: {} } });
    const { GET } = await import("@/app/api/comfy/character-loras/route");
    const res = await GET(
      new NextRequest("http://localhost/api/comfy/character-loras", { headers: auth }),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.local).toBe(true);
    expect(body.animaRefAdapter).toBe(true);
    expect(body.animaRefAdapterV2).toBe(false);
    expect(body.loras[0]).toMatchObject({
      filename: "chars/alice.safetensors",
      tags: ["character"],
      hasPreview: true,
    });
    expect(body.loras[1]).toMatchObject({ filename: "plain.safetensors", hasPreview: false });
    // Read-only: only GETs went to ComfyUI.
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
    }
  });

  it("detects the v2 adapter node (two-character references)", async () => {
    mockComfy({ AnimaRefAdapter: { input: {} } });
    const { GET } = await import("@/app/api/comfy/character-loras/route");
    const body = await (
      await GET(new NextRequest("http://localhost/api/comfy/character-loras", { headers: auth }))
    ).json();
    expect(body.animaRefAdapter).toBe(true);
    expect(body.animaRefAdapterV2).toBe(true);
  });

  it("remote ComfyUI: no disk reads, no Anima when missing", async () => {
    vi.stubEnv("COMFY_HTTP_URL", "http://192.0.2.10:8188");
    mockComfy({});
    const { GET } = await import("@/app/api/comfy/character-loras/route");
    const body = await (
      await GET(new NextRequest("http://localhost/api/comfy/character-loras", { headers: auth }))
    ).json();
    expect(body.local).toBe(false);
    expect(body.animaRefAdapter).toBe(false);
    expect(body.animaRefAdapterV2).toBe(false);
    expect(body.loras).toEqual([
      { filename: "chars/alice.safetensors" },
      { filename: "plain.safetensors" },
    ]);
  });
});

describe("GET /api/comfy/character-loras when ComfyUI is down", () => {
  it("502s instead of reporting an empty loras folder", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { GET } = await import("@/app/api/comfy/character-loras/route");
    const res = await GET(
      new NextRequest("http://localhost/api/comfy/character-loras", { headers: auth }),
    );
    expect(res.status).toBe(502);
  });

  it("502s when ComfyUI answers the folder listing with an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const { GET } = await import("@/app/api/comfy/character-loras/route");
    const res = await GET(
      new NextRequest("http://localhost/api/comfy/character-loras", { headers: auth }),
    );
    expect(res.status).toBe(502);
  });
});

describe("GET /api/comfy/lora-preview", () => {
  const url = (f: string) =>
    `http://localhost/api/comfy/lora-preview?filename=${encodeURIComponent(f)}`;

  it("needs credentials", async () => {
    const { GET } = await import("@/app/api/comfy/lora-preview/route");
    expect((await GET(new NextRequest(url("chars/alice.safetensors")))).status).toBe(401);
  });

  it("serves the preview next to the LoRA", async () => {
    const { GET } = await import("@/app/api/comfy/lora-preview/route");
    const res = await GET(new NextRequest(url("chars/alice.safetensors"), { headers: auth }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe("pngbytes");
  });

  it("rejects traversal, 404s missing previews and remote backends", async () => {
    const { GET } = await import("@/app/api/comfy/lora-preview/route");
    expect(
      (await GET(new NextRequest(url("../../etc/passwd"), { headers: auth }))).status,
    ).toBe(400);
    expect(
      (await GET(new NextRequest(url("plain.safetensors"), { headers: auth }))).status,
    ).toBe(404);
    vi.stubEnv("COMFY_HTTP_URL", "http://192.0.2.10:8188");
    expect(
      (await GET(new NextRequest(url("chars/alice.safetensors"), { headers: auth }))).status,
    ).toBe(404);
  });
});
