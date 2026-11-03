/**
 * Edit-tab Smart Select client: request shape, uploaded-ref reuse, stale-ref
 * fallback and error surfacing. fetch is mocked; nothing reaches ComfyUI.
 */
import { describe, it, expect, vi } from "vitest";
import { requestSmartMask } from "@/components/editor/editorSmartSelect";

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const bad = (status: number, error: string) =>
  new Response(JSON.stringify({ ok: false, error }), { status });

const base = {
  imageUrl: "/api/image/example.png",
  include: [{ x: 10, y: 20 }],
  exclude: [{ x: 1, y: 2 }],
  width: 64,
  height: 32,
};

describe("requestSmartMask", () => {
  it("uploads the image once and returns mask + ref", async () => {
    const fetchImpl = vi.fn(async () => ok({ ok: true, mask: "data:image/png;base64,AA", image: "smartmask_x.png" }));
    const toDataUrl = vi.fn(async () => "data:image/png;base64,IMG");
    const res = await requestSmartMask(base, { fetchImpl, toDataUrl });
    expect(res).toEqual({ mask: "data:image/png;base64,AA", ref: "smartmask_x.png" });
    expect(toDataUrl).toHaveBeenCalledWith(base.imageUrl);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/tools/smart-mask");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      image: "data:image/png;base64,IMG",
      include: base.include,
      exclude: base.exclude,
      width: 64,
      height: 32,
    });
  });

  it("reuses a cached ref without re-reading the image", async () => {
    const fetchImpl = vi.fn(async () => ok({ ok: true, mask: "data:m", image: "ref1" }));
    const toDataUrl = vi.fn(async () => "data:img");
    await requestSmartMask({ ...base, cachedRef: "ref1" }, { fetchImpl, toDataUrl });
    expect(toDataUrl).not.toHaveBeenCalled();
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)).image).toBe("ref1");
  });

  it("falls back to a fresh upload when the cached ref is stale", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(bad(400, "image must be a data:image URL"))
      .mockResolvedValueOnce(ok({ ok: true, mask: "data:m", image: "ref2" }));
    const toDataUrl = vi.fn(async () => "data:img");
    const res = await requestSmartMask({ ...base, cachedRef: "gone" }, { fetchImpl, toDataUrl });
    expect(res.ref).toBe("ref2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces the server error", async () => {
    const fetchImpl = vi.fn(async () => bad(504, "Timed out waiting for SAM3 (ComfyUI busy?)"));
    await expect(
      requestSmartMask(base, { fetchImpl, toDataUrl: async () => "data:img" }),
    ).rejects.toThrow(/Timed out/);
  });

  it("needs at least one include point", async () => {
    const fetchImpl = vi.fn();
    await expect(
      requestSmartMask({ ...base, include: [] }, { fetchImpl }),
    ).rejects.toThrow(/subject/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
