"use client";

/**
 * Clip menu (right-click a clip, its "..." button, or Shift+F10 / the menu
 * key on a focused clip): AI verbs that send the clip, or the marked moment
 * inside it, to a video tool. The result comes back to Results as a take
 * for the same place.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Link2,
  Loader2,
  Pause,
  Repeat,
  Scissors,
  SlidersHorizontal,
  Wand2,
} from "lucide-react";
import { loadToolCatalog } from "@/components/LightboxToolsPanel";
import type { CatalogTool } from "@/lib/tools/toolsPage";
import {
  clipStarts,
  clipLength,
  splitAt,
  type EditList,
} from "@/lib/videoEdit/editList";
import { buildVideoEditorTools } from "@/lib/videoEdit/videoTools";
import {
  clipMenuRange,
  clipVerbs,
  type ClipVerb,
} from "@/lib/videoEdit/clipVerbs";
import { bridgeTools } from "@/lib/videoEdit/bridge";
import { useVideoEditStore } from "@/store/videoEditStore";
import { rangeLabel } from "./VideoPanels";
import { sendBridge, sendRangeToTool } from "./sendToTool";
import { freezeAt, reverseClip } from "./clipOps";
import { MAX_REVERSE_SECONDS } from "@/lib/videoEdit/ffmpegArgs";

export interface ClipMenuAt {
  clipId: string;
  x: number;
  y: number;
}

const MENU_W = 240;

export function VideoClipMenu({
  at,
  onClose,
}: {
  at: ClipMenuAt;
  onClose: (refocus: boolean) => void;
}) {
  const edit = useVideoEditStore((s) => s.edit) as EditList | null;
  const inPoint = useVideoEditStore((s) => s.inPoint);
  const outPoint = useVideoEditStore((s) => s.outPoint);
  const playhead = useVideoEditStore((s) => s.playhead);
  const [catalog, setCatalog] = useState<CatalogTool[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void loadToolCatalog().then((c) => {
      if (live) setCatalog(c);
    });
    return () => {
      live = false;
    };
  }, []);

  const verbs = useMemo(
    () => clipVerbs(buildVideoEditorTools(catalog)),
    [catalog],
  );
  const bridge = useMemo(() => bridgeTools(catalog)[0] ?? null, [catalog]);
  const range = edit ? clipMenuRange(edit, at.clipId, inPoint, outPoint) : null;
  const index = edit ? edit.clips.findIndex((c) => c.id === at.clipId) : -1;
  const hasNext = !!edit && index >= 0 && index < edit.clips.length - 1;
  const clipStart = index >= 0 && edit ? clipStarts(edit)[index] : 0;
  const clipEnd =
    index >= 0 && edit ? clipStart + clipLength(edit.clips[index]) : 0;
  const canSplit = playhead > clipStart + 0.05 && playhead < clipEnd - 0.05;
  const thisClip = index >= 0 && edit ? edit.clips[index] : null;
  const canReverse =
    !!thisClip && thisClip.out - thisClip.in <= MAX_REVERSE_SECONDS + 1e-6;
  const canFreeze = playhead >= clipStart && playhead < clipEnd;

  // Keep it on screen (phones included).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof window === "undefined") return;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({
      left: Math.max(8, Math.min(at.x, vw - MENU_W - 8)),
      top: at.y + h > vh - 8 ? Math.max(8, at.y - h) : at.y,
    });
  }, [at.x, at.y, verbs.length]);

  useEffect(() => {
    ref.current
      ?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
      ?.focus();
  }, [verbs.length]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        onClose(false);
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [onClose]);

  useEffect(() => {
    if (index === -1) onClose(false);
  }, [index, onClose]);

  const keys = (e: React.KeyboardEvent) => {
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([disabled])',
      ) ?? [],
    );
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (i + 1) % items.length;
    else if (e.key === "ArrowUp") next = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
      return;
    } else if (e.key === "Tab") {
      onClose(false);
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    items[next]?.focus();
  };

  const run = async (v: ClipVerb) => {
    if (busy || !range) return;
    setBusy(v.id);
    const ok = await sendRangeToTool(v.tool, range);
    setBusy(null);
    if (ok) onClose(false);
  };

  const runBridge = async () => {
    if (busy || !bridge) return;
    setBusy("bridge");
    const ok = await sendBridge(bridge, at.clipId);
    setBusy(null);
    if (ok) onClose(false);
  };

  const runOp = async (id: string, op: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(id);
    const ok = await op();
    setBusy(null);
    if (ok) onClose(true);
  };

  const item =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[var(--text-primary)] outline-none hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] disabled:opacity-50";

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Clip actions"
      data-testid="video-clip-menu"
      onKeyDown={keys}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 max-h-[70vh] overflow-y-auto rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] p-1 shadow-lg"
      style={{ left: pos.left, top: pos.top, width: MENU_W }}
    >
      {range && (
        <p className="px-2 pb-1 pt-0.5 text-[10px] text-[var(--text-muted)]">
          {rangeLabel(range)}
        </p>
      )}
      {verbs.map((v) => (
        <button
          key={v.id}
          type="button"
          role="menuitem"
          disabled={!!busy}
          title={v.hint}
          onClick={() => void run(v)}
          className={item}
          data-testid={`clip-verb-${v.id}`}
        >
          {busy === v.id ? (
            <Loader2
              className="h-3.5 w-3.5 shrink-0 animate-spin"
              aria-hidden
            />
          ) : (
            <Wand2
              className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
              aria-hidden
            />
          )}
          <span className="flex-1 truncate">{v.label}</span>
          <span className="truncate text-[10px] text-[var(--text-muted)]">
            {v.tool.title}
          </span>
        </button>
      ))}
      {verbs.length === 0 && (
        <p className="px-2 py-1.5 text-xs text-[var(--text-muted)]">
          {catalog === null ? "Loading tools..." : "No video tools installed."}
        </p>
      )}
      {bridge && hasNext && (
        <button
          type="button"
          role="menuitem"
          disabled={!!busy}
          title="Generate a shot that moves from this clip's last frame to the next clip's first, inserted at the cut"
          onClick={() => void runBridge()}
          className={item}
          data-testid="clip-verb-bridge"
        >
          {busy === "bridge" ? (
            <Loader2
              className="h-3.5 w-3.5 shrink-0 animate-spin"
              aria-hidden
            />
          ) : (
            <Link2
              className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
              aria-hidden
            />
          )}
          <span className="flex-1 truncate">Bridge to next clip</span>
          <span className="truncate text-[10px] text-[var(--text-muted)]">
            {bridge.title}
          </span>
        </button>
      )}
      <div
        role="separator"
        className="my-1 h-px bg-[var(--border-secondary)]"
      />
      <button
        type="button"
        role="menuitem"
        disabled={!!busy || !canSplit}
        onClick={() => {
          useVideoEditStore.getState().apply((e) => splitAt(e, playhead));
          onClose(true);
        }}
        className={item}
      >
        <Scissors
          className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
          aria-hidden
        />
        <span className="flex-1">Split at playhead</span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!!busy || !canReverse}
        title={
          canReverse
            ? "Play this clip backwards"
            : `Reverse works on up to ${MAX_REVERSE_SECONDS} s. Split the clip first.`
        }
        onClick={() => void runOp("reverse", () => reverseClip(at.clipId))}
        className={item}
        data-testid="clip-op-reverse"
      >
        {busy === "reverse" ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
        ) : (
          <Repeat
            className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
            aria-hidden
          />
        )}
        <span className="flex-1">Reverse clip</span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!!busy || !canFreeze}
        title="Hold the frame under the playhead for 2 seconds"
        onClick={() => void runOp("freeze", () => freezeAt(playhead, 2))}
        className={item}
        data-testid="clip-op-freeze"
      >
        {busy === "freeze" ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
        ) : (
          <Pause
            className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
            aria-hidden
          />
        )}
        <span className="flex-1">Freeze frame at playhead (2 s)</span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!!busy}
        onClick={() => {
          const s = useVideoEditStore.getState();
          s.selectClip(at.clipId);
          s.setPanel("clip");
          onClose(false);
        }}
        className={item}
      >
        <SlidersHorizontal
          className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
          aria-hidden
        />
        <span className="flex-1">Speed, volume, fades...</span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!!busy}
        onClick={() => {
          const s = useVideoEditStore.getState();
          s.selectClip(at.clipId);
          s.setPanel("tools");
          onClose(false);
        }}
        className={item}
      >
        <Wand2
          className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
          aria-hidden
        />
        <span className="flex-1">All video tools...</span>
      </button>
    </div>
  );
}
