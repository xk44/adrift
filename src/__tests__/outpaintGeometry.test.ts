import { describe, it, expect } from "vitest";
import {
  OutpaintError,
  applyMaskFill,
  applyOutpaintPlan,
  parseAspect,
  planOutpaint,
  readImageSize,
} from "@/lib/tools/outpaint";
import sharp from "sharp";

const sides = (l: number, r: number, t: number, b: number) =>
  ({ kind: "sides", sides: { left: l, right: r, top: t, bottom: b } }) as const;

describe("parseAspect", () => {
  it.each([
    ["16:9", 16 / 9],
    ["1:1", 1],
    ["3/4", 0.75],
    [2, 2],
    ["1.5", 1.5],
  ])("%s", (raw, expected) => {
    expect(parseAspect(raw)).toBeCloseTo(expected as number);
  });
  it.each(["", "abc", "0:5", "100:1", "1:100", 0, -1, null, {}])(
    "rejects %s",
    (raw) => expect(parseAspect(raw)).toBeNull(),
  );
});

describe("planOutpaint sides", () => {
  it("pads each side by a fraction of its axis and rounds the canvas to 16", () => {
    const p = planOutpaint(1024, 768, sides(0.25, 0.25, 0, 0));
    expect(p).toMatchObject({
      left: 256,
      right: 256,
      top: 0,
      bottom: 0,
      width: 1536,
      height: 768,
      scale: 1,
    });
  });

  it("slack from rounding lands on right/bottom", () => {
    const p = planOutpaint(1000, 1000, sides(0.1, 0, 0, 0.1));
    expect(p.width % 16).toBe(0);
    expect(p.height % 16).toBe(0);
    expect(p.left).toBe(100);
    expect(p.right).toBe(p.width - 1000 - 100);
    expect(p.bottom).toBe(p.height - 1000);
    expect(p.top).toBe(0);
  });

  it("downscales the source when the canvas exceeds the pixel cap", () => {
    const p = planOutpaint(4000, 4000, sides(0.5, 0.5, 0.5, 0.5), {
      maxCanvasPixels: 2048 * 2048,
    });
    expect(p.scale).toBeLessThan(1);
    expect(p.width * p.height).toBeLessThanOrEqual(2048 * 2048 + 2 * 16 * 2100);
    expect(p.left + p.srcWidth + p.right).toBe(p.width);
    expect(p.top + p.srcHeight + p.bottom).toBe(p.height);
  });

  it("rejects zero padding, negatives and >100%", () => {
    expect(() => planOutpaint(512, 512, sides(0, 0, 0, 0))).toThrow(OutpaintError);
    expect(() => planOutpaint(512, 512, sides(-0.1, 0, 0, 0))).toThrow(OutpaintError);
    expect(() => planOutpaint(512, 512, sides(1.5, 0, 0, 0))).toThrow(OutpaintError);
    expect(() => planOutpaint(0, 512, sides(0.5, 0, 0, 0))).toThrow(OutpaintError);
  });
});

describe("planOutpaint aspect", () => {
  it("widens a square to 16:9 centered", () => {
    const p = planOutpaint(1024, 1024, { kind: "aspect", aspect: 16 / 9, anchor: "center" });
    expect(p.top).toBe(0);
    expect(p.bottom).toBe(0);
    expect(p.left).toBe(p.right === p.left ? p.left : p.left);
    expect(p.width / p.height).toBeCloseTo(16 / 9, 1);
    expect(Math.abs(p.left - p.right)).toBeLessThanOrEqual(16);
  });

  it("heightens a landscape image to 9:16", () => {
    const p = planOutpaint(1600, 900, { kind: "aspect", aspect: 9 / 16, anchor: "center" });
    expect(p.left).toBe(0);
    expect(p.right).toBe(0);
    expect(p.height).toBeGreaterThan(p.width);
    expect(p.width / p.height).toBeCloseTo(9 / 16, 1);
  });

  it("anchor left puts all padding on the right", () => {
    const p = planOutpaint(1000, 1000, { kind: "aspect", aspect: 2, anchor: "left" });
    expect(p.left).toBe(0);
    expect(p.right).toBeGreaterThanOrEqual(1000);
  });

  it("anchor bottom puts all padding on top", () => {
    const p = planOutpaint(1000, 1000, { kind: "aspect", aspect: 0.5, anchor: "bottom" });
    expect(p.bottom).toBe(0);
    expect(p.top).toBeGreaterThanOrEqual(1000);
  });

  it("same aspect adds no padding", () => {
    expect(() =>
      planOutpaint(1600, 900, { kind: "aspect", aspect: 16 / 9, anchor: "center" }),
    ).toThrow(/no padding/);
  });
});

