"use client";

/**
 * Account settings card: upscaler of choice. Default model per content type
 * (photo / illustration / video frames), Faithful output scale, and the lock
 * that makes every tool and workflow use them, plus the "Upscale after"
 * default for tool runners. Server setting
 * (/api/settings/upscaler), applied when a job is queued.
 */

import { useState } from "react";
import { showToast } from "@/components/Toast";
import {
  UpscaleModelPicker,
  useUpscalerDefaults,
} from "@/components/upscale/UpscaleModelPicker";
import {
  UPSCALE_CONTENTS,
  UPSCALE_CONTENT_LABELS,
} from "@/lib/upscale/upscalerCatalog";
import { saveUpscalerDefaults } from "@/lib/upscale/upscalerDefaultsClient";

const selectCls =
  "rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-splash disabled:opacity-50";

export function UpscalerSettings() {
  const d = useUpscalerDefaults();
  const [saving, setSaving] = useState(false);

  const save = async (patch: Record<string, unknown>) => {
    setSaving(true);
    try {
      await saveUpscalerDefaults(patch);
    } catch (e) {
      showToast(
        `Couldn't save: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const locked = d?.locked ?? true;
  const after = d?.pref.after === true;

  return (
    <div className="space-y-3" data-testid="upscaler-settings">
      <p className="text-[10px] text-pretty text-[var(--text-muted)]">
        The model used whenever Adrift upscales. Recommended picks the best
        installed one; models that are not on the server are skipped and the
        workflow&apos;s own is kept.
      </p>
      {UPSCALE_CONTENTS.map((c) => (
        <UpscaleModelPicker
          key={c}
          variant="default"
          content={c}
          label={UPSCALE_CONTENT_LABELS[c]}
          value={d?.pref[c] ?? ""}
          onChange={(m) => void save({ [c]: m || null })}
          compact
        />
      ))}

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <label
            htmlFor="upscaler-scale"
            className="text-xs font-medium text-[var(--text-primary)]"
          >
            Faithful upscale size
          </label>
          <p className="mt-0.5 text-[10px] text-pretty text-[var(--text-muted)]">
            Model follows the model&apos;s own factor (most are 4×).
          </p>
        </div>
        <select
          id="upscaler-scale"
          className={selectCls}
          disabled={d == null || saving}
          value={d?.pref.scale ? String(d.pref.scale) : ""}
          onChange={(e) =>
            void save({ scale: e.target.value ? Number(e.target.value) : null })
          }
        >
          <option value="">Model</option>
          <option value="2">2×</option>
          <option value="4">4×</option>
        </select>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <span
            id="upscaler-lock-label"
            className="text-xs font-medium text-[var(--text-primary)]"
          >
            Lock in for every tool
          </span>
          <p className="mt-0.5 text-[10px] text-pretty text-[var(--text-muted)]">
            On: every workflow&apos;s 2×+ upscaler uses these models unless the
            tool fixes its own. Off: only the Upscale actions do.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={locked}
          aria-labelledby="upscaler-lock-label"
          disabled={d == null || saving}
          onClick={() => void save({ lock: !locked })}
          className={`relative h-5 w-10 flex-shrink-0 rounded-full transition-colors duration-200 disabled:opacity-50 ${
            locked ? "bg-splash" : "bg-light-200 dark:bg-dark-600"
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
              locked ? "translate-x-5" : ""
            }`}
          />
        </button>
      </div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <span
            id="upscaler-after-label"
            className="text-xs font-medium text-[var(--text-primary)]"
          >
            Upscale after tools
          </span>
          <p className="mt-0.5 text-[10px] text-pretty text-[var(--text-muted)]">
            Edit and video tools upscale their result when they finish, with
            the models above. Stills go 4× when Faithful size is 4×, else 2×;
            clips 2×. Tools that upscale already are skipped. Each tool can
            change it.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={after}
          aria-labelledby="upscaler-after-label"
          data-testid="upscaler-after-switch"
          disabled={d == null || saving}
          onClick={() => void save({ after: !after })}
          className={`relative h-5 w-10 flex-shrink-0 rounded-full transition-colors duration-200 disabled:opacity-50 ${
            after ? "bg-splash" : "bg-light-200 dark:bg-dark-600"
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
              after ? "translate-x-5" : ""
            }`}
          />
        </button>
      </div>
      {d && !d.available && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          ComfyUI is offline, so installed models can&apos;t be listed. Saved
          choices still apply when it&apos;s back.
        </p>
      )}
    </div>
  );
}
