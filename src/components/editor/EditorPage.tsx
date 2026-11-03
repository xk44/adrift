"use client";

import { useCallback, useState } from "react";
import { useEditorStore } from "@/store/editorStore";
import { useInpaint } from "@/hooks";
import { EditorToolbar } from "./EditorToolbar";
import { EditorCanvas } from "./EditorCanvas";
import { EditorExport } from "./EditorExport";
import { EditorEmptyState } from "./EditorEmptyState";
import { EditorPromptBar } from "./EditorPromptBar";
import { useEditorToolReturns } from "./useEditorToolReturns";
import { useVideoEditStore } from "@/store/videoEditStore";
import { VideoEditor } from "./video/VideoEditor";
import { showToast } from "@/components/Toast";
import { editFailureMessage } from "@/lib/ui/editErrors";
import { editorPanelClass, type EditorMobilePanel } from "./editorLayout";

interface EditorPageProps {
  /** Resolves false when the edit didn't start (it shows its own error). */
  onSubmitEdit?: (
    prompt: string,
    maskDataUrl: string | null,
  ) => Promise<boolean | void>;
}

export function EditorPage({ onSubmitEdit }: EditorPageProps) {
  const sourceImage = useEditorStore((s) => s.sourceImage);
  const maskCanvas = useEditorStore((s) => s.maskCanvas);
  const setProcessing = useEditorStore((s) => s.setProcessing);
  const isProcessing = useEditorStore((s) => s.isProcessing);
  // Phones: the side panels become one switchable sheet under the canvas.
  const [mobilePanel, setMobilePanel] = useState<EditorMobilePanel>("tools");
  // Results of tools run from the Tools panel come back as layers.
  useEditorToolReturns();
  // Video mode: a video project is open and no image was opened since.
  const videoMode = useVideoEditStore((s) => s.edit !== null && s.active);

  // Fallback inpaint hook — used when no onSubmitEdit prop is provided,
  // which is the case when EditorPage is rendered outside of the main
  // HomePage shell (e.g. unit tests or embed scenarios).
  const { inpaint: submitInpaint } = useInpaint({
    onSuccess: (promptId: string) => {
      // Navigation to results handled by the global WebSocket watcher
    },
    onError: (error: string) => {
      console.error("[Editor] Inpaint failed:", error);
      showToast(editFailureMessage(error), "error");
    },
  });

  const handleSubmit = useCallback(
    async (prompt: string) => {
      // One edit at a time: Enter / double clicks while sending are ignored.
      if (!sourceImage || useEditorStore.getState().isProcessing) return;

      setProcessing(true, "Sending edit…");

      try {
        let maskDataUrl: string | null = null;
        if (maskCanvas) {
          const ctx = maskCanvas.getContext("2d");
          if (ctx) {
            const imageData = ctx.getImageData(
              0,
              0,
              maskCanvas.width,
              maskCanvas.height
            );
            const hasContent = imageData.data.some((v, i) => i % 4 === 3 && v > 0);
            if (hasContent) {
              maskDataUrl = maskCanvas.toDataURL("image/png");
            }
          }
        }

        let started: boolean;
        if (onSubmitEdit) {
          started = (await onSubmitEdit(prompt, maskDataUrl)) !== false;
        } else {
          // Default implementation: call inpaint API directly
          const result = await submitInpaint(prompt, sourceImage, maskDataUrl);
          if (!result.ok) {
            console.error("[Editor] Inpaint failed:", result.error);
          }
          started = result.ok;
        }
        if (started) {
          showToast("Edit queued. The result shows up in Create.", "success");
        }
      } catch (error) {
        console.error("Edit submission failed:", error);
        showToast(editFailureMessage(error), "error");
      } finally {
        setProcessing(false);
      }
    },
    [sourceImage, maskCanvas, setProcessing, onSubmitEdit, submitInpaint]
  );

  if (videoMode) return <VideoEditor />;

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)]">
      {/* Top prompt bar */}
      <EditorPromptBar onSubmit={handleSubmit} isLoading={isProcessing} />

      {/* Main content area: row on desktop, canvas + one panel on phones */}
      <div
        className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden"
        data-testid="editor-layout"
        data-tour="editor"
      >
        {/* Left toolbar — the start screen needs the full width on phones */}
        <div
          id="editor-panel-tools"
          role={sourceImage ? "tabpanel" : undefined}
          aria-labelledby={sourceImage ? "editor-tab-tools" : undefined}
          className={editorPanelClass("tools", !!sourceImage, mobilePanel)}
        >
          <EditorToolbar />
        </div>

        {/* Center canvas area. The layers panel is hidden: the canvas does
            not composite layers yet. */}
        <div className="order-1 md:order-none flex-1 min-h-0 min-w-0 flex flex-col">
          {sourceImage ? <EditorCanvas /> : <EditorEmptyState />}
        </div>

        {sourceImage && (
          <div
            role="tablist"
            aria-label="Editor panels"
            className="order-2 flex md:hidden border-t border-[var(--border-primary)]"
          >
            {(
              [
                ["tools", "Tools"],
                ["export", "Export"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                id={`editor-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={mobilePanel === id}
                aria-controls={`editor-panel-${id}`}
                onClick={() => setMobilePanel(id)}
                className={`flex-1 py-2.5 text-sm font-medium ${
                  mobilePanel === id
                    ? "text-[var(--text-primary)] border-b-2 border-[var(--accent-primary)]"
                    : "text-[var(--text-secondary)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Right export panel — every action needs an image, so it stays
            out of the way until one is loaded */}
        {sourceImage && (
          <div
            id="editor-panel-export"
            role="tabpanel"
            aria-labelledby="editor-tab-export"
            className={editorPanelClass("export", true, mobilePanel)}
          >
            <EditorExport />
          </div>
        )}
      </div>
    </div>
  );
}

export default EditorPage;
