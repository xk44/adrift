// Pure helpers for the Organize archive (and the Tasks/Personalize compare
// pickers): media classification, day-group labels and selection rules.

export interface MediaLike {
  url?: string;
  videoUrl?: string;
  audioUrl?: string;
  meshUrl?: string;
}

export type ThumbKind = "image" | "video" | "audio" | "mesh" | "none";

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv)(?:$|[?&#])/i;
const AUDIO_EXT = /\.(wav|mp3|flac|ogg|m4a|aac)(?:$|[?&#])/i;
const MESH_EXT = /\.(glb|gltf|obj|ply|fbx|stl|spz|ksplat|splat|bvh)(?:$|[?&#])/i;

function extKind(url: string | undefined): ThumbKind | null {
  if (!url) return null;
  if (VIDEO_EXT.test(url)) return "video";
  if (AUDIO_EXT.test(url)) return "audio";
  if (MESH_EXT.test(url)) return "mesh";
  return null;
}

/**
 * What a tile should render. A mesh with a still `url` preview renders as an
 * image (with a 3D badge handled by the caller); a `url` that is really a
 * video/audio file (some history imports put the mp4 in `url`) is never fed
 * to an <img>.
 */
export function thumbKind(item: MediaLike): ThumbKind {
  if (item.videoUrl) return "video";
  if (item.audioUrl) return "audio";
  const fromUrl = extKind(item.url);
  if (fromUrl) return fromUrl;
  if (item.url) return "image";
  if (item.meshUrl) return "mesh";
  return "none";
}

/** Still images only — what a pairwise "which is better" vote can show. */
export function isStillImage(item: MediaLike & { hidden?: boolean }): boolean {
  if (item.hidden || !item.url) return false;
  if (item.videoUrl || item.audioUrl) return false;
  return extKind(item.url) === null;
}

function startOfDay(d: Date): number {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c.getTime();
}

/** Day-group heading: "Today", "Yesterday", weekday within the week, else a date. */
export function dayGroupLabel(
  createdAt: string | undefined,
  now: Date = new Date(),
): string {
  if (!createdAt) return "Unknown";
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return "Unknown";
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7)
    return d.toLocaleDateString("en-US", { weekday: "long" });
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

export interface SelectionGesture {
  /** Cmd/Ctrl-click, or any tap while touch select-mode is on. */
  additive?: boolean;
  /** Shift-click: extend from the last selected id. */
  range?: boolean;
}

/** Next selection after clicking `id` in `orderedIds` order. */
export function nextSelection(
  current: Set<string>,
  id: string,
  orderedIds: string[],
  gesture: SelectionGesture = {},
): Set<string> {
  const next = new Set(current);
  if (gesture.range && current.size > 0) {
    const last = Array.from(current).pop()!;
    const a = orderedIds.indexOf(last);
    const b = orderedIds.indexOf(id);
    if (a >= 0 && b >= 0) {
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++)
        next.add(orderedIds[i]);
      return next;
    }
  }
  if (gesture.additive || gesture.range) {
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }
  if (current.has(id) && current.size === 1) return new Set();
  return new Set([id]);
}
