"use client";

import { createContext, useContext, useMemo } from "react";
import {
  Aperture,
  AudioLines,
  AudioWaveform,
  BookOpen,
  Box,
  Boxes,
  Brush,
  Camera,
  Clapperboard,
  Contrast,
  Droplets,
  Eraser,
  Expand,
  Film,
  Flame,
  ImageOff,
  Languages,
  Layers,
  LayoutGrid,
  Lightbulb,
  Maximize2,
  Mic,
  Moon,
  Music,
  PencilLine,
  PencilRuler,
  Paintbrush,
  Palette,
  PenTool,
  PersonStanding,
  Repeat,
  Replace,
  ScanText,
  Scissors,
  Shirt,
  SlidersHorizontal,
  Smile,
  Sparkles,
  Spline,
  Timer,
  Type,
  Users,
  UserSquare,
  Wand,
  WandSparkles,
  Waves,
  Wrench,
  Zap,
  ZoomIn,
  type LucideIcon,
} from "lucide-react";
import type { HubCard } from "@/lib/tools/hub";
import { previewKey } from "@/lib/tools/ltxShowcase";
import { coverBackground, coverSpec } from "@/lib/tools/hubVisuals";
import { ToolPreviewMedia } from "./ToolPreviewMedia";

export const TOOL_ICONS: Record<string, LucideIcon> = {
  Aperture,
  AudioLines,
  AudioWaveform,
  BookOpen,
  Box,
  Boxes,
  Brush,
  Camera,
  Clapperboard,
  Contrast,
  Droplets,
  Eraser,
  Expand,
  Film,
  Flame,
  ImageOff,
  Languages,
  Layers,
  LayoutGrid,
  Lightbulb,
  Maximize2,
  Mic,
  Moon,
  Music,
  PencilLine,
  PencilRuler,
  Paintbrush,
  Palette,
  PenTool,
  PersonStanding,
  Repeat,
  Replace,
  ScanText,
  Scissors,
  Shirt,
  SlidersHorizontal,
  Smile,
  Sparkles,
  Spline,
  Timer,
  Type,
  Users,
  UserSquare,
  Wand,
  WandSparkles,
  Waves,
  Wrench,
  Zap,
  ZoomIn,
};

/** The hub card a runner was opened from (header art, badges). */
export const RunnerCardContext = createContext<HubCard | null>(null);

export function useRunnerCard(): HubCard | null {
  return useContext(RunnerCardContext);
}

/**
 * Procedural cover: a quiet, low-saturation wash per card + the tool's
 * icon. No pattern overlay (it read as a grid behind every card). No image
 * assets, so it is safe to ship publicly and costs no bytes. The wash is toned down (not a neon gradient) so a grid of
 * covers without previews reads like a calm image wall, not a palette.
 * A preview listed in lib/tools/toolPreviews.json (still or muted loop from
 * public/tool-previews/) paints over it; the wash stays the fallback.
 */
export function ToolCover({
  card,
  size = "md",
  className = "",
  muted = false,
  noPreview = false,
  hueSlot,
}: {
  card: Pick<HubCard, "key" | "hubCategory" | "icon">;
  size?: "sm" | "md" | "lg";
  className?: string;
  muted?: boolean;
  /** Keep the procedural cover even when a preview exists. */
  noPreview?: boolean;
  /** Palette slot from spreadHueSlots (section-aware); hash pick otherwise. */
  hueSlot?: number;
}) {
  const Icon = TOOL_ICONS[card.icon] ?? Wrench;
  const bg = useMemo(
    () => coverBackground(coverSpec(card, hueSlot)),
    [card.key, card.hubCategory, hueSlot], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const iconCls =
    size === "lg" ? "h-9 w-9" : size === "sm" ? "h-4 w-4" : "h-6 w-6";
  return (
    <span
      aria-hidden
      className={`relative isolate flex items-center justify-center overflow-hidden bg-[#141416] ${
        muted ? "saturate-[0.55] brightness-[0.85]" : ""
      } ${className}`}
    >
      {/* Wash on its own layer so the filter never dims a preview above it. */}
      <span
        className="absolute inset-0 -z-20 saturate-[0.55] brightness-[0.78]"
        style={{ background: bg }}
      />
      <Icon
        className={`${iconCls} text-white/60 transition-[color,transform] duration-300 ease-[cubic-bezier(0.2,0,0,1)] group-hover:scale-105 group-hover:text-white/85 motion-reduce:transition-none`}
        strokeWidth={size === "sm" ? 2 : 1.25}
      />
      {!noPreview && (
        <ToolPreviewMedia cardKey={previewKey(card)} size={size} />
      )}
      <span className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]" />
    </span>
  );
}
