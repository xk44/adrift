"use client";

/**
 * Video editor "Clip" panel (speed, volume, fades, clip actions for the
 * selected clip) and the export frame / format settings shown on the Export
 * panel. Slider drags fold into one undo step per control.
 */

import { useState } from "react";
import {
  Loader2,
  Pause,
  Repeat,
  RotateCcw,
  Scissors,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  DEFAULT_TRANSITION_SECONDS,
  MAX_FADE_SECONDS,
  MAX_SPEED,
  MAX_TRANSITION_SECONDS,
  MIN_TRANSITION_SECONDS,
  MAX_VOLUME,
  MIN_SPEED,
  OUTPUT_ASPECTS,
  clipAt,
  clipFades,
  clipLength,
  clipSpeed,
  clipVolume,
  audioFades,
  audioGain,
  audioLength,
  formatTimecode,
  removeAudioClip,
  removeClip,
  setOutputFrame,
  setTransition,
  splitAt,
  splitAudioAt,
  transitionAt,
  updateAudioClip,
  updateClip,
  type AudioFx,
  type ClipFx,
  type TransitionType,
  type EditList,
  type OutputAspect,
} from "@/lib/videoEdit/editList";
import {
  EXPORT_FORMATS,
  EXPORT_FPS,
  EXPORT_QUALITIES,
  EXPORT_RESOLUTIONS,
  type ExportSettings,
} from "@/lib/videoEdit/requests";
import {
  EXPORT_PRESETS,
  FORMAT_LABEL,
  matchExportPreset,
  presetFrame,
  type ExportPreset,
} from "@/lib/videoEdit/exportPresets";
import { useVideoEditStore } from "@/store/videoEditStore";
import { runVideoAction } from "./useVideoKeys";
import { freezeAt, reverseClip } from "./clipOps";
import {
  DEFAULT_LOUDNORM_LUFS,
  MAX_REVERSE_SECONDS,
} from "@/lib/videoEdit/ffmpegArgs";

export const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4] as const;

const label = "text-xs font-medium text-[var(--text-primary)]";
const hint = "text-[11px] text-[var(--text-muted)]";
const chip = (on: boolean) =>
  `h-7 rounded-md px-2 text-xs tabular-nums transition-colors ${
    on
      ? "bg-[var(--accent-primary)] text-white"
      : "bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
  }`;
const action =
  "flex h-8 items-center justify-center gap-1.5 rounded-lg border border-[var(--border-secondary)] px-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40";

function Slider({
  id,
  name,
  value,
  min,
  max,
  step,
  text,
  onChange,
}: {
  id: string;
  name: string;
  value: number;
  min: number;
  max: number;
  step: number;
  text: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className={label}>
          {name}
        </label>
        <span className="text-xs tabular-nums text-[var(--text-secondary)]">
          {text}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={text}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--accent-primary)]"
      />
    </div>
  );
}

export function VideoClipPanel() {
  const audioId = useVideoEditStore((s) => s.selectedAudioId);
  return audioId ? <AudioClipPanel id={audioId} /> : <VideoClipBox />;
}

