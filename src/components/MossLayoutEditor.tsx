"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Trash2, X } from "lucide-react";
import { useUIStore } from "@/store";
import {
  imagineWorkflowPathForPrompt,
  mergeActionAndSlotAssignments,
  resolveWorkflowForAction,
} from "@/lib/workflowAssignments";
import {
  MOSS_LAYOUT_MAX_BOXES,
  type MossLayoutBox,
  type MossLayoutKind,
} from "@/lib/oj/mossLayout";
import {
  drawRect,
  effectiveAspect,
  isMossT2iWorkflowPath,
  moveRect,
  parseAspectRatio,
  resizeRect,
  MOSS_BOX_MIN,
  type Point,
  type Rect,
  isCompleteBox,
} from "@/lib/mossLayoutUi";

const KINDS: MossLayoutKind[] = ["object", "character", "text"];
const MAX_PALETTE = 5;

type Drag =
  | { type: "draw"; start: Point; index: number }
  | { type: "move"; index: number; origin: Point; rect: Rect }
  | { type: "resize"; index: number };

/** True when the next imagine request resolves to the MOSS-Image t2i graph. */
export function useIsMossT2iActive(): boolean {
  const promptValue = useUIStore((s) => s.promptValue);
  const actionWorkflowMap = useUIStore((s) => s.actionWorkflowMap);
  const selectedWorkflowPath = useUIStore((s) => s.selectedWorkflowPath);
  const selectedWorkflowName = useUIStore((s) => s.selectedWorkflowName);
  const defaultWorkflowPath = useUIStore((s) => s.defaultWorkflowPath);
  const defaultWorkflowName = useUIStore((s) => s.defaultWorkflowName);
  return useMemo(() => {
    const assignments = mergeActionAndSlotAssignments(actionWorkflowMap);
    const resolved = resolveWorkflowForAction("promptbar.imagine", {
      assignments,
      selectedWorkflowPath,
      selectedWorkflowName,
      defaultWorkflowPath,
      defaultWorkflowName,
    });
    const path = resolved?.workflowPath ?? selectedWorkflowPath ?? undefined;
    if (path?.startsWith("__overlay__/")) return false;
    return isMossT2iWorkflowPath(imagineWorkflowPathForPrompt(path, promptValue));
  }, [
    promptValue,
    actionWorkflowMap,
    selectedWorkflowPath,
    selectedWorkflowName,
    defaultWorkflowPath,
    defaultWorkflowName,
  ]);
}

export function MossLayoutEditor() {
  const active = useIsMossT2iActive();
  if (!active) return null;
  return <MossLayoutEditorBody />;
}

