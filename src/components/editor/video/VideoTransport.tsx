"use client";

/**
 * Transport bar: play / frame step / J-K-L shuttle, timecode, speed, loop,
 * in / out marks and the clip edits (split, delete, mute, undo / redo).
 * Buttons run the same actions as the keyboard shortcuts.
 */

import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Keyboard,
  Pause,
  Play,
  Redo2,
  Repeat,
  Scissors,
  Sparkles,
  Trash2,
  Undo2,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  clipAt,
  clipLength,
  formatTimecode,
  timelineDuration,
  type EditList,
} from "@/lib/videoEdit/editList";
import { VIDEO_SHORTCUTS, type VideoKeyAction } from "@/lib/videoEdit/keys";
import { isNtscRate } from "@/lib/videoEdit/ffmpegArgs";
import {
  playheadFps,
  SPEEDS,
  useVideoEditStore,
} from "@/store/videoEditStore";
import { runVideoAction } from "./useVideoKeys";

/** Show the Tools panel's "Effects (LTX)" row for the selected clip. */
export function openLtxEffects(): void {
  useVideoEditStore.getState().setPanel("tools");
  if (typeof window === "undefined") return;
  window.requestAnimationFrame(() => {
    const el = document.getElementById("video-ltx-effects");
    el?.scrollIntoView({ block: "nearest" });
    el?.focus({ preventScroll: true });
  });
}

