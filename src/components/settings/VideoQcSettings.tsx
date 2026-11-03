"use client";

/**
 * Account settings card: post-render video QC (on/off, auto re-roll on
 * fail with a try cap, detection thresholds). Server setting, saved in
 * data/runtime_settings.json `videoQc`.
 */

import { useCallback, useEffect, useState } from "react";
import { showToast } from "@/components/Toast";
import {
  DEFAULT_VIDEO_QC,
  VIDEO_QC_BOUNDS,
  type VideoQcSettings,
} from "@/lib/videoQc/settings";

const API = "/api/settings/video-qc";

type NumKey = keyof typeof VIDEO_QC_BOUNDS;

const FIELDS: {
  key: Exclude<NumKey, "maxTries">;
  label: string;
  step: number;
}[] = [
  { key: "blackMinSec", label: "Black: min span (s)", step: 0.1 },
  { key: "blackPixel", label: "Black: pixel level (0-1)", step: 0.01 },
  { key: "blackFailFraction", label: "Black: fail at share", step: 0.05 },
  { key: "freezeMinSec", label: "Freeze: min span (s)", step: 0.1 },
  { key: "freezeNoiseDb", label: "Freeze: noise floor (dB)", step: 1 },
  { key: "freezeFailFraction", label: "Freeze: fail at share", step: 0.05 },
  { key: "jumpScore", label: "Jump: scene score", step: 1 },
  { key: "jumpFailCount", label: "Jump: fail at count", step: 1 },
  { key: "silenceMinSec", label: "Silence: min span (s)", step: 0.5 },
  { key: "silenceDb", label: "Silence: floor (dB)", step: 1 },
  { key: "silenceFailFraction", label: "Silence: fail at share", step: 0.05 },
  { key: "durationTolerance", label: "Duration/fps tolerance", step: 0.01 },
];

async function call(method: string, body?: unknown) {
  const res = await fetch(API, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data.ok === false)
    throw new Error(
      typeof data.error === "string" ? data.error : `HTTP ${res.status}`,
    );
  return data;
}

const inputCls =
  "w-20 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-splash disabled:opacity-50";

export function VideoQcSettingsCard() {
  const [s, setS] = useState<VideoQcSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await call("GET");
      setS(d.settings as VideoQcSettings);
    } catch {
      showToast("Couldn't load the video QC settings.", "error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: Partial<VideoQcSettings>) => {
    setSaving(true);
    try {
      const d = await call("PUT", patch);
      setS(d.settings as VideoQcSettings);
    } catch (e) {
      showToast(
        `Couldn't save: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const toggle = (
    key: "enabled" | "autoReroll",
    label: string,
    hint: string,
  ) => (
    <label className="flex items-start justify-between gap-4">
      <span className="min-w-0 flex-1">
        <span className="text-xs font-medium text-[var(--text-primary)]">
          {label}
        </span>
        <span className="mt-0.5 block text-[10px] text-pretty text-[var(--text-muted)]">
          {hint}
        </span>
      </span>
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 accent-[var(--accent-primary)]"
        disabled={!s || saving}
        checked={s?.[key] ?? DEFAULT_VIDEO_QC[key]}
        onChange={(e) => void save({ [key]: e.target.checked })}
      />
    </label>
  );

  return (
    <div className="space-y-4" data-testid="video-qc-settings">
      {toggle(
        "enabled",
        "Check finished videos",
        "Scans each new clip with ffmpeg for black or frozen stretches, sudden jumps, missing or silent audio, and length / fps / size that differ from what was asked. Results show as a QC chip on the video.",
      )}
      {toggle(
        "autoReroll",
        "Auto re-roll failed clips",
        "Resubmits a clip that fails QC with a new seed (only the bad source clip of a stitched video). Uses GPU time.",
      )}
      <div className="flex items-center justify-between gap-4">
        <label
          htmlFor="video-qc-max-tries"
          className="text-xs text-[var(--text-primary)]"
        >
          Max automatic re-rolls per clip
        </label>
        <input
          id="video-qc-max-tries"
          type="number"
          className={inputCls}
          min={VIDEO_QC_BOUNDS.maxTries.min}
          max={VIDEO_QC_BOUNDS.maxTries.max}
          step={1}
          disabled={!s || saving || !s.autoReroll}
          defaultValue={s?.maxTries ?? DEFAULT_VIDEO_QC.maxTries}
          key={`maxTries-${s?.maxTries}`}
          onBlur={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n !== s?.maxTries)
              void save({ maxTries: n });
          }}
        />
      </div>
      <button
        type="button"
        onClick={() => setAdvanced((a) => !a)}
        className="text-[10px] text-[var(--text-muted)] underline"
        aria-expanded={advanced}
      >
        {advanced ? "Hide thresholds" : "Thresholds"}
      </button>
      {advanced && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {FIELDS.map((f) => (
            <label
              key={f.key}
              className="flex items-center justify-between gap-2 text-[11px] text-[var(--text-secondary)]"
            >
              {f.label}
              <input
                type="number"
                className={inputCls}
                min={VIDEO_QC_BOUNDS[f.key].min}
                max={VIDEO_QC_BOUNDS[f.key].max}
                step={f.step}
                disabled={!s || saving}
                defaultValue={s?.[f.key] ?? DEFAULT_VIDEO_QC[f.key]}
                key={`${f.key}-${s?.[f.key]}`}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n !== s?.[f.key])
                    void save({ [f.key]: n });
                }}
              />
            </label>
          ))}
          <button
            type="button"
            disabled={!s || saving}
            onClick={() => {
              const reset: Partial<VideoQcSettings> = {};
              for (const f of FIELDS) reset[f.key] = DEFAULT_VIDEO_QC[f.key];
              void save(reset);
            }}
            className="justify-self-start rounded-md border border-[var(--border-secondary)] px-2 py-1 text-[11px] text-[var(--text-primary)] disabled:opacity-50"
          >
            Reset thresholds
          </button>
        </div>
      )}
    </div>
  );
}
