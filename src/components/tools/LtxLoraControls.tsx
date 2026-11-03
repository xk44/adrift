"use client";

import { useEffect, useState } from "react";
import {
  LTX_EXTRA_LORA_PICK,
  LTX_EXTRA_LORA_STRENGTH,
  ltxCommunityLora,
  ltxLoraChoices,
  ltxLoraLabel,
  ltxLoraStrength,
  staleLtxLoraPick,
} from "@/lib/oj/ltxCommunityLoras";
import { field } from "./ToolRunner";

/**
 * Extra LTX LoRA for the LTX-2.5 image-in cards (src/lib/oj/
 * ltxCommunityLoras.ts): an installed LTX LoRA plus its strength, stored in
 * ToolSettings.picks under LTX_EXTRA_LORA_PICK. Hidden when none is
 * installed.
 */

// Fetched on every mount (object_info is cached server side) so LoRAs added
// while the app is open show up the next time a card opens.
function loadLtxLoras(): Promise<string[] | null> {
  return fetch("/api/tools/ltx-loras")
    .then((r) => (r.ok ? r.json() : null))
    .then((j) =>
      j?.reachable === true && Array.isArray(j?.loras)
        ? (j.loras as string[])
        : null,
    )
    .catch(() => null);
}

const hint = "text-[11px] text-light-500 dark:text-dark-400";

export function LtxLoraControls({
  toolId,
  picks,
  setPick,
  disabled,
}: {
  toolId: string;
  picks: Record<string, string>;
  setPick: (key: string, value: string) => void;
  disabled?: boolean;
}) {
  // null = not known yet (or ComfyUI unreachable): keep saved picks.
  const [installed, setInstalled] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    void loadLtxLoras().then((l) => alive && setInstalled(l));
    return () => {
      alive = false;
    };
  }, []);

  const choices = installed ? ltxLoraChoices(installed, toolId) : null;
  const stale = staleLtxLoraPick(picks, choices);
  useEffect(() => {
    if (stale) setPick(LTX_EXTRA_LORA_PICK.lora, "");
  }, [stale, setPick]);

  if (!choices || choices.length === 0) return null;
  const lora = picks[LTX_EXTRA_LORA_PICK.lora] ?? "";
  const picked = choices.includes(lora) ? lora : "";
  const strength = ltxLoraStrength(
    picks[LTX_EXTRA_LORA_PICK.strength],
    picked || undefined,
  );
  const known = picked ? ltxCommunityLora(picked) : undefined;

  return (
    <div className="space-y-1.5">
      <label
        htmlFor={`ltx-lora-${toolId}`}
        className="text-xs font-medium text-light-primary dark:text-dark-primary"
      >
        Extra LTX LoRA
      </label>
      <select
        id={`ltx-lora-${toolId}`}
        className={field}
        value={picked}
        onChange={(e) => {
          const file = e.target.value;
          setPick(LTX_EXTRA_LORA_PICK.lora, file);
          // A known LoRA starts at its card strength.
          const def = file
            ? ltxCommunityLora(file)?.defaultStrength
            : undefined;
          if (typeof def === "number")
            setPick(LTX_EXTRA_LORA_PICK.strength, String(def));
        }}
        disabled={disabled}
      >
        <option value="">None</option>
        {choices.map((f) => (
          <option key={f} value={f}>
            {ltxLoraLabel(f)}
          </option>
        ))}
      </select>
      <p className={hint}>
        {known
          ? `${known.license}${known.trigger ? ` · adds "${known.trigger}" to the prompt` : ""}`
          : "An LTX-2.5 LoRA from your loras folder, applied on top of this tool."}
      </p>
      {picked && (
        <label className="block space-y-1.5 text-xs">
          <span className="font-medium text-light-primary dark:text-dark-primary">
            LoRA strength: {strength}
          </span>
          <input
            type="range"
            className="w-full accent-[var(--accent-primary)]"
            min={LTX_EXTRA_LORA_STRENGTH.min}
            max={LTX_EXTRA_LORA_STRENGTH.max}
            step={LTX_EXTRA_LORA_STRENGTH.step}
            value={strength}
            onChange={(e) =>
              setPick(LTX_EXTRA_LORA_PICK.strength, e.target.value)
            }
            disabled={disabled}
          />
        </label>
      )}
    </div>
  );
}