function VideoClipBox() {
  const edit = useVideoEditStore((s) => s.edit) as EditList;
  const selectedClipId = useVideoEditStore((s) => s.selectedClipId);
  const inPoint = useVideoEditStore((s) => s.inPoint);
  const outPoint = useVideoEditStore((s) => s.outPoint);
  const canSplit = useVideoEditStore((s) => {
    const p = s.edit ? clipAt(s.edit, s.playhead) : null;
    return (
      !!p &&
      p.clip.id === s.selectedClipId &&
      p.offset > 0.05 &&
      p.offset < clipLength(p.clip) - 0.05
    );
  });
  const index = edit.clips.findIndex((c) => c.id === selectedClipId);
  const clip = index === -1 ? null : edit.clips[index];
  const s = () => useVideoEditStore.getState();
  const hasMarks = inPoint !== null || outPoint !== null;

  const rippleButton = (
    <button
      type="button"
      className={action}
      disabled={!hasMarks}
      onClick={() => runVideoAction({ kind: "rippleDelete" })}
      title="Remove in → out and close the gap (Shift+Delete)"
    >
      <Scissors className="h-3.5 w-3.5" aria-hidden />
      Ripple delete in / out
    </button>
  );

  if (!clip)
    return (
      <div className="flex flex-col gap-3" data-testid="video-clip-panel">
        <p className="rounded-lg bg-[var(--bg-secondary)] px-2.5 py-2 text-xs text-[var(--text-secondary)]">
          Click a clip on the timeline to change its speed, volume and fades.
        </p>
        {rippleButton}
      </div>
    );

  const fx = (patch: ClipFx, key?: string) =>
    s().apply(
      (e) => updateClip(e, clip.id, patch),
      key ? `${clip.id}:${key}` : undefined,
    );
  const speed = clipSpeed(clip);
  const volume = clipVolume(clip);
  const fades = clipFades(clip);
  const len = clipLength(clip);
  const maxFade = Math.max(0, Math.min(MAX_FADE_SECONDS, len / 2));
  const fps = clip.src.fps || 24;
  const customised =
    speed !== 1 || volume !== 1 || fades.fadeIn > 0 || fades.fadeOut > 0 || !!clip.muted;

  return (
    <div className="flex flex-col gap-4" data-testid="video-clip-panel">
      <div className="rounded-lg bg-[var(--bg-secondary)] px-2.5 py-2 text-xs">
        <p className="truncate font-medium text-[var(--text-primary)]">
          Clip {index + 1}: {clip.label || "Untitled"}
        </p>
        <p className="mt-0.5 tabular-nums text-[var(--text-muted)]">
          Source {formatTimecode(clip.in, fps)} -{" "}
          {formatTimecode(clip.out, fps)} · {len.toFixed(2)} s on the timeline
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Slider
          id="vclip-speed"
          name="Speed"
          value={speed}
          min={MIN_SPEED}
          max={MAX_SPEED}
          step={0.05}
          text={`${speed}×`}
          onChange={(v) => fx({ speed: v }, "speed")}
        />
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label="Speed presets"
        >
          {SPEED_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={speed === p}
              className={chip(speed === p)}
              onClick={() => fx({ speed: p })}
            >
              {p}×
            </button>
          ))}
        </div>
        <p className={hint}>Audio keeps its pitch. Tool cuts keep the speed.</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Slider
              id="vclip-volume"
              name="Volume"
              value={clip.muted ? 0 : Math.round(volume * 100)}
              min={0}
              max={MAX_VOLUME * 100}
              step={1}
              text={clip.muted ? "Muted" : `${Math.round(volume * 100)}%`}
              onChange={(v) =>
                fx(
                  clip.muted
                    ? { volume: v / 100, muted: false }
                    : { volume: v / 100 },
                  "volume",
                )
              }
            />
          </div>
          <button
            type="button"
            aria-pressed={clip.muted}
            aria-label={clip.muted ? "Unmute clip" : "Mute clip"}
            title="Mute (M)"
            onClick={() => fx({ muted: !clip.muted })}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          >
            {clip.muted ? (
              <VolumeX className="h-4 w-4" aria-hidden />
            ) : (
              <Volume2 className="h-4 w-4" aria-hidden />
            )}
          </button>
        </div>
        {!clip.src.hasAudio && <p className={hint}>This clip has no audio.</p>}
        {volume > 1 && !clip.muted && (
          <p className={hint}>Above 100% is heard in the export, not here.</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Slider
          id="vclip-fadein"
          name="Fade in"
          value={Math.min(fades.fadeIn, maxFade)}
          min={0}
          max={maxFade}
          step={0.05}
          text={`${fades.fadeIn.toFixed(2)} s`}
          onChange={(v) => fx({ fadeIn: v }, "fadeIn")}
        />
        <Slider
          id="vclip-fadeout"
          name="Fade out"
          value={Math.min(fades.fadeOut, maxFade)}
          min={0}
          max={maxFade}
          step={0.05}
          text={`${fades.fadeOut.toFixed(2)} s`}
          onChange={(v) => fx({ fadeOut: v }, "fadeOut")}
        />
        <p className={hint}>Fades go to / from black and silence.</p>
      </div>

      {index > 0 && <TransitionBox index={index} />}

      <ClipTimeOps clipId={clip.id} sourceLength={clip.out - clip.in} />

      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          className={action}
          disabled={!canSplit}
          onClick={() => s().apply((e) => splitAt(e, s().playhead))}
          title="Split at the playhead (S)"
        >
          <Scissors className="h-3.5 w-3.5" aria-hidden />
          Split
        </button>
        <button
          type="button"
          className={action}
          disabled={edit.clips.length <= 1}
          onClick={() => s().apply((e) => removeClip(e, clip.id))}
          title="Delete the clip (Delete)"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
          Delete
        </button>
        <button
          type="button"
          className={action}
          disabled={!customised}
          onClick={() => fx({ speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, muted: false })}
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Reset
        </button>
        {rippleButton}
      </div>
    </div>
  );
}