describe("pixel ops", () => {
  const red = (w: number, h: number) =>
    sharp({ create: { width: w, height: h, channels: 3, background: { r: 255, g: 0, b: 0 } } })
      .png()
      .toBuffer();

  it("pads with #808080 and keeps the source in place", async () => {
    const src = await red(32, 32);
    const plan = planOutpaint(32, 32, sides(0.5, 0, 0, 0.5));
    const out = await applyOutpaintPlan(src, plan);
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([plan.width, plan.height]);
    const raw = await sharp(out).removeAlpha().raw().toBuffer();
    const px = (x: number, y: number) => {
      const i = (y * plan.width + x) * 3;
      return [raw[i], raw[i + 1], raw[i + 2]];
    };
    expect(px(0, 0)).toEqual([128, 128, 128]); // left pad
    expect(px(plan.left + 1, 1)).toEqual([255, 0, 0]); // source
    expect(px(plan.left + 1, plan.height - 1)).toEqual([128, 128, 128]); // bottom pad
  });

  it("flattens transparency onto gray", async () => {
    const src = await sharp({
      create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const plan = planOutpaint(16, 16, sides(1, 0, 0, 0));
    const out = await applyOutpaintPlan(src, plan);
    const raw = await sharp(out).removeAlpha().raw().toBuffer();
    expect([raw[0], raw[1], raw[2]]).toEqual([128, 128, 128]);
    const i = (2 * plan.width + plan.left + 2) * 3;
    expect([raw[i], raw[i + 1], raw[i + 2]]).toEqual([128, 128, 128]);
  });

  it("reads image size", async () => {
    expect(await readImageSize(await red(40, 24))).toEqual({ width: 40, height: 24 });
  });

  it("fills the masked region black, rest untouched (mask resized)", async () => {
    const src = await red(8, 8);
    // 4x4 mask: top-left 2x2 white
    const maskRaw = Buffer.alloc(16, 0);
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) maskRaw[y * 4 + x] = 255;
    const mask = await sharp(maskRaw, { raw: { width: 4, height: 4, channels: 1 } })
      .png()
      .toBuffer();
    const out = await applyMaskFill(src, mask);
    expect([out.width, out.height]).toEqual([8, 8]);
    const raw = await sharp(out.png).removeAlpha().raw().toBuffer();
    const px = (x: number, y: number) => {
      const i = (y * 8 + x) * 3;
      return [raw[i], raw[i + 1], raw[i + 2]];
    };
    expect(px(0, 0)).toEqual([0, 0, 0]);
    expect(px(3, 3)).toEqual([0, 0, 0]);
    expect(px(4, 4)).toEqual([255, 0, 0]);
    expect(px(7, 0)).toEqual([255, 0, 0]);
  });

  it("treats white strokes on a transparent mask as fill", async () => {
    const src = await red(4, 4);
    const rgba = Buffer.alloc(4 * 4 * 4, 0);
    rgba.set([255, 255, 255, 255], 0); // pixel (0,0) opaque white
    const mask = await sharp(rgba, { raw: { width: 4, height: 4, channels: 4 } })
      .png()
      .toBuffer();
    const out = await applyMaskFill(src, mask);
    const raw = await sharp(out.png).removeAlpha().raw().toBuffer();
    expect([raw[0], raw[1], raw[2]]).toEqual([0, 0, 0]);
    expect([raw[3], raw[4], raw[5]]).toEqual([255, 0, 0]);
  });

  it("rejects an empty mask", async () => {
    const src = await red(4, 4);
    const mask = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    await expect(applyMaskFill(src, mask)).rejects.toThrow(/empty/);
  });
});
