"use client";

import { useCallback, useState } from "react";
import { useEditorStore } from "@/store/editorStore";
import { EnhanceOptions } from "./EnhanceOptions";
import { EditorToolsPanel } from "./EditorToolsPanel";
import { applyEditorMaskOp } from "@/lib/editorMask";
import { EDITOR_SHORTCUTS } from "./editorKeys";
import {
  Crop,
  Eye,
  EyeOff,
  Keyboard,
  Paintbrush,
  Eraser,
  RotateCcw,
  MousePointer2,
  Undo2,
  Redo2,
  Sparkles,
  Wrench,
} from "lucide-react";

export function EditorToolbar() {
  const activeTab = useEditorStore((s) => s.activeTab);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const activeTool = useEditorStore((s) => s.activeTool);
  const setActiveTool = useEditorStore((s) => s.setActiveTool);
  const paintMode = useEditorStore((s) => s.paintMode);
  const setPaintMode = useEditorStore((s) => s.setPaintMode);
  const brushSize = useEditorStore((s) => s.brushSize);
  const setBrushSize = useEditorStore((s) => s.setBrushSize);
  const historyIndex = useEditorStore((s) => s.historyIndex);
  const history = useEditorStore((s) => s.history);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const clearHistory = useEditorStore((s) => s.clearHistory);
  const saveToHistory = useEditorStore((s) => s.saveToHistory);
  const maskCanvas = useEditorStore((s) => s.maskCanvas);
  const showMask = useEditorStore((s) => s.showMask);
  const setShowMask = useEditorStore((s) => s.setShowMask);
  const maskOpacity = useEditorStore((s) => s.maskOpacity);
  const setMaskOpacity = useEditorStore((s) => s.setMaskOpacity);
  const [keysOpen, setKeysOpen] = useState(false);

  const sourceImage = useEditorStore((s) => s.sourceImage);
  const pendingTools = useEditorStore((s) => s.toolRuns.length);
  const [toolsOpen, setToolsOpen] = useState(false);
  const closeTools = useCallback(() => setToolsOpen(false), []);

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  // Reset = empty selection and a fresh undo history starting from it.
  const resetMask = useCallback(() => {
    applyEditorMaskOp(maskCanvas, "clear");
    clearHistory();
    if (maskCanvas) saveToHistory();
  }, [maskCanvas, clearHistory, saveToHistory]);

  return (
    <div className="relative w-full md:w-52 min-h-0 flex-shrink-0 bg-[var(--bg-primary)] border-t md:border-t-0 md:border-r border-[var(--border-primary)] flex flex-col">
      {/* Tab switcher */}
      <div className="flex border-b border-[var(--border-primary)]">
        <button
          onClick={() => setActiveTab("edit")}
          className={`flex-auto whitespace-nowrap px-1 py-3 text-[13px] font-medium transition-colors ${
            activeTab === "edit"
              ? "text-[var(--text-primary)] border-b-2 border-[var(--accent-primary)]"
              : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          }`}
        >
          Edit
        </button>
        <button
          onClick={() => setActiveTab("enhance")}
          className={`flex-auto whitespace-nowrap px-1 py-3 text-[13px] font-medium transition-colors flex items-center justify-center gap-0.5 ${
            activeTab === "enhance"
              ? "text-[var(--text-primary)] border-b-2 border-[var(--accent-primary)]"
              : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          }`}
        >
          Enhance
          <Sparkles className="w-3 h-3 shrink-0" />
        </button>
      </div>

      {/* Undo/Redo */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-[var(--border-primary)]">
        <button
          onClick={undo}
          disabled={!canUndo}
          className="btn-ghost btn-icon disabled:opacity-30"
          title="Undo (Ctrl/Cmd+Z)"
          aria-label="Undo"
        >
          <Undo2 className="w-4 h-4" />
        </button>
        <button
          onClick={redo}
          disabled={!canRedo}
          className="btn-ghost btn-icon disabled:opacity-30"
          title="Redo (Ctrl/Cmd+Shift+Z)"
          aria-label="Redo"
        >
          <Redo2 className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={resetMask}
          disabled={!sourceImage}
          className="btn-ghost btn-icon ml-auto disabled:opacity-30"
          title="Clear the selection and undo history"
          aria-label="Reset selection"
          data-testid="editor-reset"
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      </div>

      {/* Tools */}
      <div className="flex-1 p-3 space-y-3 overflow-y-auto">
        {/* Paint tool */}
        <div className="space-y-2">
          <ToolSection
            icon={Paintbrush}
            label="Paint"
            isActive={activeTool === "paint"}
            onClick={() => setActiveTool("paint")}
          />

          {activeTool === "paint" && (
            <div className="pl-2 space-y-3">
              {/* Erase/Restore toggle */}
              <div className="flex gap-1 p-1 bg-[var(--bg-tertiary)] rounded-lg">
                <button
                  type="button"
                  aria-pressed={paintMode === "erase"}
                  title="Paint the area to change (X swaps)"
                  onClick={() => setPaintMode("erase")}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    paintMode === "erase"
                      ? "bg-[var(--bg-primary)] text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <Eraser className="w-3.5 h-3.5" />
                  Erase
                </button>
                <button
                  type="button"
                  aria-pressed={paintMode === "restore"}
                  title="Unpaint: keep this area as it is (X swaps)"
                  onClick={() => setPaintMode("restore")}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    paintMode === "restore"
                      ? "bg-[var(--bg-primary)] text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Restore
                </button>
              </div>

              {/* Brush size */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-[var(--text-secondary)]">
                    Brush Size{" "}
                    <kbd className="font-mono text-[10px] text-[var(--text-tertiary)]">
                      [ ]
                    </kbd>
                  </span>
                  <span className="text-xs text-[var(--text-tertiary)]">
                    {brushSize}px
                  </span>
                </div>
                <input
                  aria-label="Brush size"
                  type="range"
                  min="1"
                  max="500"
                  value={brushSize}
                  onChange={(e) => setBrushSize(parseInt(e.target.value))}
                  className="slider w-full"
                />
              </div>
            </div>
          )}
        </div>

        {/* Smart Select tool: SAM3 click-to-select via /api/tools/smart-mask */}
        <div className="space-y-2">
          <ToolSection
            icon={MousePointer2}
            label="Smart Select"
            isActive={activeTool === "smartSelect"}
            onClick={() => setActiveTool("smartSelect")}
          />
          {activeTool === "smartSelect" && (
            <p
              className="pl-2 text-xs text-[var(--text-secondary)]"
              data-testid="smart-select-hint"
            >
              Click the subject to select it. Shift-click to exclude a part.
            </p>
          )}
        </div>

        {/* Crop: frame + presets live on the canvas so phones see them too */}
        <div className="space-y-2">
          <ToolSection
            icon={Crop}
            label="Crop"
            isActive={activeTool === "crop"}
            onClick={() => setActiveTool("crop")}
          />
          {activeTool === "crop" && (
            <p
              className="pl-2 text-xs text-[var(--text-secondary)]"
              data-testid="crop-hint"
            >
              Drag the frame or its handles. Enter applies, Esc cancels.
            </p>
          )}
        </div>

        {/* Mask visibility: the selection overlay on the canvas */}
        <div className="space-y-1.5 pt-1" data-testid="editor-mask-visibility">
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--text-secondary)]">
              Mask overlay
            </span>
            <button
              type="button"
              onClick={() => setShowMask(!showMask)}
              aria-pressed={showMask}
              aria-label={showMask ? "Hide mask (H)" : "Show mask (H)"}
              title={showMask ? "Hide mask (H)" : "Show mask (H)"}
              className="btn-ghost btn-icon"
            >
              {showMask ? (
                <Eye className="w-4 h-4" />
              ) : (
                <EyeOff className="w-4 h-4" />
              )}
            </button>
          </div>
          <input
            aria-label="Mask opacity"
            type="range"
            min="0.1"
            max="1"
            step="0.05"
            value={maskOpacity}
            disabled={!showMask}
            onChange={(e) => setMaskOpacity(parseFloat(e.target.value))}
            className="slider w-full disabled:opacity-40"
          />
        </div>

        {/* Tools panel: lightbox tools run on the canvas */}
        <button
          type="button"
          onClick={() => setToolsOpen((o) => !o)}
          disabled={!sourceImage}
          aria-expanded={toolsOpen}
          aria-controls="editor-tools-panel"
          title={sourceImage ? "Run a tool on the canvas" : "Load an image first"}
          data-testid="editor-tools-button"
          className={`flex w-full items-center gap-2 px-3 py-2 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            toolsOpen
              ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
              : "text-[var(--text-secondary)] enabled:hover:bg-[var(--bg-hover)] enabled:hover:text-[var(--text-primary)]"
          }`}
        >
          <Wrench className="w-4 h-4 flex-shrink-0" />
          <span className="text-sm">Tools</span>
          {pendingTools > 0 && (
            <span
              className="ml-auto rounded-full bg-[var(--bg-tertiary)] px-1.5 text-[10px] text-[var(--text-secondary)]"
              title={`${pendingTools} running`}
            >
              {pendingTools}
            </span>
          )}
        </button>

        {activeTab === "enhance" && <EnhanceOptions />}
      </div>

      {/* Visible cheat sheet for the canvas keys (also in the ? dialog) */}
      <div className="hidden md:block border-t border-[var(--border-primary)] px-3 py-2">
        <button
          type="button"
          onClick={() => setKeysOpen((o) => !o)}
          aria-expanded={keysOpen}
          aria-controls="editor-shortcuts"
          data-testid="editor-shortcuts-button"
          className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          <Keyboard className="w-3.5 h-3.5" />
          Keyboard shortcuts
        </button>
        {keysOpen && (
          <dl
            id="editor-shortcuts"
            className="mt-1 grid max-h-[40vh] grid-cols-[auto_1fr] gap-x-2 gap-y-1 overflow-y-auto text-[11px]"
          >
            {EDITOR_SHORTCUTS.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-mono text-[var(--text-primary)]">{k}</dt>
                <dd className="text-[var(--text-muted)]">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {toolsOpen && sourceImage && <EditorToolsPanel onClose={closeTools} />}
    </div>
  );
}

interface ToolSectionProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  isActive?: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
}

function ToolSection({
  icon: Icon,
  label,
  isActive,
  onClick,
  children,
}: ToolSectionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isActive}
      className={`flex w-full items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
        isActive
          ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      }`}
    >
      <Icon className="w-4 h-4 flex-shrink-0" />
      <span className="text-sm">{label}</span>
      {children}
    </button>
  );
}

export default EditorToolbar;
