/**
 * Video editor keyboard map (NLE conventions) and the timeline-level edits
 * the keys trigger. Pure so the bindings are unit-tested.
 */

import { clipAt, editPoints, trimClip, type EditList } from "./editList";

export type VideoKeyAction =
  | { kind: "togglePlay" }
  | { kind: "shuttle"; dir: -1 | 0 | 1 }
  | { kind: "step"; frames: number }
  | { kind: "stepSeconds"; seconds: number }
  | { kind: "editPoint"; dir: -1 | 1 }
  | { kind: "home" }
  | { kind: "end" }
  | { kind: "markIn" }
  | { kind: "markOut" }
  | { kind: "clearMarks" }
  | { kind: "goIn" }
  | { kind: "goOut" }
  | { kind: "split" }
  | { kind: "trimStart" }
  | { kind: "trimEnd" }
  | { kind: "delete" }
  | { kind: "rippleDelete" }
  | { kind: "snap" }
  | { kind: "mute" }
  | { kind: "loop" }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "escape" };

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

/** Shortcut list for the help popover (same order as the docs). */
export const VIDEO_SHORTCUTS: readonly [string, string][] = [
  ["Space", "Play / pause"],
  ["J / K / L", "Reverse / stop / forward (press again to go faster)"],
  ["← / →", "One frame back / forward (Shift: 1 second)"],
  ["↑ / ↓", "Previous / next cut"],
  ["I / O", "Mark in / out (Shift: go to it)"],
  ["X", "Clear in / out"],
  ["S", "Split at the playhead"],
  ["[ / ]", "Trim clip start / end to the playhead"],
  ["Delete", "Delete the selected clip"],
  ["Shift+Delete", "Ripple delete in → out (closes the gap)"],
  ["N", "Snapping on / off"],
  ["M", "Mute / unmute the selected clip"],
  ["Shift+L", "Loop the in / out range"],
  ["⌘Z / ⇧⌘Z", "Undo / redo"],
];

export function videoKeyAction(e: KeyLike): VideoKeyAction | null {
  const mod = Boolean(e.metaKey || e.ctrlKey);
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod) {
    if (k === "z") return e.shiftKey ? { kind: "redo" } : { kind: "undo" };
    if (k === "y") return { kind: "redo" };
    return null;
  }
  if (e.altKey) return null;
  switch (k) {
    case " ":
      return { kind: "togglePlay" };
    case "j":
      return { kind: "shuttle", dir: -1 };
    case "k":
      return { kind: "shuttle", dir: 0 };
    case "l":
      return e.shiftKey ? { kind: "loop" } : { kind: "shuttle", dir: 1 };
    case "ArrowLeft":
      return e.shiftKey
        ? { kind: "stepSeconds", seconds: -1 }
        : { kind: "step", frames: -1 };
    case "ArrowRight":
      return e.shiftKey
        ? { kind: "stepSeconds", seconds: 1 }
        : { kind: "step", frames: 1 };
    case "ArrowUp":
      return { kind: "editPoint", dir: -1 };
    case "ArrowDown":
      return { kind: "editPoint", dir: 1 };
    case "Home":
      return { kind: "home" };
    case "End":
      return { kind: "end" };
    case "i":
      return e.shiftKey ? { kind: "goIn" } : { kind: "markIn" };
    case "o":
      return e.shiftKey ? { kind: "goOut" } : { kind: "markOut" };
    case "x":
      return { kind: "clearMarks" };
    case "s":
      return { kind: "split" };
    case "[":
      return { kind: "trimStart" };
    case "]":
      return { kind: "trimEnd" };
    case "Delete":
    case "Backspace":
      return e.shiftKey ? { kind: "rippleDelete" } : { kind: "delete" };
    case "n":
      return { kind: "snap" };
    case "m":
      return { kind: "mute" };
    case "Escape":
      return { kind: "escape" };
    default:
      return null;
  }
}

/** Next / previous cut from `t` (strictly after / before, with a tolerance). */
export function nextEditPoint(list: EditList, t: number, dir: -1 | 1): number {
  const pts = editPoints(list);
  const eps = 1e-3;
  if (dir > 0) return pts.find((p) => p > t + eps) ?? pts[pts.length - 1] ?? 0;
  for (let i = pts.length - 1; i >= 0; i -= 1)
    if (pts[i] < t - eps) return pts[i];
  return 0;
}

/** Trim the clip under `t` so it starts at `t` (ripple: later clips move up). */
export function trimStartAt(list: EditList, t: number): EditList {
  const pos = clipAt(list, t);
  if (!pos || pos.offset <= 0) return list;
  return trimClip(list, pos.clip.id, pos.sourceTime, pos.clip.out);
}

/** Trim the clip under `t` so it ends at `t`. */
export function trimEndAt(list: EditList, t: number): EditList {
  const pos = clipAt(list, t);
  if (!pos || pos.offset <= 0) return list;
  return trimClip(list, pos.clip.id, pos.clip.in, pos.sourceTime);
}

/** Keyboard events from text fields / menus are not shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") {
    const type = (el as HTMLInputElement).type;
    return !["range", "checkbox", "radio", "button"].includes(type);
  }
  return Boolean(el.isContentEditable);
}
