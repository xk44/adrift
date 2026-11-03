"use client";

import { Cpu } from "lucide-react";
import { memoryGb } from "@/lib/models/compat";
import { useFitsFilterStore } from "@/store/fitsFilterStore";
import { useBackendProfile } from "./useBackendProfile";

/**
 * "Fits my GPU" pill for the model filter row. Off by default; disabled with
 * a tooltip until the connected ComfyUI reports its GPU.
 */
export function FitsMyGpuToggle() {
  const { profile, status } = useBackendProfile();
  const fitsOnly = useFitsFilterStore((s) => s.fitsOnly);
  const setFitsOnly = useFitsFilterStore((s) => s.setFitsOnly);
  const on = fitsOnly && profile !== null;
  const title = profile
    ? on
      ? `Showing models that should run on your ${profile.displayName} (${memoryGb(profile)} GB). Ballpark estimate; click to show all.`
      : `Hide models too big for your ${profile.displayName} (${memoryGb(profile)} GB).`
    : status === "loading"
      ? "Checking your GPU…"
      : "Connect to ComfyUI to see which models fit your GPU.";
  return (
    <button
      type="button"
      onClick={() => setFitsOnly(!fitsOnly)}
      disabled={!profile}
      aria-pressed={on}
      title={title}
      data-testid="fits-my-gpu"
      className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        on
          ? "bg-[color-mix(in_srgb,var(--accent-primary)_14%,transparent)] text-[var(--accent-primary)]"
          : "text-[var(--text-muted)] shadow-[inset_0_0_0_1px_var(--border-primary)] hover:text-[var(--text-secondary)]"
      }`}
    >
      <Cpu className="h-3.5 w-3.5" />
      Fits my GPU
    </button>
  );
}
