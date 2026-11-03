"use client";

/**
 * Entry points into video mode: a gallery / output URL (probed on the
 * server) or a local file (uploaded). Both open a fresh one-clip project.
 */

import { showToast } from "@/components/Toast";
import {
  probeAudio,
  probeVideo,
  uploadAudio,
  uploadVideo,
} from "@/lib/videoEdit/client";
import {
  MAX_AUDIO_CLIPS,
  timelineDuration,
  type AudioSource,
} from "@/lib/videoEdit/editList";
import { isEditableVideoUrl } from "@/lib/videoEdit/sourceRef";
import { useVideoEditStore } from "@/store/videoEditStore";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Short project name from a prompt / file name. */
export function videoLabel(text: string | undefined | null): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "Untitled video";
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
}

export { isEditableVideoUrl };

/** Probe a served video and open it; false (with a toast) on failure. */
export async function openVideoUrl(
  url: string,
  label?: string | null,
): Promise<boolean> {
  try {
    const src = await probeVideo(url);
    useVideoEditStore.getState().openProject(src, videoLabel(label));
    return true;
  } catch (e) {
    showToast(`Could not open that video: ${errMsg(e)}`, "error", 8000);
    return false;
  }
}

export async function openVideoFile(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<boolean> {
  try {
    const src = await uploadVideo(file, onProgress);
    useVideoEditStore
      .getState()
      .openProject(src, videoLabel(file.name.replace(/\.[^.]+$/, "")));
    return true;
  } catch (e) {
    showToast(`Could not open that video: ${errMsg(e)}`, "error", 8000);
    return false;
  }
}

/** Where new lane audio goes: `at`, else the playhead (0 when it is at the end). */
function laneStart(at?: number): number {
  const s = useVideoEditStore.getState();
  if (at !== undefined) return at;
  const total = s.edit ? timelineDuration(s.edit) : 0;
  return s.playhead < total - 0.1 ? s.playhead : 0;
}

function putAudio(src: AudioSource, label: string, at?: number): boolean {
  const s = useVideoEditStore.getState();
  if (!s.edit) return false;
  if ((s.edit.audio?.length ?? 0) >= MAX_AUDIO_CLIPS) {
    showToast(`The audio lane holds up to ${MAX_AUDIO_CLIPS} clips.`, "error");
    return false;
  }
  s.addAudio(src, label.trim() ? videoLabel(label) : "Audio", laneStart(at));
  return true;
}

/** Upload an audio file onto the A2 lane at `at` (default: the playhead). */
export async function addAudioFile(
  file: File,
  at?: number,
  onProgress?: (fraction: number) => void,
): Promise<boolean> {
  try {
    const src = await uploadAudio(file, onProgress);
    return putAudio(src, file.name.replace(/\.[^.]+$/, ""), at);
  } catch (e) {
    showToast(`Could not add that audio: ${errMsg(e)}`, "error", 8000);
    return false;
  }
}

/** Probe a served audio file (e.g. a gallery output) onto the A2 lane. */
export async function addAudioUrl(
  url: string,
  label: string,
  at?: number,
): Promise<boolean> {
  try {
    return putAudio(await probeAudio(url), label, at);
  } catch (e) {
    showToast(`Could not add that audio: ${errMsg(e)}`, "error", 8000);
    return false;
  }
}
