import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  firstStyleRefImage,
  isFetchableImageUrl,
  isMoodboardLocalUrl,
  readMoodboardLocalImage,
} from "@/lib/sref/styleRefImage";

const KREA = "/api/moodboards/krea?board=psy_images&file=a.jpg";

describe("isMoodboardLocalUrl", () => {
  it("accepts relative and absolute moodboard image paths", () => {
    expect(isMoodboardLocalUrl(KREA)).toBe(true);
    expect(isMoodboardLocalUrl(`http://192.168.1.5:3000${KREA}`)).toBe(true);
    expect(isMoodboardLocalUrl("/api/moodboards/upload?file=x.png")).toBe(true);
    expect(isMoodboardLocalUrl("/data/moodboard-uploads/x.png")).toBe(true);
  });
  it("rejects everything else", () => {
    expect(isMoodboardLocalUrl("/api/moodboards")).toBe(false);
    expect(isMoodboardLocalUrl("/api/comfy/image?filename=a.png")).toBe(false);
    expect(isMoodboardLocalUrl("javascript:alert(1)")).toBe(false);
    expect(isMoodboardLocalUrl("1071801197")).toBe(false);
    expect(isMoodboardLocalUrl(42)).toBe(false);
  });
});

describe("firstStyleRefImage", () => {
  it("finds a weighted moodboard url among tokens (web style-store form)", () => {
    expect(firstStyleRefImage(`${KREA}::1.5 /api/moodboards/upload?file=b.png::2`)).toBe(KREA);
  });
  it("skips style codes and keeps http urls", () => {
    expect(firstStyleRefImage("1071801197 https://x.test/a.png::1")).toBe("https://x.test/a.png");
  });
  it("returns undefined for codes only / non-strings", () => {
    expect(firstStyleRefImage("1071801197::2 random")).toBeUndefined();
    expect(firstStyleRefImage(undefined)).toBeUndefined();
  });
  it("blob urls are never fetchable", () => {
    expect(isFetchableImageUrl("blob:http://localhost/abc")).toBe(false);
  });
});

describe("readMoodboardLocalImage", () => {
  let root: string;
  const prev = process.env.KREA_MOODBOARDS_DIR;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "krea-"));
    await fs.mkdir(path.join(root, "psy_images"));
    await fs.writeFile(path.join(root, "psy_images", "a.jpg"), Buffer.from("JPEGBYTES"));
    await fs.writeFile(path.join(root, "secret.jpg"), Buffer.from("NOPE"));
    process.env.KREA_MOODBOARDS_DIR = root;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.KREA_MOODBOARDS_DIR;
    else process.env.KREA_MOODBOARDS_DIR = prev;
  });

  it("reads krea board images from disk (relative and absolute host)", async () => {
    expect((await readMoodboardLocalImage(KREA))?.toString()).toBe("JPEGBYTES");
    expect((await readMoodboardLocalImage(`http://evil.test${KREA}`))?.toString()).toBe("JPEGBYTES");
  });
  it("refuses traversal and missing files", async () => {
    expect(await readMoodboardLocalImage("/api/moodboards/krea?board=psy_images&file=../secret.jpg")).toBeNull();
    expect(await readMoodboardLocalImage("/api/moodboards/krea?board=..&file=secret.jpg")).toBeNull();
    expect(await readMoodboardLocalImage("/api/moodboards/krea?board=psy_images&file=zz.jpg")).toBeNull();
    expect(await readMoodboardLocalImage("https://x.test/a.png")).toBeNull();
  });
});
