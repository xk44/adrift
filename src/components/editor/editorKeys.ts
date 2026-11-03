/**
 * Edit-tab image canvas shortcuts. One table drives the key handler, the
 * canvas's accessible label and the visible cheat sheet, so they can't drift.
 */
import type { EditorMaskOp } from "@/lib/editorMask";

export type EditorKeyAction =
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "brush"; dir: -1 | 1 }
  | { kind: "tool"; tool: "paint" | "smartSelect" | "crop" }
  | { kind: "swapPaintMode" }
  | { kind: "mask"; op: EditorMaskOp }
  | { kind: "toggleMask" }
  | { kind: "zoom"; dir: -1 | 1 }
  | { kind: "zoomFit" };

export interface EditorKeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export const EDITOR_SHORTCUTS: readonly [string, string][] = [
  ["B", "Paint brush"],
  ["S", "Smart Select (click a subject)"],
  ["C", "Crop"],
  ["Enter / Esc", "Apply / cancel the crop"],
  ["X", "Swap Erase / Restore"],
  ["[ / ]", "Smaller / bigger brush"],
  ["H", "Show / hide the mask"],
  ["I", "Invert the selection"],
  ["F", "Select the whole image"],
  ["Delete", "Clear the selection"],
  ["+ / −", "Zoom in / out (scroll to pan)"],
  ["0", "Fit the image to the screen"],
  ["⌘Z / ⇧⌘Z", "Undo / redo"],
];

export function editorKeyAction(e: EditorKeyLike): EditorKeyAction | null {
  const mod = Boolean(e.metaKey || e.ctrlKey);
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod) {
    if (k === "z") return e.shiftKey ? { kind: "redo" } : { kind: "undo" };
    if (k === "y") return { kind: "redo" };
    return null;
  }
  if (e.altKey) return null;
  switch (k) {
    case "[":
      return { kind: "brush", dir: -1 };
    case "]":
      return { kind: "brush", dir: 1 };
    case "b":
      return { kind: "tool", tool: "paint" };
    case "s":
      return { kind: "tool", tool: "smartSelect" };
    case "c":
      return { kind: "tool", tool: "crop" };
    case "x":
      return { kind: "swapPaintMode" };
    case "h":
      return { kind: "toggleMask" };
    case "i":
      return { kind: "mask", op: "invert" };
    case "f":
      return { kind: "mask", op: "fill" };
    case "Delete":
    case "Backspace":
      return { kind: "mask", op: "clear" };
    case "+":
    case "=":
      return { kind: "zoom", dir: 1 };
    case "-":
    case "_":
      return { kind: "zoom", dir: -1 };
    case "0":
      return { kind: "zoomFit" };
  }
  return null;
}

/** Enter / Escape while cropping; other keys go through editorKeyAction. */
export function editorCropKey(e: EditorKeyLike): "apply" | "cancel" | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === "Enter") return "apply";
  if (e.key === "Escape") return "cancel";
  return null;
}

/** Zoom levels relative to "fit": 1 = the whole image on screen. */
export const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6, 8] as const;

export function nextZoom(zoom: number, dir: -1 | 1): number {
  if (dir > 0) {
    return (
      ZOOM_STEPS.find((z) => z > zoom + 1e-6) ??
      ZOOM_STEPS[ZOOM_STEPS.length - 1]
    );
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    if (ZOOM_STEPS[i] < zoom - 1e-6) return ZOOM_STEPS[i];
  }
  return ZOOM_STEPS[0];
}

export const EDITOR_CANVAS_LABEL =
  "Image mask canvas. Paint over the area to change. Keys: " +
  EDITOR_SHORTCUTS.map(([k, v]) => `${k} ${v.toLowerCase()}`).join(", ") +
  ".";
