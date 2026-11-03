import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LIGHTBOX_PARAM,
  hrefWithImage,
  imageIdFromHref,
  lightboxUrlUpdate,
} from "@/lib/ui/lightboxUrl";

const BASE = "http://localhost:3000/?view=create";
const source = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8");

describe("lightbox ?image= URL helpers", () => {
  it("reads and writes the image param without touching other params", () => {
    expect(LIGHTBOX_PARAM).toBe("image");
    expect(imageIdFromHref(BASE)).toBeNull();
    const withImg = hrefWithImage(BASE, "run1-0");
    expect(withImg).toBe("http://localhost:3000/?view=create&image=run1-0");
    expect(imageIdFromHref(withImg)).toBe("run1-0");
    expect(hrefWithImage(withImg, null)).toBe(BASE);
    expect(imageIdFromHref("http://x/?image=")).toBeNull();
    expect(imageIdFromHref("not a url")).toBeNull();
  });

  it("pushes on open, replaces on prev/next, no-ops when already in sync", () => {
    expect(lightboxUrlUpdate(BASE, null, "a")).toEqual({
      mode: "push",
      href: hrefWithImage(BASE, "a"),
    });
    const atA = hrefWithImage(BASE, "a");
    expect(lightboxUrlUpdate(atA, "a", "b")).toEqual({
      mode: "replace",
      href: hrefWithImage(BASE, "b"),
    });
    expect(lightboxUrlUpdate(atA, "a", "a")).toBeNull();
    expect(lightboxUrlUpdate(BASE, null, null)).toBeNull();
  });

  it("closing strips the param (Escape / X / backdrop all go through closeLightbox)", () => {
    const atA = hrefWithImage(BASE, "a");
    const update = lightboxUrlUpdate(atA, "a", null);
    expect(update?.mode).toBe("push");
    expect(imageIdFromHref(update!.href)).toBeNull();
    expect(update!.href).toBe(BASE);
    // Deep-linked open (prev never recorded) still clears on close.
    expect(lightboxUrlUpdate(atA, null, null)?.href).toBe(BASE);
  });

  it("URL sync is mounted outside the conditionally-rendered Lightbox", () => {
    const page = source("src/app/page.tsx");
    const lightbox = source("src/components/Lightbox.tsx");
    const hook = source("src/hooks/useLightboxUrl.ts");

    // Lightbox unmounts on close, so a hook inside it never saw the close and
    // ?image= stuck in the URL. The sync must render before the conditional.
    const sync = page.indexOf("<LightboxUrlSync />");
    const conditional = page.indexOf("{lightbox && (");
    expect(sync).toBeGreaterThan(-1);
    expect(conditional).toBeGreaterThan(sync);
    expect(lightbox).not.toContain("useLightboxUrl()");
    expect(hook).toContain("export function LightboxUrlSync");
    // No useSearchParams: an always-mounted caller must not need Suspense.
    expect(hook).not.toContain("useSearchParams");
  });
});
