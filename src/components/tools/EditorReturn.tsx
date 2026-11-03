"use client";

/**
 * Tools page side of the Edit page "Tools" panel: a runner opened from the
 * editor (hand-off origin "editor") gets the editor selection as its mask
 * seed, reports the runs it queues so their results return to the editor,
 * and shows a way back.
 */

import { useCallback, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { ToolHandoff } from "@/lib/tools/toolHandoff";
import { useEditorStore } from "@/store/editorStore";
import { navigateTo } from "@/hooks/useNavSync";
import { useEditorToolReturns } from "@/components/editor/useEditorToolReturns";
import { useVideoToolReturns } from "@/components/editor/video/useVideoToolReturns";
import { useVideoEditStore } from "@/store/videoEditStore";

export interface EditorOrigin {
  fromEditor: boolean;
  /** Opened from the video editor's Tools panel (a cut range as input). */
  fromVideoEditor: boolean;
  /** Editor selection (black/white PNG) for the tool's mask painter. */
  editorMask: string | null;
  /** Pass to useToolHandoff's onHandoff. */
  onHandoff: (handoff: ToolHandoff) => void;
  /** Call with each queued run id; no-op unless opened from the editor. */
  track: (runId: string) => void;
}

export function useEditorOrigin(
  title: string,
  /** Video editor subject picks, for runners with a smart selection. */
  onSmartTrack?: (picks: NonNullable<ToolHandoff["smartTrack"]>) => void,
): EditorOrigin {
  const [origin, setOrigin] = useState<{ mask: string | null } | null>(null);
  // Hand-off itemId when opened from the video editor.
  const [videoItem, setVideoItem] = useState<string | null>(null);
  const fromVideoEditor = videoItem !== null;
  const smartTrackRef = useRef(onSmartTrack);
  smartTrackRef.current = onSmartTrack;
  const onHandoff = useCallback((h: ToolHandoff) => {
    // A later hand-off from the lightbox makes this a normal card again.
    setOrigin(h.origin === "editor" ? { mask: h.mask ?? null } : null);
    setVideoItem(h.origin === "video-editor" ? h.itemId : null);
    if (h.smartTrack?.length) smartTrackRef.current?.(h.smartTrack);
  }, []);
  const fromEditor = origin !== null;
  const track = useCallback(
    (runId: string) => {
      if (fromVideoEditor) {
        const video = useVideoEditStore.getState();
        if (video.edit) video.trackToolRun(runId, title, videoItem ?? undefined);
        return;
      }
      if (!fromEditor) return;
      const editor = useEditorStore.getState();
      if (!editor.sourceImage) return; // editor closed meanwhile
      editor.trackToolRun({ runId, title, origin: "tool", at: Date.now() });
    },
    [fromEditor, fromVideoEditor, videoItem, title],
  );
  // Results that land while this page is open still go back to the editor.
  useEditorToolReturns(fromEditor);
  useVideoToolReturns(fromVideoEditor);
  return {
    fromEditor,
    fromVideoEditor,
    editorMask: origin?.mask ?? null,
    onHandoff,
    track,
  };
}

export function EditorReturnNote({ video = false }: { video?: boolean } = {}) {
  if (video)
    return (
      <p
        className="text-xs text-light-500 dark:text-dark-400"
        data-testid="editor-return-note"
      >
        Opened from the video editor with the marked range: the result comes
        back there to compare and drop into the timeline.{" "}
        <button
          type="button"
          className="inline-flex items-center gap-1 text-splash underline"
          onClick={() => navigateTo("edit")}
        >
          <ArrowLeft className="h-3 w-3" />
          Back to video editor
        </button>
      </p>
    );
  return (
    <p
      className="text-xs text-light-500 dark:text-dark-400"
      data-testid="editor-return-note"
    >
      Opened from the editor: image results come back there as a new layer.{" "}
      <button
        type="button"
        className="inline-flex items-center gap-1 text-splash underline"
        onClick={() => navigateTo("edit")}
      >
        <ArrowLeft className="h-3 w-3" />
        Back to editor
      </button>
    </p>
  );
}
