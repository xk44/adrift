"use client";

/**
 * Bring results of runs started from the editor's Tools panel back:
 * image results become a new layer + canvas version (undoable), inline
 * video / 3D results open in the lightbox, failures toast. Mounted by the
 * Edit page and by a Tools page runner that was opened from the editor.
 */

import { useEffect } from "react";
import { useGenerationStore, useUIStore } from "@/store";
import { useEditorStore } from "@/store/editorStore";
import { showToast } from "@/components/Toast";
import { routeEditorToolRun } from "@/lib/editorTools";

const OUTPUT_NOUN = { video: "clip", "3d": "3D model", audio: "audio" };

export function useEditorToolReturns(enabled = true): void {
  const toolRuns = useEditorStore((s) => s.toolRuns);
  const runs = useGenerationStore((s) => s.runs);
  const gallery = useGenerationStore((s) => s.gallery);

  useEffect(() => {
    if (!enabled || toolRuns.length === 0) return;
    for (const tracked of toolRuns) {
      const route = routeEditorToolRun(
        tracked,
        runs.find((r) => r.run_id === tracked.runId),
      );
      if (route.kind === "wait") continue;
      const editor = useEditorStore.getState();
      // Another mount may have handled it already.
      if (!editor.toolRuns.some((r) => r.runId === tracked.runId)) continue;
      editor.untrackToolRun(tracked.runId);

      if (route.kind === "failed") {
        showToast(route.message, "error", 8000);
      } else if (route.kind === "apply") {
        if (!editor.sourceImage) continue; // editor was cleared meanwhile
        const item = gallery.find(
          (g) => g.runId === route.runId && g.jobIndex === route.jobIndex,
        );
        editor.applyToolResult({
          images: route.images,
          title: tracked.title,
          run: { runId: route.runId, jobIndex: route.jobIndex },
          galleryId: item?.id ?? null,
        });
        showToast(
          route.images.length > 1
            ? `${tracked.title}: ${route.images.length} layers added to the editor.`
            : `${tracked.title} added to the editor as a new layer.`,
          "success",
        );
      } else if (route.kind === "open") {
        const item = gallery.find((g) => g.runId === route.runId);
        if (item) {
          useUIStore
            .getState()
            .openLightbox({ images: [item], index: 0, origin: "edit" });
        } else {
          showToast(
            `${tracked.title}: the ${OUTPUT_NOUN[route.output]} is ready in Create.`,
            "success",
          );
        }
      } else {
        showToast(
          `${tracked.title}: the ${OUTPUT_NOUN[route.output]} is ready. It shows on the tool page and in Create.`,
          "success",
        );
      }
    }
  }, [enabled, toolRuns, runs, gallery]);
}