const TRANSITION_LABEL: Record<TransitionType, string> = {
  crossfade: "Crossfade",
  dip: "Dip to black",
};

/** The transition from the previous clip into clip `index`. */
function TransitionBox({ index }: { index: number }) {
  const edit = useVideoEditStore((s) => s.edit) as EditList;
  const clip = edit.clips[index];
  const set = clip.transitionIn;
  const live = transitionAt(edit, index);
  const s = () => useVideoEditStore.getState();
  const put = (type: TransitionType | null, d?: number, key?: string) =>
    s().apply(
      (e) =>
        setTransition(
          e,
          clip.id,
          type ? { type, d: d ?? set?.d ?? DEFAULT_TRANSITION_SECONDS } : null,
        ),
      key ? `${clip.id}:${key}` : undefined,
    );
  return (
    <div className="flex flex-col gap-1.5" data-testid="video-transition">
      <span className={label} id="vclip-trans">
        Transition from clip {index}
      </span>
      <div
        className="flex flex-wrap gap-1"
        role="group"
        aria-labelledby="vclip-trans"
      >
        <button
          type="button"
          aria-pressed={!set}
          className={chip(!set)}
          onClick={() => put(null)}
        >
          Cut
        </button>
        {(Object.keys(TRANSITION_LABEL) as TransitionType[]).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={set?.type === t}
            className={chip(set?.type === t)}
            onClick={() => put(t)}
          >
            {TRANSITION_LABEL[t]}
          </button>
        ))}
      </div>
      {set && (
        <Slider
          id="vclip-trans-d"
          name="Length"
          value={set.d}
          min={MIN_TRANSITION_SECONDS}
          max={MAX_TRANSITION_SECONDS}
          step={0.05}
          text={`${set.d.toFixed(2)} s`}
          onChange={(v) => put(set.type, v, "transition")}
        />
      )}
      {set && live && live.d < set.d - 1e-6 && (
        <p className={hint}>
          Plays as {live.d.toFixed(2)} s: a transition is never longer than
          either clip.
        </p>
      )}
      {set?.type === "crossfade" && (
        <p className={hint}>
          Centred on the cut. Where a clip has no footage past its edge, its
          edge frame is held.
        </p>
      )}
    </div>
  );
}

