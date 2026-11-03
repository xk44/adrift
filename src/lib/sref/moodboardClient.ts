/**
 * Moodboard API Client
 * Frontend utilities for moodboard CRUD and --p resolution.
 */

import type {
  Moodboard,
  MoodboardCaptionSettings,
  MoodboardImage,
  MoodboardKind,
} from "@/types";

export type { Moodboard, MoodboardImage, MoodboardKind };

export async function listMoodboards(kind?: MoodboardKind): Promise<{
  ok: boolean;
  moodboards: Moodboard[];
  error?: string;
}> {
  const query = kind ? `?kind=${encodeURIComponent(kind)}` : "";
  const res = await fetch(`/api/moodboards${query}`);
  return res.json();
}

export async function createMoodboard(data: {
  name: string;
  description?: string;
  images?: MoodboardImage[];
  isDefault?: boolean;
  kind?: MoodboardKind;
}): Promise<{
  ok: boolean;
  moodboard?: Moodboard;
  created?: boolean;
  error?: string;
}> {
  const res = await fetch("/api/moodboards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function updateMoodboard(data: {
  id: string;
  name?: string;
  description?: string | null;
  images?: MoodboardImage[];
  isDefault?: boolean;
  /** null clears the dataset caption knobs. */
  captionSettings?: MoodboardCaptionSettings | null;
}): Promise<{ ok: boolean; moodboard?: Moodboard; error?: string }> {
  const res = await fetch("/api/moodboards", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function deleteMoodboard(
  id: string,
): Promise<{ ok: boolean; deleted?: string; error?: string }> {
  const res = await fetch(`/api/moodboards?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return res.json();
}

type BulkMoodboardResponse = {
  ok: boolean;
  moodboards?: Moodboard[];
  deleted?: string[];
  updated?: string[];
  target?: Moodboard;
  error?: string;
};

export async function bulkDeleteMoodboards(
  ids: string[],
): Promise<BulkMoodboardResponse> {
  const res = await fetch("/api/moodboards/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete", ids }),
  });
  return res.json();
}

export async function bulkTagMoodboards(data: {
  ids: string[];
  tags: string[];
  mode: "add" | "remove";
}): Promise<BulkMoodboardResponse> {
  const res = await fetch("/api/moodboards/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "tag", ...data }),
  });
  return res.json();
}

export async function bulkMergeMoodboards(data: {
  ids: string[];
  targetId: string;
}): Promise<BulkMoodboardResponse> {
  const res = await fetch("/api/moodboards/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "merge", ...data }),
  });
  return res.json();
}

/**
 * Resolve a --p token to SREF items.
 * Returns null if no matching moodboard found.
 */
export async function resolvePersonalization(
  name?: string,
): Promise<MoodboardImage[] | null> {
  // --p only resolves against plain moodboards, not character/style datasets.
  const { ok, moodboards } = await listMoodboards("moodboard");
  if (!ok || !moodboards.length) return null;

  if (name) {
    const match = moodboards.find(
      (m) => m.name.toLowerCase() === name.toLowerCase(),
    );
    return match?.images ?? null;
  }

  const def = moodboards.find((m) => m.isDefault);
  return def?.images ?? null;
}

export default {
  listMoodboards,
  createMoodboard,
  updateMoodboard,
  deleteMoodboard,
  bulkDeleteMoodboards,
  bulkTagMoodboards,
  bulkMergeMoodboards,
  resolvePersonalization,
};
