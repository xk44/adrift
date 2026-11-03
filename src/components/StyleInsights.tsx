"use client";

import { Check, Copy, Dna, Palette as PaletteIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { showToast } from "@/components/Toast";
import {
  extractPalette,
  paletteHexList,
  palettePromptText,
  type PaletteColor,
} from "@/lib/palette";
import {
  buildStyleDNA,
  hasStyleDNA,
  styleDNAChips,
  styleDNAPromptFlags,
} from "@/lib/styleDNA";
import { useUIStore } from "@/store";
import type { GalleryImage } from "@/types";

const SAMPLE_SIZE = 72; // downscale target for palette sampling

type PaletteState =
  | { status: "idle" | "loading" | "unavailable"; colors: [] }
  | { status: "ready"; colors: PaletteColor[] };

/**
 * Lightbox side-panel insights: a copyable "Style DNA" fingerprint and an
 * extracted color palette whose swatches inject color language into the prompt.
 * Both compose existing capabilities (metadata + prompt append); no backend.
 */
export function StyleInsights({ image }: { image: GalleryImage }) {
  const appendToPrompt = useUIStore((s) => s.appendToPrompt);
  const [dnaCopied, setDnaCopied] = useState(false);
  const [palette, setPalette] = useState<PaletteState>({
    status: "idle",
    colors: [],
  });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const chips = styleDNAChips(image);
  const showDNA = hasStyleDNA(image);
  const isStill =
    Boolean(image.url) && !image.videoUrl && !image.audioUrl && !image.meshUrl;

  // Extract palette from the image via an offscreen canvas (CORS-aware).
  useEffect(() => {
    if (!isStill || !image.url) {
      setPalette({ status: "idle", colors: [] });
      return;
    }
    let cancelled = false;
    setPalette({ status: "loading", colors: [] });

    const el = new Image();
    el.crossOrigin = "anonymous";
    el.onload = () => {
      if (cancelled) return;
      try {
        const scale = Math.min(1, SAMPLE_SIZE / Math.max(el.width, el.height));
        const w = Math.max(1, Math.round(el.width * scale));
        const h = Math.max(1, Math.round(el.height * scale));
        const canvas = canvasRef.current ?? document.createElement("canvas");
        canvasRef.current = canvas;
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("no 2d context");
        ctx.drawImage(el, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h); // throws if tainted
        const colors = extractPalette(data, 5);
        if (!cancelled) {
          setPalette(
            colors.length
              ? { status: "ready", colors }
              : { status: "unavailable", colors: [] },
          );
        }
      } catch {
        // Tainted canvas (no CORS) or decode failure — degrade quietly.
        if (!cancelled) setPalette({ status: "unavailable", colors: [] });
      }
    };
    el.onerror = () => {
      if (!cancelled) setPalette({ status: "unavailable", colors: [] });
    };
    el.src = image.url;

    return () => {
      cancelled = true;
    };
  }, [image.url, isStill]);

  const copyDNA = async () => {
    try {
      await navigator.clipboard?.writeText(buildStyleDNA(image));
      setDnaCopied(true);
      window.setTimeout(() => setDnaCopied(false), 1500);
    } catch {
      showToast("Copy failed", "error");
    }
  };

  const applyDNA = () => {
    const flags = styleDNAPromptFlags(image);
    if (!flags) {
      showToast("No style params to apply", "info");
      return;
    }
    appendToPrompt(flags);
    showToast("Style added to prompt", "success");
  };

  const useColor = (c: PaletteColor) => {
    appendToPrompt(c.name);
    showToast(`Added "${c.name}"`, "success");
  };

  const useWholePalette = () => {
    if (palette.status !== "ready") return;
    const text = palettePromptText(palette.colors);
    if (text) {
      appendToPrompt(text);
      showToast("Palette added to prompt", "success");
    }
  };

  // "#rrggbb:weight, ..." for the Video Color Palette tool's Hex colors box.
  const copyHex = async () => {
    if (palette.status !== "ready") return;
    try {
      await navigator.clipboard?.writeText(paletteHexList(palette.colors));
      showToast("Hex colors copied", "success");
    } catch {
      showToast("Copy failed", "error");
    }
  };

  if (!showDNA && !isStill) return null;

  return (
    <div className="space-y-5">
      {/* Style DNA */}
      {showDNA && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]">
              <Dna className="h-3.5 w-3.5" /> Style DNA
            </h4>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={copyDNA}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                title="Copy the full style fingerprint"
                aria-label={dnaCopied ? "Style DNA copied" : "Copy Style DNA"}
              >
                {dnaCopied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-500" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                Copy
              </button>
              <button
                type="button"
                onClick={applyDNA}
                className="rounded-md px-2 py-1 text-xs text-[var(--accent-primary)] hover:bg-[var(--bg-hover)]"
                title="Append these style params to the prompt"
                aria-label="Apply Style DNA to the prompt"
              >
                Apply
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {chips.map((c, i) => (
              <span
                key={`${c.label}-${i}`}
                className="rounded-md bg-[var(--bg-tertiary)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
                title={c.label}
              >
                <span className="text-[var(--text-muted)]">{c.label}:</span>{" "}
                {c.value}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Palette */}
      {isStill && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]">
              <PaletteIcon className="h-3.5 w-3.5" /> Palette
            </h4>
            {palette.status === "ready" && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={copyHex}
                  className="rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  title="Copy the palette as #rrggbb:weight (paste into Video Color Palette)"
                  aria-label="Copy palette hex colors"
                >
                  Copy hex
                </button>
                <button
                  type="button"
                  onClick={useWholePalette}
                  className="rounded-md px-2 py-1 text-xs text-[var(--accent-primary)] hover:bg-[var(--bg-hover)]"
                  title="Add the whole palette to the prompt"
                  aria-label="Add the whole palette to the prompt"
                >
                  Use palette
                </button>
              </div>
            )}
          </div>
          {palette.status === "loading" && (
            <p className="text-xs text-[var(--text-muted)]">Sampling colors…</p>
          )}
          {palette.status === "unavailable" && (
            <p className="text-xs text-[var(--text-muted)]">
              Palette unavailable for this image.
            </p>
          )}
          {palette.status === "ready" && (
            <div className="flex flex-wrap gap-2">
              {palette.colors.map((c) => (
                <button
                  key={c.hex}
                  type="button"
                  onClick={() => useColor(c)}
                  className="group flex items-center gap-2 rounded-lg border border-[var(--border-primary)] py-1 pl-1 pr-2 text-xs hover:bg-[var(--bg-hover)]"
                  title={`Add "${c.name}" (${c.hex}) to prompt`}
                  aria-label={`Add ${c.name} (${c.hex}) to the prompt`}
                >
                  <span
                    aria-hidden="true"
                    className="h-6 w-6 rounded-md ring-1 ring-black/10"
                    style={{ backgroundColor: c.hex }}
                  />
                  <span className="text-[var(--text-secondary)]">{c.name}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