/** Gain, fades and actions for the selected A2 lane clip. */
function AudioClipPanel({ id }: { id: string }) {
  const edit = useVideoEditStore((s) => s.edit) as EditList;
  const canSplit = useVideoEditStore((s) => {
    const c = s.edit?.audio?.find((a) => a.id === id);
    if (!c) return false;
    const off = s.playhead - c.start;
    return off > 0.05 && off < audioLength(c) - 0.05;
  });
  const clip = edit.audio?.find((a) => a.id === id);
  if (!clip) return null;
  const s = () => useVideoEditStore.getState();
  const fx = (patch: AudioFx, key?: string) =>
    s().apply(
      (e) => updateAudioClip(e, id, patch),
      key ? `${id}:${key}` : undefined,
    );
  const gain = clip.muted ? 0 : audioGain(clip);
  const fades = audioFades(clip);
  const len = audioLength(clip);
  const maxFade = Math.max(0, Math.min(MAX_FADE_SECONDS, len / 2));
  return (
    <div className="flex flex-col gap-4" data-testid="video-audio-panel">
      <div className="rounded-lg bg-[var(--bg-secondary)] px-2.5 py-2 text-xs">
        <p className="truncate font-medium text-[var(--text-primary)]">
          Audio: {clip.label || "Untitled"}
        </p>
        <p className="mt-0.5 tabular-nums text-[var(--text-muted)]">
          At {clip.start.toFixed(2)} s · {len.toFixed(2)} s of{" "}
          {clip.src.duration.toFixed(2)} s
        </p>
      </div>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Slider
            id="vaudio-gain"
            name="Volume"
            value={Math.round(gain * 100)}
            min={0}
            max={MAX_VOLUME * 100}
            step={1}
            text={clip.muted ? "Muted" : `${Math.round(gain * 100)}%`}
            onChange={(v) =>
              fx(
                clip.muted ? { gain: v / 100, muted: false } : { gain: v / 100 },
                "gain",
              )
            }
          />
        </div>
        <button
          type="button"
          aria-pressed={!!clip.muted}
          aria-label={clip.muted ? "Unmute audio clip" : "Mute audio clip"}
          onClick={() => fx({ muted: !clip.muted })}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
        >
          {clip.muted ? (
            <VolumeX className="h-4 w-4" aria-hidden />
          ) : (
            <Volume2 className="h-4 w-4" aria-hidden />
          )}
        </button>
      </div>
      <div className="flex flex-col gap-2">
        <Slider
          id="vaudio-fadein"
          name="Fade in"
          value={Math.min(fades.fadeIn, maxFade)}
          min={0}
          max={maxFade}
          step={0.05}
          text={`${fades.fadeIn.toFixed(2)} s`}
          onChange={(v) => fx({ fadeIn: v }, "fadeIn")}
        />
        <Slider
          id="vaudio-fadeout"
          name="Fade out"
          value={Math.min(fades.fadeOut, maxFade)}
          min={0}
          max={maxFade}
          step={0.05}
          text={`${fades.fadeOut.toFixed(2)} s`}
          onChange={(v) => fx({ fadeOut: v }, "fadeOut")}
        />
        <p className={hint}>
          Mixed over the clips&apos; own sound in exports; the part past the
          last clip is cut.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          className={action}
          disabled={!canSplit}
          onClick={() => s().apply((e) => splitAudioAt(e, id, s().playhead))}
          title="Split the audio clip at the playhead"
        >
          <Scissors className="h-3.5 w-3.5" aria-hidden />
          Split
        </button>
        <button
          type="button"
          className={action}
          onClick={() => {
            s().apply((e) => removeAudioClip(e, id));
            s().selectAudio(null);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
          Delete
        </button>
      </div>
    </div>
  );
}

const FREEZE_CHOICES = [1, 2, 3];

/** Reverse the clip, or hold the frame under the playhead. */
function ClipTimeOps({
  clipId,
  sourceLength,
}: {
  clipId: string;
  sourceLength: number;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const onClip = useVideoEditStore((st) => {
    const p = st.edit ? clipAt(st.edit, st.playhead) : null;
    return !!p && p.clip.id === clipId;
  });
  const canReverse = sourceLength <= MAX_REVERSE_SECONDS + 1e-6;
  const run = async (id: string, op: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(id);
    await op();
    setBusy(null);
  };
  const icon = (id: string, Icon: typeof Pause) =>
    busy === id ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
    ) : (
      <Icon className="h-3.5 w-3.5" aria-hidden />
    );

  return (
    <div className="flex flex-col gap-1.5" data-testid="video-clip-timeops">
      <button
        type="button"
        className={action}
        disabled={!!busy || !canReverse}
        onClick={() => void run("reverse", () => reverseClip(clipId))}
        title="Play this clip backwards"
      >
        {icon("reverse", Repeat)}
        Reverse
      </button>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Freeze frame">
        <span className="mr-1 text-xs text-[var(--text-secondary)]">
          Freeze frame
        </span>
        {FREEZE_CHOICES.map((sec) => (
          <button
            key={sec}
            type="button"
            className={chip(false)}
            disabled={!!busy || !onClip}
            aria-label={`Freeze frame: hold ${sec} s at the playhead`}
            onClick={() =>
              void run(`freeze${sec}`, () =>
                freezeAt(useVideoEditStore.getState().playhead, sec),
              )
            }
          >
            {busy === `freeze${sec}` ? "..." : `${sec} s`}
          </button>
        ))}
      </div>
      <p className={hint}>
        {canReverse
          ? "Freeze holds the frame under the playhead, inserted there."
          : `Reverse works on up to ${MAX_REVERSE_SECONDS} s. Split the clip first.`}
      </p>
    </div>
  );
}

const RES_LABEL: Record<ExportSettings["resolution"], string> = {
  keep: "Source",
  "720": "720p",
  "1080": "1080p",
  "2160": "4K (2160p)",
};
const QUALITY_LABEL: Record<ExportSettings["quality"], string> = {
  high: "High",
  balanced: "Balanced",
  small: "Small file",
};

/** Export frame (crop to an aspect + focus) and size / rate / quality. */
export function ExportSettingsBox() {
  const frame = useVideoEditStore((s) => s.edit?.frame ?? null);
  const settings = useVideoEditStore((s) => s.exportSettings);
  const hasLane = useVideoEditStore((s) => (s.edit?.audio?.length ?? 0) > 0);
  const s = () => useVideoEditStore.getState();
  const setFrame = (
    next: { aspect: OutputAspect; x: number; y: number } | null,
    key?: string,
  ) => s().apply((e) => setOutputFrame(e, next), key);
  const select =
    "h-8 w-full rounded-md border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-1.5 text-xs text-[var(--text-primary)] disabled:opacity-50";
  const preset = matchExportPreset(settings, frame?.aspect ?? null);
  const applyPreset = (p: ExportPreset) => {
    s().setExportSettings(p.settings);
    const next = presetFrame(p, preset, frame);
    if (next !== undefined) setFrame(next);
  };

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-[var(--border-secondary)] p-2.5"
      data-testid="video-export-settings"
    >
      <div className="flex flex-col gap-1.5">
        <span className={label} id="vexp-preset">
          Preset
        </span>
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-labelledby="vexp-preset"
          data-testid="video-export-presets"
        >
          {EXPORT_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={preset?.id === p.id}
              title={p.hint}
              className={chip(preset?.id === p.id)}
              onClick={() => applyPreset(p)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className={hint}>{preset ? preset.hint : "Custom settings."}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className={label} id="vexp-frame">
          Frame
        </span>
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-labelledby="vexp-frame"
        >
          <button
            type="button"
            aria-pressed={!frame}
            className={chip(!frame)}
            onClick={() => setFrame(null)}
          >
            Source
          </button>
          {OUTPUT_ASPECTS.map((a) => (
            <button
              key={a}
              type="button"
              aria-pressed={frame?.aspect === a}
              className={chip(frame?.aspect === a)}
              onClick={() =>
                setFrame({ aspect: a, x: frame?.x ?? 0.5, y: frame?.y ?? 0.5 })
              }
            >
              {a}
            </button>
          ))}
        </div>
        {frame && (
          <div className="grid grid-cols-2 gap-2">
            <Slider
              id="vexp-x"
              name="Focus ←→"
              value={frame.x}
              min={0}
              max={1}
              step={0.01}
              text={`${Math.round(frame.x * 100)}%`}
              onChange={(x) => setFrame({ ...frame, x }, "frame-x")}
            />
            <Slider
              id="vexp-y"
              name="Focus ↑↓"
              value={frame.y}
              min={0}
              max={1}
              step={0.01}
              text={`${Math.round(frame.y * 100)}%`}
              onChange={(y) => setFrame({ ...frame, y }, "frame-y")}
            />
          </div>
        )}
        <p className={hint}>
          {frame
            ? "Crops every clip to fill the frame; the guide shows it on the player."
            : "Clips of other shapes are letterboxed into the first clip's frame."}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="flex flex-col gap-1">
          <span className={label}>Format</span>
          <select
            className={select}
            value={settings.format}
            onChange={(e) =>
              s().setExportSettings({
                format: e.target.value as ExportSettings["format"],
              })
            }
          >
            {EXPORT_FORMATS.map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABEL[f]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={label}>Size</span>
          <select
            className={select}
            value={settings.resolution}
            onChange={(e) =>
              s().setExportSettings({
                resolution: e.target.value as ExportSettings["resolution"],
              })
            }
          >
            {EXPORT_RESOLUTIONS.map((r) => (
              <option key={r} value={r}>
                {RES_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={label}>FPS</span>
          <select
            className={select}
            value={settings.fps}
            onChange={(e) =>
              s().setExportSettings({
                fps: Number(e.target.value) as ExportSettings["fps"],
              })
            }
          >
            {EXPORT_FPS.map((f) => (
              <option key={f} value={f}>
                {f === 0 ? "Source" : f}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={label}>Quality</span>
          <select
            className={select}
            disabled={settings.format === "prores"}
            title={
              settings.format === "prores"
                ? "ProRes 422 HQ has a fixed quality"
                : undefined
            }
            value={settings.quality}
            onChange={(e) =>
              s().setExportSettings({
                quality: e.target.value as ExportSettings["quality"],
              })
            }
          >
            {EXPORT_QUALITIES.map((q) => (
              <option key={q} value={q}>
                {QUALITY_LABEL[q]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-xs text-[var(--text-primary)]">
          <input
            type="checkbox"
            data-testid="vexp-loudnorm"
            checked={!!settings.loudnorm}
            onChange={(e) =>
              s().setExportSettings({ loudnorm: e.target.checked })
            }
          />
          Normalise loudness ({DEFAULT_LOUDNORM_LUFS} LUFS)
        </label>
        <label
          className="flex items-center gap-2 text-xs text-[var(--text-primary)]"
          title={hasLane ? undefined : "Add music or a voice-over to the A2 lane first"}
        >
          <input
            type="checkbox"
            data-testid="vexp-duck"
            disabled={!hasLane}
            checked={!!settings.duck}
            onChange={(e) => s().setExportSettings({ duck: e.target.checked })}
          />
          Duck clip sound under the audio lane
        </label>
      </div>
    </div>
  );
}
