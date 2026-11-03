/**
 * Video editor clip menu: the AI verbs offered on a clip (right-click or the
 * clip's menu button), each mapped to a hub video tool. Verbs whose tool is
 * not in the hub are left out; install state shows on the tool card. Pure.
 */
import type { TimeRange } from "@/store/videoEditStore";
import {
  clipLength,
  clipStarts,
  timelineDuration,
  type EditList,
} from "./editList";
import { RETAKE_TOOL_KEY } from "./retake";
import type { VideoEditorTool } from "./videoTools";

export interface ClipVerbSpec {
  id: string;
  label: string;
  /** Hub tool keys, first installed one wins. */
  keys: string[];
  /** What it does, for the menu item's title. */
  hint: string;
}

export const CLIP_VERBS: ClipVerbSpec[] = [
  {
    id: "retake",
    label: "Retake",
    keys: [RETAKE_TOOL_KEY],
    hint: "Regenerate this moment from a prompt (up to about 4.5 s)",
  },
  {
    id: "extend",
    label: "Extend",
    keys: ["action:vace_extend"],
    hint: "Continue the shot past its last frame",
  },
  {
    id: "upscale",
    label: "Upscale",
    keys: ["action:upscale_video"],
    hint: "Sharper, higher resolution",
  },
  {
    id: "smooth",
    label: "Smooth / slow-mo",
    keys: ["action:interpolate"],
    hint: "Interpolate in-between frames",
  },
  {
    id: "relight",
    label: "Relight / restyle",
    keys: ["action:vace_restyle"],
    hint: "Same motion in a new light or look",
  },
  {
    id: "remove",
    label: "Remove object",
    keys: ["action:video_object_remove", "action:person_remove"],
    hint: "Erase something and fill in behind it",
  },
  {
    id: "lipsync",
    label: "Lip-sync",
    keys: ["action:video_lipsync"],
    hint: "Match the mouth to new speech",
  },
  {
    id: "grade",
    label: "Match colour",
    keys: ["action:video_palette"],
    hint: "Grade it to a reference palette",
  },
  {
    id: "sound",
    label: "Add sound",
    keys: ["action:add_sound"],
    hint: "Generate sound effects for the picture",
  },
];

export interface ClipVerb extends ClipVerbSpec {
  tool: VideoEditorTool;
}

/** The verbs whose tool is in `tools`, in menu order. */
export function clipVerbs(tools: VideoEditorTool[]): ClipVerb[] {
  const byKey = new Map(tools.map((t) => [t.key, t]));
  const out: ClipVerb[] = [];
  for (const v of CLIP_VERBS) {
    const tool = v.keys.map((k) => byKey.get(k)).find(Boolean);
    if (tool) out.push({ ...v, tool });
  }
  return out;
}

/**
 * What a clip's menu works on: the in / out marks when they overlap the
 * clip (a moment inside it, or a range across cuts), else the whole clip.
 */
export function clipMenuRange(
  edit: EditList,
  clipId: string,
  inPoint: number | null,
  outPoint: number | null,
): TimeRange | null {
  const i = edit.clips.findIndex((c) => c.id === clipId);
  if (i === -1) return null;
  const start = clipStarts(edit)[i];
  const end = start + clipLength(edit.clips[i]);
  if (inPoint !== null || outPoint !== null) {
    const total = timelineDuration(edit);
    const a = Math.max(0, Math.min(inPoint ?? 0, total));
    const b = Math.max(0, Math.min(outPoint ?? total, total));
    if (b > a && a < end - 1e-6 && b > start + 1e-6)
      return { start: a, end: b, source: "marks" };
  }
  return { start, end, source: "clip" };
}