function IconButton({
  label,
  shortcut,
  onClick,
  disabled,
  pressed,
  children,
  className = "",
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      aria-keyshortcuts={shortcut}
      title={shortcut ? `${label} (${shortcut})` : label}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-9 min-w-9 items-center justify-center rounded-lg px-2 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-35 disabled:hover:bg-transparent md:h-8 md:min-w-8 ${
        pressed ? "bg-[var(--bg-hover)] text-[var(--accent-primary)]" : ""
      } ${className}`}
    >
      {children}
    </button>
  );
}

const run = (a: VideoKeyAction) => () => runVideoAction(a);

function MarkButton({
  label,
  value,
  fps,
  shortcut,
  onClick,
}: {
  label: string;
  value: number | null;
  fps: number;
  shortcut: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-keyshortcuts={shortcut}
      title={`Mark ${label.toLowerCase()} at the playhead (${shortcut})`}
      aria-label={`Mark ${label.toLowerCase()}${value !== null ? `, now ${formatTimecode(value, fps)}` : ""}`}
      className="flex h-9 items-center gap-1 rounded-lg px-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] md:h-8"
    >
      <span className="font-semibold">{label}</span>
      <span className="hidden font-mono tabular-nums text-[var(--text-muted)] sm:inline">
        {value !== null ? formatTimecode(value, fps) : "--"}
      </span>
    </button>
  );
}

/** The only part of the transport that changes every frame. */
function PlayheadTimecode({ fps }: { fps: number }) {
  const playhead = useVideoEditStore((s) => s.playhead);
  return (
    <span data-testid="video-timecode">{formatTimecode(playhead, fps)}</span>
  );
}

export function VideoTransport({ compact = false }: { compact?: boolean }) {
  const edit = useVideoEditStore((s) => s.edit) as EditList;
  const rate = useVideoEditStore((s) => s.rate);
  // Derived, primitive selectors: stable while playing inside one clip.
  const fps = useVideoEditStore((s) =>
    s.edit ? playheadFps(s.edit, s.playhead) : 24,
  );
  const canSplit = useVideoEditStore((s) => {
    const p = s.edit ? clipAt(s.edit, s.playhead) : null;
    return (
      !!p && p.offset > 0.05 && p.offset < clipLength(p.clip) - 0.05
    );
  });
  const speed = useVideoEditStore((s) => s.speed);
  const loop = useVideoEditStore((s) => s.loop);
  const inPoint = useVideoEditStore((s) => s.inPoint);
  const outPoint = useVideoEditStore((s) => s.outPoint);
  const selectedClipId = useVideoEditStore((s) => s.selectedClipId);
  const canUndo = useVideoEditStore((s) => s.past.length > 0);
  const canRedo = useVideoEditStore((s) => s.future.length > 0);
  const [help, setHelp] = useState(false);

  const total = timelineDuration(edit);
  const selected = edit.clips.find((c) => c.id === selectedClipId) ?? null;
  const muteTarget = selected ? [selected] : edit.clips;
  const muted = muteTarget.length > 0 && muteTarget.every((c) => c.muted);
  const playing = rate !== 0;
  const s = useVideoEditStore.getState;

  return (
    <div
      role="toolbar"
      aria-label="Playback and edit controls"
      className="relative flex shrink-0 flex-wrap items-center gap-x-1 gap-y-1 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-1.5 py-1"
    >
      <div className="flex items-center">
        {!compact && (
          <IconButton
            label="Reverse (press again to go faster)"
            shortcut="J"
            onClick={run({ kind: "shuttle", dir: -1 })}
            pressed={rate < 0}
          >
            <ChevronsLeft className="h-4 w-4" />
          </IconButton>
        )}
        <IconButton
          label="Previous frame"
          shortcut="ArrowLeft"
          onClick={run({ kind: "step", frames: -1 })}
        >
          <ChevronLeft className="h-4 w-4" />
        </IconButton>
        <IconButton
          label={playing ? "Pause" : "Play"}
          shortcut="Space"
          onClick={() => s().togglePlay()}
          className="text-[var(--text-primary)]"
        >
          {playing ? (
            <Pause className="h-4 w-4" />
          ) : (
            <Play className="h-4 w-4" />
          )}
        </IconButton>
        <IconButton
          label="Next frame"
          shortcut="ArrowRight"
          onClick={run({ kind: "step", frames: 1 })}
        >
          <ChevronRight className="h-4 w-4" />
        </IconButton>
        {!compact && (
          <IconButton
            label="Forward (press again to go faster)"
            shortcut="L"
            onClick={run({ kind: "shuttle", dir: 1 })}
            pressed={rate > 0 && rate !== speed}
          >
            <ChevronsRight className="h-4 w-4" />
          </IconButton>
        )}
      </div>

      <div
        className="px-1 font-mono text-xs tabular-nums text-[var(--text-primary)]"
        aria-live="off"
        title={
          isNtscRate(fps)
            ? "Playhead / length (hh:mm:ss:frames). Non-drop-frame: at 29.97 / 59.94 fps the count runs slightly behind the clock."
            : "Playhead / length (hh:mm:ss:frames)"
        }
      >
        <PlayheadTimecode fps={fps} />
        <span className="text-[var(--text-muted)]">
          {" "}
          / {formatTimecode(total, fps)}
        </span>
        {isNtscRate(fps) && (
          <span
            className="ml-1 rounded bg-[var(--bg-tertiary)] px-1 text-[10px] text-[var(--text-muted)]"
            aria-label="non-drop-frame timecode"
          >
            NDF
          </span>
        )}
        {Math.abs(rate) !== speed && rate !== 0 && (
          <span className="ml-1 text-[var(--accent-primary)]">
            {rate > 0 ? "" : "-"}
            {Math.abs(rate)}x
          </span>
        )}
      </div>

      <label className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
        <span className="sr-only">Playback speed</span>
        <select
          value={speed}
          onChange={(e) => s().setSpeed(Number(e.target.value))}
          className="h-8 rounded-md border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-1 text-xs text-[var(--text-primary)]"
        >
          {SPEEDS.map((v) => (
            <option key={v} value={v}>
              {v}x
            </option>
          ))}
        </select>
      </label>

      <IconButton
        label="Loop the in / out range"
        shortcut="Shift+L"
        onClick={() => s().toggleLoop()}
        pressed={loop}
      >
        <Repeat className="h-4 w-4" />
      </IconButton>

      <span
        aria-hidden
        className="mx-0.5 hidden h-5 w-px bg-[var(--border-primary)] sm:block"
      />

      <div className="flex items-center">
        <MarkButton
          label="In"
          value={inPoint}
          fps={fps}
          shortcut="I"
          onClick={run({ kind: "markIn" })}
        />
        <MarkButton
          label="Out"
          value={outPoint}
          fps={fps}
          shortcut="O"
          onClick={run({ kind: "markOut" })}
        />
        {(inPoint !== null || outPoint !== null) && (
          <button
            type="button"
            onClick={run({ kind: "clearMarks" })}
            aria-keyshortcuts="X"
            title="Clear in / out (X)"
            className="h-8 rounded-lg px-2 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
          >
            Clear
          </button>
        )}
      </div>

      <span
        aria-hidden
        className="mx-0.5 hidden h-5 w-px bg-[var(--border-primary)] sm:block"
      />

      <div className="flex items-center">
        <IconButton
          label="Split at the playhead"
          shortcut="S"
          onClick={run({ kind: "split" })}
          disabled={!canSplit}
        >
          <Scissors className="h-4 w-4" />
        </IconButton>
        <IconButton
          label={
            selected
              ? "Delete the selected clip"
              : "Delete (select a clip first)"
          }
          shortcut="Delete"
          onClick={run({ kind: "delete" })}
          disabled={!selected || edit.clips.length <= 1}
        >
          <Trash2 className="h-4 w-4" />
        </IconButton>
        <IconButton
          label={`${muted ? "Unmute" : "Mute"} ${selected ? "the selected clip" : "all clips"}`}
          shortcut="M"
          onClick={run({ kind: "mute" })}
          pressed={muted}
        >
          {muted ? (
            <VolumeX className="h-4 w-4" />
          ) : (
            <Volume2 className="h-4 w-4" />
          )}
        </IconButton>
        <IconButton
          label={
            selected
              ? "Effects (LTX) on the selected clip"
              : "Effects (LTX) (select a clip first)"
          }
          onClick={openLtxEffects}
          disabled={!selected}
        >
          <Sparkles className="h-4 w-4" />
        </IconButton>
        <IconButton
          label="Undo"
          shortcut="Meta+Z"
          onClick={() => s().undo()}
          disabled={!canUndo}
        >
          <Undo2 className="h-4 w-4" />
        </IconButton>
        <IconButton
          label="Redo"
          shortcut="Shift+Meta+Z"
          onClick={() => s().redo()}
          disabled={!canRedo}
        >
          <Redo2 className="h-4 w-4" />
        </IconButton>
      </div>

      {!compact && (
        <div className="ml-auto">
          <IconButton
            label="Keyboard shortcuts"
            onClick={() => setHelp((h) => !h)}
            pressed={help}
          >
            <Keyboard className="h-4 w-4" />
          </IconButton>
        </div>
      )}
      {help && (
        <div
          role="dialog"
          aria-label="Keyboard shortcuts"
          className="absolute bottom-full right-0 z-50 mb-2 w-80 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3 shadow-xl"
          onKeyDown={(e) => {
            if (e.key === "Escape") setHelp(false);
          }}
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {VIDEO_SHORTCUTS.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-mono text-[var(--text-primary)]">{k}</dt>
                <dd className="text-[var(--text-muted)]">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
