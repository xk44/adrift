/**
 * Scene stitch
 * Glue between a Cinema Studio multi-shot scene and Stitch Clips: the shot
 * runs a scene queued (in shot order) -> their finished video outputs ->
 * stitch_clips params. The UI offers a "Stitch scene" button once every shot
 * is done; nothing here queues anything by itself.
 *
 * Also: the character text a saved Character Profile gives a scene.
 */
import type { ImagineRun } from "@/types";
import {
  profilePromptSuffix,
  type CharacterProfile,
} from "./characterProfiles";
import { SCENE_MAX_SHOTS } from "./cinema";
import {
  clipRefFromUrl,
  stitchParams,
  type StitchClip,
  type StitchOptions,
} from "./stitchClips";

export type SceneStitchStatus = "waiting" | "ready" | "failed";

export interface SceneStitchState {
  status: SceneStitchStatus;
  /** Shots with a finished video. */
  done: number;
  total: number;
  /** Finished shot clips in shot order (complete only when status = ready). */
  clips: StitchClip[];
  /** 1-based shot numbers that failed or produced no video. */
  failedShots: number[];
}

/** First finished video of a run as a stitchable clip, or null. */
export function shotClip(
  run: ImagineRun | undefined,
  shot: number,
): StitchClip | null {
  if (!run) return null;
  for (const job of run.jobs ?? []) {
    if (job.status !== "done") continue;
    for (const url of job.videos ?? []) {
      const ref = clipRefFromUrl(url);
      if (ref) return { ref, url, label: `Shot ${shot}` };
    }
  }
  return null;
}

function shotFailed(run: ImagineRun | undefined): boolean {
  if (!run) return false;
  const jobs = run.jobs ?? [];
  if (run.status === "error" || run.status === "cancelled") return true;
  // Every job settled and none left a video: nothing to stitch for this shot.
  return (
    jobs.length > 0 &&
    jobs.every(
      (j) =>
        j.status === "done" || j.status === "error" || j.status === "cancelled",
    ) &&
    !jobs.some((j) => j.status === "done" && (j.videos ?? []).length > 0)
  );
}

/**
 * Where a queued scene stands. `runIds` is the order the shots were queued
 * (= timeline order); `runs` is any list holding them (the generation store),
 * so the clip order never depends on finish order or store order.
 */
export function sceneStitchState(
  runIds: readonly string[],
  runs: readonly ImagineRun[],
): SceneStitchState {
  const byId = new Map(runs.map((r) => [r.run_id, r]));
  const clips: StitchClip[] = [];
  const failedShots: number[] = [];
  runIds.forEach((id, i) => {
    const run = byId.get(id);
    const clip = shotClip(run, i + 1);
    if (clip) clips.push(clip);
    else if (shotFailed(run)) failedShots.push(i + 1);
  });
  const total = runIds.length;
  const status: SceneStitchStatus =
    failedShots.length > 0
      ? "failed"
      : total >= 2 && clips.length === total
        ? "ready"
        : "waiting";
  return { status, done: clips.length, total, clips, failedShots };
}

/** SaveVideo prefix for a stitched scene. */
export const SCENE_STITCH_PREFIX = "video/scene";

/**
 * stitch_clips params for a ready scene (shot order kept). Throws when the
 * scene is not ready or the clip list is invalid.
 */
export function sceneStitchParams(
  state: SceneStitchState,
  opts: StitchOptions = {},
): Record<string, unknown> {
  if (state.status !== "ready")
    throw new Error(
      state.status === "failed"
        ? `Shot ${state.failedShots.join(", ")} has no clip to stitch.`
        : "Wait until every shot has finished.",
    );
  if (state.clips.length > SCENE_MAX_SHOTS)
    throw new Error(`A scene has at most ${SCENE_MAX_SHOTS} shots.`);
  return stitchParams(state.clips, {
    prefix: SCENE_STITCH_PREFIX,
    ...opts,
  });
}

/**
 * Scene character text from a saved profile: its name, then its look and
 * suffix ("Mara, a calm, watchful sage, in their thirties").
 */
export function profileSceneCharacter(
  p: Pick<CharacterProfile, "name" | "look" | "suffix">,
): string {
  return [p.name.trim(), profilePromptSuffix(p)]
    .filter(Boolean)
    .join(", ")
    .slice(0, 300);
}
