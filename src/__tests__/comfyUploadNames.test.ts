/** B14: root-input uploads are content-addressed so jobs can't clobber each other. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { contentHashedName } from "@/lib/comfy/contentName";

describe("contentHashedName", () => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([4, 5, 6]);
  it("different bytes under the same name get different names", () => {
    expect(contentHashedName("cj_ref.png", a)).not.toBe(contentHashedName("cj_ref.png", b));
  });
  it("is stable for the same bytes, keeps the extension, idempotent", () => {
    const n = contentHashedName("clip.mp4", a);
    expect(n).toMatch(/^clip_[0-9a-f]{16}\.mp4$/);
    expect(contentHashedName("clip.mp4", a)).toBe(n);
    expect(contentHashedName(n, a)).toBe(n);
  });
});

describe("POST /api/comfy/upload naming", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/comfy/http");
    vi.doUnmock("@/lib/auth");
    vi.doUnmock("@/lib/rateLimit");
  });

  async function post(body: unknown) {
    vi.resetModules();
    const upload = vi.fn(async (_d: Uint8Array, name: string) => `${name} [input]`);
    vi.doMock("@/lib/comfy/http", () => ({ uploadImageToComfy: upload }));
    vi.doMock("@/lib/auth", () => ({ requireAdmin: () => ({ ok: true }) }));
    vi.doMock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
    const { POST } = await import("@/app/api/comfy/upload/route");
    const res = await POST(
      new NextRequest("http://localhost/api/comfy/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { res, upload };
  }

  it("two different images with the fallback name don't collide", async () => {
    const one = await post({ image: "data:image/png;base64,AAAA" });
    const two = await post({ image: "data:image/png;base64,BBBB" });
    const n1 = one.upload.mock.calls[0][1];
    const n2 = two.upload.mock.calls[0][1];
    expect(n1).toMatch(/^cj_ref_[0-9a-f]{16}\.png$/);
    expect(n1).not.toBe(n2);
  });

  it("training subfolder uploads keep their clip names", async () => {
    const { upload } = await post({
      image: "data:audio/wav;base64,AAAA",
      filename: "01_a.wav",
      subfolder: "sa3_train/d",
    });
    expect(upload.mock.calls[0][1]).toBe("01_a.wav");
  });
});
