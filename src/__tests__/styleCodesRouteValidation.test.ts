/**
 * Style codes route validation/auth regression tests.
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

const CODES_DB = {
  version: 1,
  codes: [
    {
      code: "123456",
      name: "older",
      tags: ["a"],
      createdAt: 1700000000000,
      useCount: 1,
      isFavorite: false,
    },
    {
      code: "999999",
      name: "newer",
      tags: ["b"],
      createdAt: 1700000001000,
      useCount: 3,
      isFavorite: true,
    },
  ],
};

type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

function request(path: string, init: NextRequestInit = {}): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, init);
}

function postRequest(body: unknown, token?: string): NextRequest {
  return request("/api/style/codes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function deleteRequest(code: string, token?: string): NextRequest {
  return request(`/api/style/codes?code=${encodeURIComponent(code)}`, {
    method: "DELETE",
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
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
  return import("@/app/api/style/codes/route");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fsMock.mkdir.mockResolvedValue(undefined);
  fsMock.writeFile.mockResolvedValue(undefined);
  fsMock.readFile.mockResolvedValue(JSON.stringify(CODES_DB));
});

describe("/api/style/codes validation and auth", () => {
  it("requires admin auth for POST and DELETE when ADMIN_API_KEY is configured", async () => {
    const { POST, DELETE } = await loadRoute("admin-key");

    const post = await POST(postRequest({ code: "123456" }));
    const del = await DELETE(deleteRequest("123456"));

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
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("rejects malformed POST bodies through shared validators", async () => {
    const { POST } = await loadRoute();

    const missingCode = await POST(postRequest({}));
    const invalidCode = await POST(postRequest({ code: "abc123" }));
    const longName = await POST(
      postRequest({ code: "123456", name: "x".repeat(129) }),
    );
    const tooManyTags = await POST(
      postRequest({
        code: "123456",
        tags: Array.from({ length: 33 }, (_, i) => `tag-${i}`),
      }),
    );
    const invalidTags = await POST(
      postRequest({ code: "123456", tags: "not-array" }),
    );
    const invalidMetadata = await POST(
      postRequest({ code: "123456", metadata: [] }),
    );
    const invalidThumb = await POST(
      postRequest({ code: "123456", thumbnailUrl: "javascript:alert(1)" }),
    );

    expect(missingCode.status).toBe(400);
    expect(await missingCode.json()).toMatchObject({
      ok: false,
      error: "Missing code",
    });
    expect(invalidCode.status).toBe(400);
    expect(await invalidCode.json()).toMatchObject({
      ok: false,
      error: "Style code must be 6-12 digits",
    });
    expect(longName.status).toBe(400);
    expect(await longName.json()).toMatchObject({
      ok: false,
      error: "name exceeds maximum length of 128 characters",
    });
    expect(tooManyTags.status).toBe(400);
    expect(await tooManyTags.json()).toMatchObject({
      ok: false,
      error: "tags exceeds maximum length of 32 items",
    });
    expect(invalidTags.status).toBe(400);
    expect(await invalidTags.json()).toMatchObject({
      ok: false,
      error: "tags must be an array",
    });
    expect(invalidMetadata.status).toBe(400);
    expect(await invalidMetadata.json()).toMatchObject({
      ok: false,
      error: "metadata must be an object",
    });
    expect(invalidThumb.status).toBe(400);
    expect(await invalidThumb.json()).toMatchObject({
      ok: false,
      error: "thumbnailUrl must be an http(s) URL",
    });
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("sanitizes valid POST bodies and writes a bounded entry", async () => {
    fsMock.readFile.mockRejectedValueOnce(new Error("missing"));
    const { POST } = await loadRoute("admin-key");

    const res = await POST(
      postRequest(
        {
          code: " 123456 ",
          name: " Test style ",
          tags: [" anime ", "anime", " portrait "],
          thumbnailUrl: "https://example.com/thumb.png",
          isFavorite: true,
          metadata: { source: "test" },
        },
        "admin-key",
      ),
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, created: true });
    expect(data.code).toMatchObject({
      code: "123456",
      name: "Test style",
      tags: ["anime", "portrait"],
      thumbnailUrl: "https://example.com/thumb.png",
      isFavorite: true,
      metadata: { source: "test" },
    });

    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(String(fsMock.writeFile.mock.calls[0][1]));
    expect(saved.codes[0]).toMatchObject(data.code);
  });

  it("validates DELETE code format before mutating", async () => {
    const { DELETE } = await loadRoute();

    const res = await DELETE(deleteRequest("abc"));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: "Style code must be 6-12 digits",
    });
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("deletes valid style codes after auth", async () => {
    const { DELETE } = await loadRoute("admin-key");

    const res = await DELETE(deleteRequest("123456", "admin-key"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deleted: "123456" });
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(String(fsMock.writeFile.mock.calls[0][1]));
    expect(saved.codes.map((entry: { code: string }) => entry.code)).toEqual([
      "999999",
    ]);
  });

  it("bounds GET pagination and falls back to safe sort/order defaults", async () => {
    const { GET } = await loadRoute();

    const res = await GET(
      request(
        "/api/style/codes?limit=1000&offset=-10&sort=unknown&order=sideways",
      ),
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.limit).toBe(250);
    expect(data.offset).toBe(0);
    expect(data.codes.map((entry: { code: string }) => entry.code)).toEqual([
      "999999",
      "123456",
    ]);
  });
});
