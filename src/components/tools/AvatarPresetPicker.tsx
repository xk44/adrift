"use client";

import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { useGenerationStore } from "@/store";
import { AVATAR_PRESETS, getAvatarPreset } from "@/lib/tools/avatarPresets";
import { generateAvatar } from "@/lib/tools/avatarGenerate";
import type { ToolImage } from "@/lib/tools/runTool";
import { groupOptions } from "@/lib/tools/toolsPage";
import { errorMessage } from "./RunnerShell";
import { field } from "./ToolRunner";

/**
 * Talking Avatar: generate an original presenter from a preset instead of
 * uploading a photo. The finished portrait becomes the source image and the
 * preset's scene line fills an empty scene prompt.
 */
export function AvatarPresetPicker({
  onImage,
  onScene,
  disabled,
}: {
  onImage: (img: ToolImage) => void;
  onScene: (scene: string) => void;
  disabled?: boolean;
}) {
  const clientId = useGenerationStore((s) => s.clientId);
  const addRun = useGenerationStore((s) => s.addRun);
  const [presetId, setPresetId] = useState(AVATAR_PRESETS[0].id);
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preset = getAvatarPreset(presetId) ?? AVATAR_PRESETS[0];

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const img = await generateAvatar(
        { fetchImpl: fetch, clientId, onRun: addRun },
        preset,
        extra,
      );
      onImage(img);
      onScene(preset.scene);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="space-y-1.5 rounded-xl border border-dashed border-light-100 p-3 dark:border-dark-750"
      data-testid="avatar-presets"
    >
      <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
        No photo? Generate an original avatar
      </span>
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Avatar preset"
          className={`${field} min-w-0 flex-1`}
          value={presetId}
          disabled={busy || disabled}
          onChange={(e) => setPresetId(e.target.value)}
        >
          {groupOptions(AVATAR_PRESETS).map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.options.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy || disabled}
          className="flex items-center gap-1.5 rounded-xl border border-splash px-3 py-2 text-xs font-medium text-splash disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {busy ? "Generating..." : "Generate"}
        </button>
      </div>
      <input
        aria-label="Avatar details"
        className={`${field} text-xs`}
        value={extra}
        maxLength={160}
        disabled={busy || disabled}
        placeholder="Optional: hair, outfit, background"
        onChange={(e) => setExtra(e.target.value)}
      />
      <p className="text-[11px] text-light-500 dark:text-dark-400">
        {preset.description}
      </p>
      {error && <p className="text-[11px] text-red-500">{error}</p>}
    </section>
  );
}
