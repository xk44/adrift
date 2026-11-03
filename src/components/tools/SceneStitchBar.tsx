"use client";

import { useMemo, useRef, useState } from "react";
import { Clapperboard, Loader2 } from "lucide-react";
import { useGenerationStore } from "@/store";
import { showToast } from "@/components/Toast";
import {
  STITCH_DEFAULT_FADE_SECONDS,
  STITCH_TRANSITIONS,
  type StitchTransition,
} from "@/lib/tools/stitchClips";
import { runStitch, type StitchResult } from "@/lib/tools/stitchRunner";
import { SCENE_STITCH_PREFIX, sceneStitchState } from "@/lib/tools/sceneStitch";
import { measureMedia } from "./DubRunner";
import { Segmented } from "./ToolRunner";

/**
 * After a multi-shot scene is queued: shows shot progress and, once every
 * shot has a clip, a one-click "Stitch scene" (user-initiated; queues one
 * stitch_clips run with the shot clips in shot order).
 */
export function SceneStitchBar({ runIds }: { runIds: string[] }) {
  const runs = useGenerationStore((s) => s.runs);
  const clientId = useGenerationStore((s) => s.clientId);
  const addRun = useGenerationStore((s) => s.addRun);
  const state = useMemo(() => sceneStitchState(runIds, runs), [runIds, runs]);
  const [transition, setTransition] = useState<StitchTransition>("cut");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StitchResult | null>(null);
  const started = useRef(false);

  const go = async () => {
    if (started.current || state.status !== "ready") return;
    started.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await runStitch(
        state.clips,
        {
          transition,
          fadeSeconds: STITCH_DEFAULT_FADE_SECONDS,
          prefix: SCENE_STITCH_PREFIX,
        },
        { fetchImpl: fetch, clientId, onRun: addRun, measure: measureMedia },
      );
      setResult(res);
      showToast("Scene stitched.", "success");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      started.current = false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="space-y-2 rounded-xl border border-light-100 p-3 text-xs dark:border-dark-750"
      data-testid="scene-stitch"
    >
      <p className="text-light-500 dark:text-dark-400">
        {state.status === "failed"
          ? `Shot ${state.failedShots.join(", ")} did not finish, so the scene can't be stitched. Queue the scene again.`
          : state.status === "ready"
            ? `All ${state.total} shots are done. Join them into one clip, in shot order.`
            : `Shots finished: ${state.done} of ${state.total}. Stitching unlocks when all are done.`}
      </p>
      {state.status === "ready" && !result && (
        <>
          <Segmented
            label="Between shots"
            value={transition}
            options={STITCH_TRANSITIONS.map((t) => ({
              id: t.id,
              label: t.label,
            }))}
            onChange={(v) => setTransition(v as StitchTransition)}
            disabled={busy}
          />
          <button
            type="button"
            onClick={() => void go()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-splash px-3 py-1.5 text-splash disabled:opacity-50"
            data-testid="scene-stitch-run"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Clapperboard className="h-3.5 w-3.5" />
            )}
            Stitch scene
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="text-[11px] text-red-500">
          {error}
        </p>
      )}
      {result && (
        <video
          src={result.video.url}
          controls
          playsInline
          className="mx-auto max-h-[60vh] rounded-xl"
          data-testid="scene-stitch-video"
        />
      )}
    </div>
  );
}
