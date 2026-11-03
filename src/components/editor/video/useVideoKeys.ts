"use client";

import { useEffect } from "react";
import { useUIStore } from "@/store";
import {
  clipAt,
  frameSeconds,
  removeClip,
  rippleDelete,
  setAllMuted,
  setClipMuted,
  snapToFrame,
  splitAt,
  splitAudioAt,
  removeAudioClip,
  timelineDuration,
} from "@/lib/videoEdit/editList";
import {
  isTypingTarget,
  nextEditPoint,
  trimEndAt,
  trimStartAt,
  videoKeyAction,
  type VideoKeyAction,
} from "@/lib/videoEdit/keys";
import { useVideoEditStore } from "@/store/videoEditStore";

/** Run one transport / edit action on the video editor store. */
export function runVideoAction(a: VideoKeyAction): void {
  const s = useVideoEditStore.getState();
  const edit = s.edit;
  if (!edit) return;
  const pos = clipAt(edit, s.playhead);
  const fps = pos?.clip.src.fps || 24;
  const frame = frameSeconds(fps);
  const total = timelineDuration(edit);
  switch (a.kind) {
    case "togglePlay":
      s.togglePlay();
      return;
    case "shuttle":
      s.shuttle(a.dir);
      return;
    case "step":
      s.setRate(0);
      s.seek(snapToFrame(s.playhead + a.frames * frame, fps));
      return;
    case "stepSeconds":
      s.setRate(0);
      s.seek(s.playhead + a.seconds);
      return;
    case "editPoint":
      s.setRate(0);
      s.seek(nextEditPoint(edit, s.playhead, a.dir));
      return;
    case "home":
      s.seek(0);
      return;
    case "end":
      s.setRate(0);
      s.seek(total);
      return;
    case "markIn":
      s.setIn(s.playhead);
      return;
    case "markOut":
      s.setOut(s.playhead);
      return;
    case "goIn":
      if (s.inPoint !== null) s.seek(s.inPoint);
      return;
    case "goOut":
      if (s.outPoint !== null) s.seek(s.outPoint);
      return;
    case "clearMarks":
      s.clearRange();
      return;
    case "split":
      if (s.selectedAudioId) {
        const id = s.selectedAudioId;
        s.apply((e) => splitAudioAt(e, id, s.playhead));
      } else s.apply((e) => splitAt(e, s.playhead));
      return;
    case "trimStart":
      s.apply((e) => trimStartAt(e, s.playhead));
      if (pos) s.seek(pos.start);
      return;
    case "trimEnd":
      s.apply((e) => trimEndAt(e, s.playhead));
      return;
    case "delete": {
      if (s.selectedAudioId) {
        const aid = s.selectedAudioId;
        s.apply((e) => removeAudioClip(e, aid));
        s.selectAudio(null);
        return;
      }
      const id = s.selectedClipId;
      if (!id || edit.clips.length <= 1) return;
      s.apply((e) => removeClip(e, id));
      return;
    }
    case "rippleDelete": {
      // Marks when set, else the selected clip (a plain delete).
      if (s.inPoint === null && s.outPoint === null) {
        runVideoAction({ kind: "delete" });
        return;
      }
      const start = s.inPoint ?? 0;
      const end = s.outPoint ?? total;
      s.apply((e) => rippleDelete(e, start, end));
      if (useVideoEditStore.getState().edit !== edit) {
        s.clearRange();
        s.seek(start);
      }
      return;
    }
    case "snap":
      s.toggleSnap();
      return;
    case "mute": {
      const id = s.selectedClipId;
      const clip = edit.clips.find((c) => c.id === id);
      if (clip) s.apply((e) => setClipMuted(e, clip.id, !clip.muted));
      else {
        const allMuted = edit.clips.every((c) => c.muted);
        s.apply((e) => setAllMuted(e, !allMuted));
      }
      return;
    }
    case "loop":
      s.toggleLoop();
      return;
    case "undo":
      s.undo();
      return;
    case "redo":
      s.redo();
      return;
    case "escape":
      if (s.selecting) s.setSelecting(false);
      else if (s.compareId) s.setCompare(null);
      return;
  }
}

const SLIDER_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
]);

/** Window shortcuts while the video editor is on screen. */
export function useVideoKeys(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      if (useUIStore.getState().lightbox) return;
      const el = e.target as HTMLElement | null;
      // Sliders (compare wipe, zoom) own their arrow keys.
      if (
        SLIDER_KEYS.has(e.key) &&
        el?.closest?.('[role="slider"], input[type="range"]')
      )
        return;
      // A focused dialog / menu (tools search, export sheet) owns Escape.
      if (e.key === "Escape" && el?.closest?.('[role="dialog"]')) return;
      const action = videoKeyAction(e);
      if (!action) return;
      e.preventDefault();
      runVideoAction(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
