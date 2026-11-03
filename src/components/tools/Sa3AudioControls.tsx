"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ToolAudio } from "@/lib/tools/runTool";
import {
  SA3_PICK,
  staleSa3PickResets,
  type Sa3ToolId,
} from "@/lib/tools/sa3Tools";
import {
  SA3_A2A_ACTION,
  SA3_EXTEND_ACTION,
  SA3_INPAINT_ACTION,
  SA3_LORA_STRENGTH,
  SA3_STRENGTH,
  addAudioRegion,
  formatAudioRegions,
  parseAudioRegions,
  sa3StrengthLabel,
  type AudioRegion,
} from "@/lib/oj/sa3Params";
import {
  audioLoraLabel,
  computePeaks,
  regionFromDrag,
  regionPercent,
  secondsAtX,
} from "@/lib/tools/audioWaveform";
import { Segmented, field } from "./ToolRunner";
import {
  SA3_QUALITY_MISSING_HINT,
  sa3EffectiveSpeed,
  sa3PackCommand,
  sa3SpeedOptions,
} from "@/lib/tools/sa3Setup";

/**
 * Extra controls for the Stable Audio 3 cards (src/lib/tools/sa3Tools.ts):
 * Fast / Quality, the optional audio LoRA, the Restyle strength words, the
 * Extend "adds N s" line and the "Fix a section" waveform picker. Values
 * live in ToolSettings.picks under SA3_PICK.
 */

type Sa3Options = { loras: string[]; quality: boolean; reachable: boolean };

// Fetched on every mount (the server caches object_info) so LoRAs trained
// while the app is open show up the next time a card opens.
function loadSa3Options(): Promise<Sa3Options> {
  return fetch("/api/tools/sa3-options")
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => ({
      loras: Array.isArray(j?.loras) ? (j.loras as string[]) : [],
      quality: j?.quality === true,
      reachable: j?.reachable === true,
    }))
    .catch(() => ({ loras: [], quality: false, reachable: false }));
}

const BARS = 120;
const hint = "text-[11px] text-light-500 dark:text-dark-400";

