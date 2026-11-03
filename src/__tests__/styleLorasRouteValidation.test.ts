/**
 * LoRA shortcode route validation/auth regression tests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const fsMock = {
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
};

vi.mock("fs/promises", () => ({ default: fsMock }));

const LORAS_DB = {
  version: 1,
  curatedSets: ["anime", "photo"],
  loras: [
    {
      shortcode: "detail",
      filename: "detail.safetensors",
      displayName: "Detail",
      tags: ["sharp"],
      triggers: ["detail"],
      defaultStrength: 0.8,
      curatedSet: "photo",
      useCount: 1,
      isFavorite: false,
      metadata: { source: "seed" },
    },
    {
      shortcode: "anime",
      filename: "anime.safetensors",
      displayName: "Anime",
      tags: ["style"],
      triggers: ["anime"],
      defaultStrength: 1.2,
      curatedSet: "anime",
      useCount: 4,
      isFavorite: true,
      metadata: {},
    },
  ],
};

type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

function request(path: string, init: NextRequestInit = {}): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, init);
}

function postRequest(body: unknown, token?: string): NextRequest {
  return request("/api/style/loras", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function patchRequest(body: unknown, token?: string): NextRequest {
  return request("/api/style/loras", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function deleteRequest(shortcode: string, token?: string): NextRequest {
  return request(
    `/api/style/loras?shortcode=${encodeURIComponent(shortcode)}`,
    {
      method: "DELETE",
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    },
  );
}

async function loadRoute(adminApiKey = "") {
  vi.resetModules();
  vi.doMock("@/lib/env", () => ({
    env: {
      ADMIN_API_KEY: adminApiKey,
      COMFY_HTTP_URL: "http://127.0.0.1:8188",
      COMFY_ROOT: "/tmp/adrift-test-comfyui",
      COMFY_DEFAULT_CHECKPOINT: "",
      CIVITAI_API_URL: "https://civitai.com/api/v1",
      CIVITAI_API_KEY: "",
      CIVITAI_API_KEY_ENCRYPTED: "",
      SECRETS_PASSPHRASE: "",
      STYLEVAULT_API_URL: "http://127.0.0.1:8000",
      NODE_ENV: "test",
    },
  }));
  return import("@/app/api/style/loras/route");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fsMock.mkdir.mockResolvedValue(undefined);
  fsMock.writeFile.mockResolvedValue(undefined);
  fsMock.readFile.mockResolvedValue(JSON.stringify(LORAS_DB));
});

describe("/api/style/loras validation and auth", () => {
  it("requires admin auth for POST, DELETE, and PATCH when ADMIN_API_KEY is configured", async () => {
    const { POST, DELETE, PATCH } = await loadRoute("admin-key");

    const post = await POST(
      postRequest({ shortcode: "x", filename: "x.safetensors" }),
    );
    const del = await DELETE(deleteRequest("detail"));
    const patch = await PATCH(
      patchRequest({ shortcode: "detail", incrementUse: true }),
    );

    expect(post.status).toBe(401);
    expect(await post.json()).toMatchObject({
      ok: false,
      error: "Unauthorized",
    });
    expect(del.status).toBe(401);
    expect(await del.json()).toMatchObject({
      ok: false,
      error: "Unauthorized",
    });
    expect(patch.status).toBe(401);
    expect(await patch.json()).toMatchObject({
      ok: false,
      error: "Unauthorized",
    });
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("rejects malformed POST bodies through shared validators", async () => {
    const { POST } = await loadRoute();

    const missingShortcode = await POST(
      postRequest({ filename: "x.safetensors" }),
    );
    const missingFilename = await POST(postRequest({ shortcode: "x" }));
    const longDisplayName = await POST(
      postRequest({
        shortcode: "x",
        filename: "x.safetensors",
        displayName: "x".repeat(129),
      }),
    );
    const invalidTags = await POST(
      postRequest({
        shortcode: "x",
        filename: "x.safetensors",
        tags: "not-array",
      }),
    );
    const tooManyTriggers = await POST(
      postRequest({
        shortcode: "x",
        filename: "x.safetensors",
        triggers: Array.from({ length: 33 }, (_, i) => `trigger-${i}`),
      }),
    );
    const invalidMetadata = await POST(
      postRequest({ shortcode: "x", filename: "x.safetensors", metadata: [] }),
    );

    expect(missingShortcode.status).toBe(400);
    expect(await missingShortcode.json()).toMatchObject({
      ok: false,
      error: "Missing shortcode",
    });
    expect(missingFilename.status).toBe(400);
    expect(await missingFilename.json()).toMatchObject({
      ok: false,
      error: "Missing filename",
    });
    expect(longDisplayName.status).toBe(400);
    expect(await longDisplayName.json()).toMatchObject({
      ok: false,
      error: "displayName exceeds maximum length of 128 characters",
    });
    expect(invalidTags.status).toBe(400);
    expect(await invalidTags.json()).toMatchObject({
      ok: false,
      error: "tags must be an array",
    });
    expect(tooManyTriggers.status).toBe(400);
    expect(await tooManyTriggers.json()).toMatchObject({
      ok: false,
      error: "triggers exceeds maximum length of 32 items",
    });
    expect(invalidMetadata.status).toBe(400);
    expect(await invalidMetadata.json()).toMatchObject({
      ok: false,
      error: "metadata must be an object",
    });
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("sanitizes valid POST bodies, dedupes arrays, and clamps strength", async () => {
    fsMock.readFile.mockRejectedValueOnce(new Error("missing"));
    const { POST } = await loadRoute("admin-key");

    const res = await POST(
      postRequest(
        {
          shortcode: " lora-detail ",
          filename: " detail.safetensors ",
          displayName: " Detail Boost ",
          tags: [" sharp ", "sharp", " portrait "],
          triggers: [" detail ", "detail", " crisp "],
          defaultStrength: 3,
          curatedSet: " photo ",
          isFavorite: true,
          metadata: { source: "test" },
        },
        "admin-key",
      ),
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, created: true });
    expect(data.lora).toMatchObject({
      shortcode: "lora-detail",
      filename: "detail.safetensors",
      displayName: "Detail Boost",
      tags: ["sharp", "portrait"],
      triggers: ["detail", "crisp"],
      defaultStrength: 2,
      curatedSet: "photo",
      isFavorite: true,
      metadata: { source: "test" },
    });

    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(String(fsMock.writeFile.mock.calls[0][1]));
    expect(saved.loras[0]).toMatchObject(data.lora);
    expect(saved.curatedSets).toContain("photo");
  });

  it("validates DELETE shortcode before mutating", async () => {
    const { DELETE } = await loadRoute();

    const res = await DELETE(deleteRequest(""));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: "Missing shortcode",
    });
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("deletes valid LoRA shortcodes after auth", async () => {
    const { DELETE } = await loadRoute("admin-key");

    const res = await DELETE(deleteRequest("detail", "admin-key"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deleted: "detail" });
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(String(fsMock.writeFile.mock.calls[0][1]));
    expect(
      saved.loras.map((entry: { shortcode: string }) => entry.shortcode),
    ).toEqual(["anime"]);
  });

  it("validates PATCH body and updates allowed fields after auth", async () => {
    const { PATCH } = await loadRoute("admin-key");

    const invalidType = await PATCH(
      patchRequest({ shortcode: "detail", incrementUse: "yes" }, "admin-key"),
    );
    expect(invalidType.status).toBe(400);
    expect(await invalidType.json()).toMatchObject({
      ok: false,
      error: "incrementUse must be a boolean",
    });
    expect(fsMock.writeFile).not.toHaveBeenCalled();

    const res = await PATCH(
      patchRequest(
        { shortcode: "detail", incrementUse: true, isFavorite: true },
        "admin-key",
      ),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.lora).toMatchObject({
      shortcode: "detail",
      useCount: 2,
      isFavorite: true,
    });
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
  });

  it("bounds GET pagination and requires admin auth", async () => {
    const { GET } = await loadRoute("admin-key");

    // Unauthenticated GET is rejected
    const noAuth = await GET(
      request("/api/style/loras?limit=1000&offset=-10&search=DETAIL"),
    );
    expect(noAuth.status).toBe(401);

    // Authenticated GET succeeds with bounded params
    const res = await GET(
      request("/api/style/loras?limit=1000&offset=-10&search=DETAIL", {
        headers: { authorization: "Bearer admin-key" },
      }),
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.limit).toBe(250);
    expect(data.offset).toBe(0);
    expect(
      data.loras.map((entry: { shortcode: string }) => entry.shortcode),
    ).toEqual(["detail"]);
  });
});
