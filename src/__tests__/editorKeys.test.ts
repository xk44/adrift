import { describe, expect, it } from "vitest";
import {
  EDITOR_CANVAS_LABEL,
  EDITOR_SHORTCUTS,
  editorKeyAction,
  nextZoom,
  ZOOM_STEPS,
} from "@/components/editor/editorKeys";
import { smartSelectFailureMessage } from "@/lib/ui/editErrors";
import { shortcutSections } from "@/components/KeyboardHelp";

describe("editorKeyAction", () => {
  it("maps the documented single keys, case-insensitively", () => {
    expect(editorKeyAction({ key: "b" })).toEqual({ kind: "tool", tool: "paint" });
    expect(editorKeyAction({ key: "S" })).toEqual({ kind: "tool", tool: "smartSelect" });
    expect(editorKeyAction({ key: "x" })).toEqual({ kind: "swapPaintMode" });
    expect(editorKeyAction({ key: "[" })).toEqual({ kind: "brush", dir: -1 });
    expect(editorKeyAction({ key: "]" })).toEqual({ kind: "brush", dir: 1 });
    expect(editorKeyAction({ key: "h" })).toEqual({ kind: "toggleMask" });
    expect(editorKeyAction({ key: "i" })).toEqual({ kind: "mask", op: "invert" });
    expect(editorKeyAction({ key: "f" })).toEqual({ kind: "mask", op: "fill" });
    expect(editorKeyAction({ key: "Delete" })).toEqual({ kind: "mask", op: "clear" });
    expect(editorKeyAction({ key: "Backspace" })).toEqual({ kind: "mask", op: "clear" });
    expect(editorKeyAction({ key: "=" })).toEqual({ kind: "zoom", dir: 1 });
    expect(editorKeyAction({ key: "+" })).toEqual({ kind: "zoom", dir: 1 });
    expect(editorKeyAction({ key: "-" })).toEqual({ kind: "zoom", dir: -1 });
    expect(editorKeyAction({ key: "0" })).toEqual({ kind: "zoomFit" });
  });

  it("handles undo/redo on both Ctrl and Cmd", () => {
    expect(editorKeyAction({ key: "z", metaKey: true })).toEqual({ kind: "undo" });
    expect(editorKeyAction({ key: "z", ctrlKey: true })).toEqual({ kind: "undo" });
    expect(editorKeyAction({ key: "Z", metaKey: true, shiftKey: true })).toEqual({ kind: "redo" });
    expect(editorKeyAction({ key: "y", ctrlKey: true })).toEqual({ kind: "redo" });
  });

  it("leaves app shortcuts and modified keys alone", () => {
    expect(editorKeyAction({ key: "s", ctrlKey: true })).toBeNull(); // settings
    expect(editorKeyAction({ key: "1" })).toBeNull(); // nav
    expect(editorKeyAction({ key: "?" })).toBeNull(); // help
    expect(editorKeyAction({ key: "/" })).toBeNull(); // prompt focus
    expect(editorKeyAction({ key: "b", altKey: true })).toBeNull();
    expect(editorKeyAction({ key: "Enter" })).toBeNull();
  });
});

describe("nextZoom", () => {
  it("steps through the zoom ladder and clamps at both ends", () => {
    expect(nextZoom(1, 1)).toBe(1.5);
    expect(nextZoom(1.5, -1)).toBe(1);
    expect(nextZoom(1, -1)).toBe(1);
    expect(nextZoom(8, 1)).toBe(8);
    expect(nextZoom(2.5, 1)).toBe(3);
    expect(nextZoom(2.5, -1)).toBe(2);
    expect(ZOOM_STEPS[0]).toBe(1);
  });
});

describe("EDITOR_CANVAS_LABEL", () => {
  it("lists every shortcut from the same table as the cheat sheet", () => {
    for (const [key] of EDITOR_SHORTCUTS) expect(EDITOR_CANVAS_LABEL).toContain(key);
    expect(EDITOR_CANVAS_LABEL).toMatch(/^Image mask canvas\./);
  });
});

describe("smartSelectFailureMessage", () => {
  it("tells the user ComfyUI is down and offers the brush", () => {
    const msg = smartSelectFailureMessage(new Error("fetch failed: ECONNREFUSED 127.0.0.1:8188"));
    expect(msg).toMatch(/needs ComfyUI running/);
    expect(msg).toContain("brush (B)");
  });

  it("falls back to the raw error without doubled punctuation", () => {
    const msg = smartSelectFailureMessage(new Error("Mask came back empty."));
    expect(msg).toBe(
      "Smart Select failed: Mask came back empty. You can paint the area with the brush (B).",
    );
  });

  it("copes with non-Error values", () => {
    expect(smartSelectFailureMessage(undefined)).toBe(
      "Smart Select failed. You can paint the area with the brush (B).",
    );
  });
});

describe("KeyboardHelp", () => {
  it("documents the image and video editor keys in the ? cheat sheet", () => {
    const titles = shortcutSections().map((s) => s.title);
    expect(titles).toContain("Edit page (image)");
    expect(titles).toContain("Edit page (video)");
    const image = shortcutSections().find((s) => s.title === "Edit page (image)")!;
    expect(image.items.length).toBe(EDITOR_SHORTCUTS.length);
  });
});
