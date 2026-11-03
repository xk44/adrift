"use client";

import { useEffect } from "react";
import { Lightbox } from "@/components/Lightbox";
import { useUIStore } from "@/store";
import type { GalleryImage } from "@/types";

/** Synthetic swatch (no files needed): a two-stop gradient PNG-free SVG. */
function swatch(a: string, b: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="768" height="768" fill="url(#g)"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function item(
  i: number,
  url: string,
  extra: Partial<GalleryImage> = {},
): GalleryImage {
  return {
    id: `fixture-${i}`,
    url,
    prompt:
      "a lighthouse keeper's cat asleep on a windowsill, warm dusk light, soft film grain",
    fullPrompt:
      "a lighthouse keeper's cat asleep on a windowsill, warm dusk light, soft film grain --ar 4:5 --stylize 250 --seed 1234",
    params: ["--ar 4:5", "--stylize 250"],
    paramsMap: { ar: "4:5", stylize: 250 },
    seed: 1234 + i,
    createdAt: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
    runId: "fixture-run",
    jobIndex: i,
    width: 896,
    height: 1120,
    model: "fixture-model.safetensors",
    loras: [{ name: "fixture-lora", strength: 0.8 }],
    ...extra,
  } as GalleryImage;
}

function fixtureSet(kind: string): GalleryImage[] {
  // Real stills when copied into public/__fixtures (never committed),
  // data-URL swatches otherwise.
  const files = ["lumen", "mara", "market", "pip"];
  const stills = files.map((f, i) =>
    item(
      i,
      kind === "swatch" ? swatch("#1e3a8a", "#f59e0b") : `/__fixtures/${f}.png`,
    ),
  );
  if (kind === "video")
    return [
      item(10, "/__fixtures/lumen.png", {
        videoUrl: "/__fixtures/clip.mp4",
      }),
      ...stills,
    ];
  if (kind === "external")
    return stills.map((s) => ({
      ...s,
      runId: "",
      external: { source: "civitai", id: 1 },
    }));
  if (kind === "single") return stills.slice(0, 1);
  return stills;
}

export function LightboxFixture() {
  const openLightbox = useUIStore((s) => s.openLightbox);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const set = fixtureSet(q.get("set") ?? "stills");
    const index = Math.min(Number(q.get("i") ?? 0) || 0, set.length - 1);
    openLightbox({ images: set, index, origin: "create" });
  }, [openLightbox]);
  return (
    <div className="relative h-dvh w-full overflow-hidden bg-[var(--bg-primary)]">
      <Lightbox />
    </div>
  );
}
