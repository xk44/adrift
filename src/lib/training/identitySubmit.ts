/**
 * Train Identity submission: trainer preflight -> upload photos -> create
 * the `character` dataset board -> start the LoRA run through the existing
 * moodboard train route. `fetch` is injectable for tests.
 */

import type { Moodboard } from "@/types";
import type { TrainMoodboardResponse } from "@/lib/sref/apiClient";
import { isUploadedPhotoUrl, type IdentityJobSpec } from "./identityJob";

type FetchLike = typeof fetch;

export interface TrainerStatus {
  configured: boolean;
  families: string[];
  error: string | null;
  /** True when Adrift's own local trainer answers (no StyleVault). */
  local?: boolean;
}

export async function getTrainerStatus(
  fetchImpl: FetchLike = fetch,
): Promise<TrainerStatus> {
  try {
    const res = await fetchImpl("/api/identity-lora");
    const body = (await res.json().catch(() => null)) as {
      configured?: boolean;
      families?: string[];
      error?: string;
      trainer?: string;
    } | null;
    if (!res.ok || !body)
      return {
        configured: false,
        families: [],
        error:
          body?.error ?? `Trainer status check failed (HTTP ${res.status}).`,
      };
    return {
      configured: body.configured === true,
      families: Array.isArray(body.families) ? body.families : [],
      error: body.configured === true ? null : (body.error ?? null),
      ...(body.trainer === "local" ? { local: true } : {}),
    };
  } catch {
    return {
      configured: false,
      families: [],
      error: "Trainer status check failed (is Adrift's server running?).",
    };
  }
}

/** A photo to train on: an in-memory blob or a URL (data:, same-origin). */
export type IdentityPhoto = { blob: Blob } | { url: string };

/** Upload one photo; returns its upload-route URL. */
export async function uploadIdentityPhoto(
  photo: IdentityPhoto,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  let blob: Blob;
  if ("blob" in photo) {
    blob = photo.blob;
  } else {
    if (isUploadedPhotoUrl(photo.url)) return photo.url;
    const r = await fetchImpl(photo.url);
    if (!r.ok) throw new Error(`Could not read a photo (HTTP ${r.status}).`);
    blob = await r.blob();
  }
  const form = new FormData();
  form.append("file", blob, "identity.jpg");
  const res = await fetchImpl("/api/moodboards/upload", {
    method: "POST",
    body: form,
  });
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    url?: string;
    error?: string;
  } | null;
  if (!res.ok || !body?.ok || !body.url)
    throw new Error(body?.error ?? `Photo upload failed (HTTP ${res.status}).`);
  return body.url;
}

export type IdentityStage = "check" | "upload" | "dataset" | "train";

export interface IdentitySubmitResult {
  board: Moodboard;
  train: TrainMoodboardResponse;
}

export class TrainerNotConfiguredError extends Error {}

/**
 * Run the whole hand-off. Throws with a user-facing message on any failure;
 * a failure after the board is created leaves the board (retrain it from
 * the Characters page) and reports so.
 */
export async function submitIdentityTraining(
  spec: IdentityJobSpec,
  photos: IdentityPhoto[],
  opts: {
    fetchImpl?: FetchLike;
    onStage?: (stage: IdentityStage, done?: number, total?: number) => void;
  } = {},
): Promise<IdentitySubmitResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stage = opts.onStage ?? (() => {});
  if (photos.length !== spec.captions.length)
    throw new Error("Photo count changed; rebuild the job.");

  stage("check");
  const status = await getTrainerStatus(fetchImpl);
  if (!status.configured)
    throw new TrainerNotConfiguredError(
      status.error ?? "Trainer not configured.",
    );
  if (!status.families.includes(spec.family))
    throw new TrainerNotConfiguredError(
      `Trainer not configured for ${spec.family} (available: ${status.families.join(", ") || "none"}).`,
    );

  const urls: string[] = [];
  for (let i = 0; i < photos.length; i++) {
    stage("upload", i, photos.length);
    urls.push(await uploadIdentityPhoto(photos[i], fetchImpl));
  }
  stage("upload", photos.length, photos.length);

  stage("dataset");
  const boardRes = await fetchImpl("/api/identity-lora", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: spec.boardName,
      images: urls.map((url, i) =>
        spec.captions[i] ? { url, caption: spec.captions[i] } : { url },
      ),
    }),
  });
  const boardBody = (await boardRes.json().catch(() => null)) as {
    ok?: boolean;
    moodboard?: Moodboard;
    error?: string;
  } | null;
  if (!boardRes.ok || !boardBody?.ok || !boardBody.moodboard)
    throw new Error(
      boardBody?.error ?? `Dataset creation failed (HTTP ${boardRes.status}).`,
    );
  const board = boardBody.moodboard;

  stage("train");
  const trainRes = await fetchImpl(
    `/api/moodboards/${encodeURIComponent(board.id)}/train`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spec.request),
    },
  );
  const train = (await trainRes.json().catch(() => null)) as
    (TrainMoodboardResponse & { ok?: boolean; error?: string }) | null;
  if (!trainRes.ok || !train || train.ok === false || train.job_id == null)
    throw new Error(
      `${train?.error ?? `Training failed to start (HTTP ${trainRes.status}).`} The dataset "${board.name}" was saved; retry from the Characters page.`,
    );
  return { board, train };
}