export function Sa3AudioControls({
  toolId,
  picks,
  setPick,
  audio,
  disabled,
}: {
  toolId: Sa3ToolId;
  picks: Record<string, string>;
  setPick: (key: string, value: string) => void;
  audio: ToolAudio | null;
  disabled?: boolean;
}) {
  const [opts, setOpts] = useState<Sa3Options>({
    loras: [],
    quality: false,
    reachable: false,
  });
  useEffect(() => {
    let alive = true;
    void loadSa3Options().then((o) => alive && setOpts(o));
    return () => {
      alive = false;
    };
  }, []);

  const speed = picks[SA3_PICK.speed] === "quality" ? "quality" : "fast";
  // A saved "quality" pick without its model, or a LoRA that no longer
  // exists, would be submitted and fail in ComfyUI: reset them.
  const resetKey = JSON.stringify(staleSa3PickResets(picks, opts));
  useEffect(() => {
    for (const [k, v] of JSON.parse(resetKey) as Array<[string, string]>)
      setPick(k, v);
  }, [resetKey, setPick]);
  const lora = picks[SA3_PICK.lora] ?? "";
  const loraStrength = Number(
    picks[SA3_PICK.loraStrength] ?? SA3_LORA_STRENGTH.default,
  );
  const strength = Number(picks.strength ?? SA3_STRENGTH.default);
  const total = Number(picks.total ?? NaN);

  return (
    <section className="space-y-4" aria-label="Audio options">
      {toolId === SA3_A2A_ACTION && Number.isFinite(strength) && (
        <p className={hint}>{sa3StrengthLabel(strength)}</p>
      )}

      {toolId === SA3_EXTEND_ACTION &&
        audio?.duration &&
        Number.isFinite(total) && (
          <p className={hint}>
            {total > audio.duration
              ? `Adds about ${Math.round(total - audio.duration)} s to the ${Math.round(audio.duration)} s you gave it.`
              : `Your audio is already ${Math.round(audio.duration)} s; set a longer length.`}
          </p>
        )}

      {toolId === SA3_INPAINT_ACTION && (
        <RegionPicker
          audio={audio}
          value={picks[SA3_PICK.regions] ?? ""}
          onChange={(v) => setPick(SA3_PICK.regions, v)}
          disabled={disabled}
        />
      )}

      {opts.reachable || opts.quality ? (
        <Sa3SpeedPicker
          quality={opts.quality}
          speed={speed}
          onChange={(id) => setPick(SA3_PICK.speed, id)}
          disabled={disabled}
        />
      ) : null}

      {opts.loras.length > 0 && (
        <div className="space-y-1.5">
          <label
            htmlFor="sa3-lora"
            className="text-xs font-medium text-light-primary dark:text-dark-primary"
          >
            Sound style (LoRA)
          </label>
          <select
            id="sa3-lora"
            className={field}
            value={opts.loras.includes(lora) ? lora : ""}
            onChange={(e) => setPick(SA3_PICK.lora, e.target.value)}
            disabled={disabled}
          >
            <option value="">None</option>
            {opts.loras.map((l) => (
              <option key={l} value={l}>
                {audioLoraLabel(l)}
              </option>
            ))}
          </select>
          <p className={hint}>
            A small add-on trained on a sound or style. Yours appear here after
            training.
          </p>
          {lora && opts.loras.includes(lora) && (
            <label className="block space-y-1.5 text-xs">
              <span className="font-medium text-light-primary dark:text-dark-primary">
                Style strength: {loraStrength}
              </span>
              <input
                type="range"
                className="w-full accent-[var(--accent-primary)]"
                min={SA3_LORA_STRENGTH.min}
                max={SA3_LORA_STRENGTH.max}
                step={0.05}
                value={loraStrength}
                onChange={(e) => setPick(SA3_PICK.loraStrength, e.target.value)}
                disabled={disabled}
              />
            </label>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Fast / Quality. Without the Quality checkpoint the option stays visible but
 * disabled, with a one-line install hint (and the command on request).
 */
export function Sa3SpeedPicker({
  quality,
  speed,
  onChange,
  disabled,
}: {
  quality: boolean;
  speed: string | undefined;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const value = sa3EffectiveSpeed(speed, quality);
  return (
    <div className="space-y-1">
      <Segmented
        label="Speed"
        value={value}
        options={sa3SpeedOptions(quality)}
        onChange={onChange}
        disabled={disabled}
      />
      {!quality ? (
        <details className={hint} data-testid="sa3-quality-missing">
          <summary className="cursor-pointer">{SA3_QUALITY_MISSING_HINT}</summary>
          <p className="mt-1">Run this in the Adrift folder, then restart ComfyUI:</p>
          <code className="mt-1 block select-all whitespace-pre-wrap break-all rounded-md bg-light-input p-1.5 font-mono dark:bg-dark-input">
            {sa3PackCommand({ quality: true })}
          </code>
        </details>
      ) : (
        value === "quality" && (
          <p className={hint}>
            Takes several times longer than Fast. Try Fast first, then switch
            when you like the idea.
          </p>
        )
      )}
    </div>
  );
}

/** Waveform strip: drag across it to mark sections; also editable as text. */
function RegionPicker({
  audio,
  value,
  onChange,
  disabled,
}: {
  audio: ToolAudio | null;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [decoded, setDecoded] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPeaks(null);
    setDecoded(null);
    if (!audio?.dataUrl) return;
    let alive = true;
    const Ctx =
      typeof window !== "undefined"
        ? (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext)
        : undefined;
    if (!Ctx) return;
    const ctx = new Ctx();
    void fetch(audio.dataUrl)
      .then((r) => r.arrayBuffer())
      .then((buf) => ctx.decodeAudioData(buf))
      .then((b) => {
        if (!alive) return;
        setPeaks(computePeaks(b.getChannelData(0), BARS));
        setDecoded(b.duration);
      })
      .catch(() => alive && setPeaks([]))
      .finally(() => void ctx.close().catch(() => {}));
    return () => {
      alive = false;
    };
  }, [audio?.dataUrl]);

  const duration = audio?.duration ?? decoded ?? 0;
  const parsed = useMemo((): { regions: AudioRegion[]; error: string } => {
    try {
      return { regions: parseAudioRegions(value), error: "" };
    } catch (e) {
      return { regions: [], error: (e as Error).message };
    }
  }, [value]);

  const secAt = (clientX: number) => {
    const el = strip.current;
    if (!el) return 0;
    const box = el.getBoundingClientRect();
    return secondsAtX(clientX - box.left, box.width, duration);
  };
  const commit = (r: AudioRegion | null) => {
    if (!r) return;
    onChange(formatAudioRegions(addAudioRegion(parsed.regions, r)));
  };
  const remove = (i: number) =>
    onChange(formatAudioRegions(parsed.regions.filter((_, j) => j !== i)));

  if (!audio) {
    return (
      <p className={hint}>
        Add the audio above, then drag across its waveform to pick the parts to
        redo.
      </p>
    );
  }

  const shown = drag ? regionFromDrag(drag.a, drag.b) : null;
  return (
    <div className="space-y-2">
      <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
        Sections to redo
      </span>
      <div
        ref={strip}
        role="group"
        aria-label="Waveform: drag across it to mark a section"
        className={`relative h-16 w-full select-none overflow-hidden rounded-lg border border-light-100 dark:border-dark-750 bg-light-input dark:bg-dark-input ${
          disabled || !duration ? "opacity-50" : "cursor-crosshair"
        }`}
        style={{ touchAction: "none" }}
        onPointerDown={(e) => {
          if (disabled || !duration) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const t = secAt(e.clientX);
          setDrag({ a: t, b: t });
        }}
        onPointerMove={(e) => {
          if (drag) setDrag({ a: drag.a, b: secAt(e.clientX) });
        }}
        onPointerUp={() => {
          if (drag) commit(regionFromDrag(drag.a, drag.b));
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}
      >
        {peaks && peaks.length > 0 && (
          <svg
            className="absolute inset-0 h-full w-full text-light-500 dark:text-dark-400"
            viewBox={`0 0 ${peaks.length} 100`}
            preserveAspectRatio="none"
            aria-hidden
          >
            {peaks.map((p, i) => {
              const h = Math.max(2, p * 90);
              return (
                <rect
                  key={i}
                  x={i + 0.15}
                  y={50 - h / 2}
                  width={0.7}
                  height={h}
                  fill="currentColor"
                />
              );
            })}
          </svg>
        )}
        {!peaks && (
          <span className={`absolute inset-0 grid place-items-center ${hint}`}>
            Reading the audio...
          </span>
        )}
        {[...parsed.regions, ...(shown ? [shown] : [])].map((r, i) => {
          const { left, width } = regionPercent(r, duration);
          return (
            <span
              key={`${i}-${r.start}`}
              className="pointer-events-none absolute inset-y-0 border-x border-splash bg-splash/20"
              style={{ left: `${left}%`, width: `${width}%` }}
            />
          );
        })}
      </div>
      {parsed.regions.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Picked sections">
          {parsed.regions.map((r, i) => (
            <span
              key={`${r.start}-${r.end}`}
              className="inline-flex items-center gap-1 rounded-full border border-splash/60 bg-splash/10 px-2.5 py-1 text-xs text-splash"
            >
              {formatAudioRegions([r])} s
              <button
                type="button"
                aria-label={`Remove ${formatAudioRegions([r])} s`}
                className="rounded-full p-0.5 hover:bg-splash/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-splash"
                onClick={() => remove(i)}
                disabled={disabled}
              >
                <X size={12} aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        className={field}
        aria-label="Sections as text, in seconds"
        placeholder="or type them, e.g. 4-8; 14.5-18"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
      <p className={hint} role={parsed.error ? "alert" : undefined}>
        {parsed.error ||
          `Only these parts are made again; the rest stays as it was, with a short fade at each edge.${
            duration
              ? ` The audio is ${Math.round(duration * 10) / 10} s long.`
              : ""
          }`}
      </p>
    </div>
  );
}