function MossLayoutEditorBody() {
  const boxes = useUIStore((s) => s.mossLayoutBoxes);
  const add = useUIStore((s) => s.addMossLayoutBox);
  const update = useUIStore((s) => s.updateMossLayoutBox);
  const remove = useUIStore((s) => s.removeMossLayoutBox);
  const clear = useUIStore((s) => s.clearMossLayoutBoxes);
  const promptValue = useUIStore((s) => s.promptValue);
  const settingsAspect = useUIStore((s) => s.settings.aspect);

  const [open, setOpen] = useState(boxes.length > 0);
  const [selected, setSelected] = useState<number | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);

  const ratio =
    parseAspectRatio(effectiveAspect(promptValue, settingsAspect)) ?? 1;

  const toPoint = useCallback((e: React.PointerEvent): Point => {
    const r = canvasRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height,
    };
  }, []);

  const onCanvasDown = (e: React.PointerEvent) => {
    if (e.target !== canvasRef.current) return;
    if (boxes.length >= MOSS_LAYOUT_MAX_BOXES) return;
    const p = toPoint(e);
    const rect = drawRect(p, p);
    add({ ...rect, kind: "object", caption: "" });
    const index = boxes.length;
    dragRef.current = { type: "draw", start: p, index };
    setSelected(index);
    canvasRef.current!.setPointerCapture(e.pointerId);
  };

  const onBoxDown = (e: React.PointerEvent, i: number) => {
    e.stopPropagation();
    setSelected(i);
    const b = boxes[i];
    dragRef.current = {
      type: "move",
      index: i,
      origin: toPoint(e),
      rect: { x: b.x, y: b.y, w: b.w, h: b.h },
    };
    canvasRef.current!.setPointerCapture(e.pointerId);
  };

  const onHandleDown = (e: React.PointerEvent, i: number) => {
    e.stopPropagation();
    setSelected(i);
    dragRef.current = { type: "resize", index: i };
    canvasRef.current!.setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const p = toPoint(e);
    if (d.type === "draw") update(d.index, drawRect(d.start, p));
    else if (d.type === "move")
      update(
        d.index,
        moveRect(d.rect, p.x - d.origin.x, p.y - d.origin.y),
      );
    else {
      const b = boxes[d.index];
      if (b) update(d.index, resizeRect(b, p));
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    // A bare click (no drag) leaves a min-size box: drop it.
    if (d?.type === "draw") {
      const b = useUIStore.getState().mossLayoutBoxes[d.index];
      if (b && b.w <= MOSS_BOX_MIN * 1.5 && b.h <= MOSS_BOX_MIN * 1.5) {
        remove(d.index);
        setSelected(null);
      }
    }
  };

  const sel = selected !== null ? boxes[selected] : undefined;
  const setPalette = (palette: string[]) =>
    selected !== null &&
    update(selected, { palette: palette.length ? palette : undefined });

  return (
    <div className="border-t border-[var(--border-primary)]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full flex items-center gap-1 px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
      >
        {open ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
        <span>Layout boxes</span>
        {boxes.length > 0 && (
          <span className="text-[var(--text-muted)]">({boxes.length})</span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-3 flex flex-col sm:flex-row gap-3">
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            <div
              ref={canvasRef}
              data-testid="moss-layout-canvas"
              onPointerDown={onCanvasDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              className="relative w-full max-h-[320px] mx-auto rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] cursor-crosshair touch-none select-none"
              style={{ aspectRatio: String(ratio) }}
            >
              {boxes.map((b, i) => (
                <div
                  key={i}
                  onPointerDown={(e) => onBoxDown(e, i)}
                  className={`absolute border-2 cursor-move ${
                    i === selected
                      ? "border-[var(--accent)] bg-[var(--accent)]/20"
                      : "border-[var(--text-muted)] bg-white/5"
                  }`}
                  style={{
                    left: `${b.x * 100}%`,
                    top: `${b.y * 100}%`,
                    width: `${b.w * 100}%`,
                    height: `${b.h * 100}%`,
                  }}
                >
                  <span className="absolute left-0 top-0 px-1 text-[10px] leading-4 bg-[var(--bg-primary)] text-[var(--text-primary)] rounded-br">
                    {i + 1}
                  </span>
                  <span
                    onPointerDown={(e) => onHandleDown(e, i)}
                    className="absolute -right-1.5 -bottom-1.5 w-3 h-3 rounded-sm bg-[var(--accent)] cursor-nwse-resize"
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
              <span>Drag on the canvas to draw a box.</span>
              {boxes.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    clear();
                    setSelected(null);
                  }}
                  className="hover:text-[var(--text-primary)]"
                >
                  Clear all
                </button>
              )}
            </div>
          </div>
          {sel && selected !== null && (
            <div className="sm:w-56 flex flex-col gap-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-[var(--text-secondary)]">
                  Box {selected + 1}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    remove(selected);
                    setSelected(null);
                  }}
                  title="Delete box"
                  className="p-1 text-[var(--text-muted)] hover:text-[var(--error)]"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="flex rounded border border-[var(--border-primary)] overflow-hidden">
                {KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => update(selected, { kind: k })}
                    className={`flex-1 px-2 py-1 capitalize ${
                      sel.kind === k
                        ? "bg-[var(--accent)] text-white"
                        : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                    }`}
                  >
                    {k}
                  </button>
                ))}
              </div>
              <input
                value={sel.caption}
                maxLength={400}
                onChange={(e) => update(selected, { caption: e.target.value })}
                placeholder="Caption"
                className="px-2 py-1 rounded bg-[var(--bg-secondary)] border border-[var(--border-primary)] text-[var(--text-primary)]"
              />
              {sel.kind === "text" && (
                <input
                  value={sel.text ?? ""}
                  onChange={(e) => update(selected, { text: e.target.value })}
                  placeholder="Text to render"
                  className="px-2 py-1 rounded bg-[var(--bg-secondary)] border border-[var(--border-primary)] text-[var(--text-primary)]"
                />
              )}
              {!isCompleteBox(sel) && (
                <p className="text-[11px] text-[var(--text-tertiary)]">
                  {sel.kind === "text" ? "Add the text to render" : "Add a caption"}{" "}
                  — skipped until filled.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-1">
                {(sel.palette ?? []).map((c, ci) => (
                  <span key={ci} className="relative">
                    <input
                      type="color"
                      value={c}
                      onChange={(e) => {
                        const next = [...(sel.palette ?? [])];
                        next[ci] = e.target.value;
                        setPalette(next);
                      }}
                      className="w-6 h-6 p-0 border border-[var(--border-primary)] rounded bg-transparent"
                    />
                    <button
                      type="button"
                      title="Remove colour"
                      onClick={() =>
                        setPalette((sel.palette ?? []).filter((_, k) => k !== ci))
                      }
                      className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-[var(--bg-primary)] text-[var(--text-muted)] flex items-center justify-center"
                    >
                      <X className="w-2 h-2" />
                    </button>
                  </span>
                ))}
                {(sel.palette ?? []).length < MAX_PALETTE && (
                  <button
                    type="button"
                    onClick={() =>
                      setPalette([...(sel.palette ?? []), "#808080"])
                    }
                    className="px-1.5 h-6 rounded border border-dashed border-[var(--border-primary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  >
                    + colour
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export type { MossLayoutBox };
