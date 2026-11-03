"use client";

import { showToast } from "@/components/Toast";
import { deriveClip } from "@/lib/videoEdit/client";
import {
  clipAt,
  clipFromSource,
  replaceRange,
  type EditList,
} from "@/lib/videoEdit/editList";
import {
  MAX_FREEZE_SECONDS,
  MAX_REVERSE_SECONDS,
} from "@/lib/videoEdit/ffmpegArgs";
import { playheadFps, useVideoEditStore } from "@/store/videoEditStore";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Swap a clip's source for a reversed copy of its in → out; fx stay. */
export async function reverseClip(clipId: string): Promise<boolean> {
  const edit = useVideoEditStore.getState().edit as EditList | null;
  const clip = edit?.clips.find((c) => c.id === clipId);
  if (!clip) return false;
  if (clip.out - clip.in > MAX_REVERSE_SECONDS + 1e-6) {
    showToast(
      `Reverse works on up to ${MAX_REVERSE_SECONDS} s of source. Split the clip first.`,
      "info",
      6000,
    );
    return false;
  }
  try {
    const src = await deriveClip({
      op: "reverse",
      video: clip.src.url,
      in: clip.in,
      out: clip.out,
    });
    useVideoEditStore.getState().apply((e) => ({
      ...e,
      clips: e.clips.map((c) =>
        c.id === clipId
          ? {
              ...c,
              src: { ...src, hasAudio: src.hasAudio && clip.src.hasAudio },
              in: 0,
              out: src.duration,
              label: c.label.endsWith(" (reversed)")
                ? c.label.slice(0, -" (reversed)".length)
                : `${c.label || "Clip"} (reversed)`,
            }
          : c,
      ),
    }));
    return true;
  } catch (e) {
    showToast(`Could not reverse the clip: ${errMsg(e)}`, "error", 8000);
    return false;
  }
}

/** Insert a still of the frame at timeline time `t`, held for `seconds`. */
export async function freezeAt(t: number, seconds: number): Promise<boolean> {
  const edit = useVideoEditStore.getState().edit as EditList | null;
  if (!edit) return false;
  const pos = clipAt(edit, t);
  if (!pos) return false;
  const hold = Math.min(MAX_FREEZE_SECONDS, Math.max(0.1, seconds));
  const fps = playheadFps(edit, t);
  const frame = Math.min(pos.sourceTime, pos.clip.src.duration - 1 / fps);
  try {
    const src = await deriveClip({
      op: "freeze",
      video: pos.clip.src.url,
      t: Math.max(0, frame),
      seconds: hold,
      fps,
    });
    const at = pos.start + pos.offset;
    const clip = clipFromSource(src, `${pos.clip.label || "Clip"} freeze`);
    useVideoEditStore.getState().apply((e) => replaceRange(e, at, at, clip));
    return true;
  } catch (e) {
    showToast(`Could not make the freeze frame: ${errMsg(e)}`, "error", 8000);
    return false;
  }
}
