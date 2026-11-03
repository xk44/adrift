"use client";

/**
 * Bring results of runs started from the video editor's Tools panel back:
 * a clip becomes a result to compare against the range it was made from
 * (then replace the range or add to the end); a still shows in the results
 * list; failures toast. Mounted by the video editor and by a Tools page
 * runner that was opened from it.
 */

import { useEffect } from "react";
import { useGenerationStore } from "@/store";
import { useVideoEditStore } from "@/store/videoEditStore";
import { showToast } from "@/components/Toast";
import { routeVideoToolRun } from "@/lib/videoEdit/videoTools";
import { probeVideo } from "@/lib/videoEdit/client";

const OUTPUT_NOUN = { "3d": "3D model", audio: "audio" } as const;

export function useVideoToolReturns(enabled = true): void {
  const toolRuns = useVideoEditStore((s) => s.toolRuns);
  const runs = useGenerationStore((s) => s.runs);

  useEffect(() => {
    if (!enabled || toolRuns.length === 0) return;
    for (const tracked of toolRuns) {
      const route = routeVideoToolRun(
        tracked,
        runs.find((r) => r.run_id === tracked.runId),
      );
      if (route.kind === "wait") continue;
      const store = useVideoEditStore.getState();
      // Another mount may have handled it already.
      if (!store.toolRuns.some((r) => r.runId === tracked.runId)) continue;
      store.untrackToolRun(tracked.runId);
      if (!store.edit) continue; // project closed meanwhile

      if (route.kind === "failed") {
        showToast(route.message, "error", 8000);
      } else if (route.kind === "other") {
        showToast(
          `${tracked.title}: the ${OUTPUT_NOUN[route.output]} is ready in Create.`,
          "success",
        );
      } else {
        const many = route.outputs.length > 1;
        for (const out of route.outputs) {
          const base = {
            id: `${out.runId}:${out.jobIndex}`,
            title: many ? `${tracked.title} #${out.jobIndex + 1}` : tracked.title,
            runId: out.runId,
            jobIndex: out.jobIndex,
            start: tracked.start,
            end: tracked.end,
            cutUrl: tracked.cutUrl,
            url: out.url,
          };
          if (out.kind === "image") {
            store.addResult({ ...base, kind: "image", source: null, at: Date.now() });
            continue;
          }
          void probeVideo(out.url)
            .then((source) =>
              useVideoEditStore
                .getState()
                .addResult({ ...base, kind: "video", source, at: Date.now() }),
            )
            .catch((e: unknown) =>
              showToast(
                `${base.title} finished but the clip could not be read: ${e instanceof Error ? e.message : String(e)}`,
                "error",
                8000,
              ),
            );
        }
        const what = route.outputs[0].kind === "video" ? "clip" : "still";
        showToast(
          many
            ? `${tracked.title} is back with ${route.outputs.length} versions: compare them in Results.`
            : what === "clip"
              ? `${tracked.title} is back: compare it, then replace the range.`
              : `${tracked.title} made a still; it is in Results.`,
          "success",
        );
      }
    }
  }, [enabled, toolRuns, runs]);
}
