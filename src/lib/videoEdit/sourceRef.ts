/**
 * Video editor: which source URLs the server will read, as plain refs.
 *
 * Clients only ever send same-origin media URLs; the render / probe routes
 * turn them back into a ComfyUI view ref (filename + subfolder + type) or a
 * file in the editor's own work dir. Anything else (other hosts' paths,
 * traversal, control chars, odd extensions) is rejected here, before any
 * filesystem or network access. Pure: safe on client and server.
 */

const SEGMENT_RE = /^[A-Za-z0-9 ._()+-]+$/;
const MAX_PARAM = 255;

/**
 * Plain filename + subfolder (same rules as validateOutputRef in
 * lib/mesh/usdz, which is server-only): no separators in the name, no
 * empty / dot / traversal segments in the subfolder.
 */
export function validateViewRef(
  filename: unknown,
  subfolder: unknown,
): { filename: string; subfolder: string } | null {
  if (typeof filename !== "string" || filename.length > MAX_PARAM) return null;
  if (!SEGMENT_RE.test(filename) || filename === "." || filename.includes(".."))
    return null;
  const sub = subfolder ?? "";
  if (typeof sub !== "string" || sub.length > MAX_PARAM) return null;
  if (
    sub &&
    sub
      .split("/")
      .some((s) => !SEGMENT_RE.test(s) || s === "." || s.includes(".."))
  )
    return null;
  return { filename, subfolder: sub };
}

export const VIDEO_SOURCE_EXT = /\.(mp4|mov|m4v|webm|mkv)$/i;
/** Audio files the A2 lane plays (video files with sound are accepted too). */
export const AUDIO_SOURCE_EXT = /\.(flac|mp3|wav|ogg|opus|m4a|aac)$/i;
export const COMFY_VIEW_TYPES = ["output", "input", "temp"] as const;
export type ComfyViewType = (typeof COMFY_VIEW_TYPES)[number];

/** Work-dir areas: uploads (user files), cache (downloaded sources),
 * renders (exports and range cuts), thumbs (filmstrips and frames). */
export const WORK_AREAS = ["uploads", "cache", "renders", "thumbs"] as const;
export type WorkArea = (typeof WORK_AREAS)[number];

/** "<area>/<name>.<ext>": flat, generated names only. */
const WORK_FILE_RE =
  /^(uploads|cache|renders|thumbs)\/([A-Za-z0-9_-]{1,96})\.(mp4|mov|m4v|webm|mkv|png|jpg|flac|mp3|wav|ogg|opus|m4a|aac)$/;

export type SourceRef =
  | {
      kind: "comfy";
      filename: string;
      subfolder: string;
      type: ComfyViewType;
    }
  | { kind: "work"; file: string; area: WorkArea };

export const MEDIA_ROUTE = "/api/video-edit/media";

export function workMediaUrl(file: string): string {
  return `${MEDIA_ROUTE}?f=${encodeURIComponent(file)}`;
}

/** Validate a work-dir relative file name ("renders/abc.mp4"). */
export function parseWorkFile(
  raw: unknown,
): { file: string; area: WorkArea; ext: string } | null {
  if (typeof raw !== "string" || raw.length > 160) return null;
  const m = WORK_FILE_RE.exec(raw);
  if (!m) return null;
  return { file: raw, area: m[1] as WorkArea, ext: m[3].toLowerCase() };
}

/**
 * Parse a client media URL into a ref, or null when the server must not
 * read it. Accepts:
 *  - /api/comfy/image?filename=..&subfolder=..&type=output|input|temp
 *  - <any origin>/view?filename=..  (ComfyUI view URLs from older runs;
 *    only the query is used, the host is ignored — reads go to the
 *    configured backends)
 *  - /api/video-edit/media?f=<area>/<name>.<ext>
 *
 * `videoOnly` (default true) also requires a video container extension;
 * `audio` accepts audio files as well.
 */
export function parseSourceUrl(
  raw: unknown,
  opts: { videoOnly?: boolean; audio?: boolean } = {},
): SourceRef | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048)
    return null;
  if (/[\x00-\x1f\x7f\\]/.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw, "http://local.invalid");
  } catch {
    return null;
  }
  const videoOnly = opts.videoOnly !== false;
  const extOk = (name: string) =>
    !videoOnly ||
    VIDEO_SOURCE_EXT.test(name) ||
    (opts.audio === true && AUDIO_SOURCE_EXT.test(name));
  const sameOrigin = u.origin === "http://local.invalid";
  if (sameOrigin && u.pathname === MEDIA_ROUTE) {
    const w = parseWorkFile(u.searchParams.get("f"));
    if (!w) return null;
    if (!extOk(w.file)) return null;
    return { kind: "work", file: w.file, area: w.area };
  }
  const isProxy = sameOrigin && u.pathname === "/api/comfy/image";
  const isView =
    /^https?:$/.test(u.protocol) &&
    !sameOrigin &&
    (u.pathname === "/view" || u.pathname === "/api/view");
  if (!isProxy && !isView) return null;
  const type = (u.searchParams.get("type") ?? "output") as ComfyViewType;
  if (!COMFY_VIEW_TYPES.includes(type)) return null;
  const ref = validateViewRef(
    u.searchParams.get("filename"),
    u.searchParams.get("subfolder") ?? "",
  );
  if (!ref) return null;
  if (!extOk(ref.filename)) return null;
  return { kind: "comfy", ...ref, type };
}

/** Stable cache key for a ref (used to name downloaded copies). */
export function sourceKey(ref: SourceRef): string {
  return ref.kind === "work"
    ? `work:${ref.file}`
    : `comfy:${ref.type}:${ref.subfolder}/${ref.filename}`;
}

/** True when a gallery URL points at a video the editor can open. */
export function isEditableVideoUrl(url: string | undefined | null): boolean {
  return !!url && parseSourceUrl(url) !== null;
}

/**
 * Upload work files ("uploads/<name>.<ext>") an edit list uses, each once,
 * for the server's project refs (uploads a project uses are never swept).
 */
export function uploadFilesInEdit(
  edit: {
    clips: { src: { url: string } }[];
    audio?: { src: { url: string } }[];
  } | null,
): string[] {
  const out = new Set<string>();
  const urls = [
    ...(edit?.clips ?? []).map((c) => c.src.url),
    ...(edit?.audio ?? []).map((c) => c.src.url),
  ];
  for (const url of urls) {
    const ref = parseSourceUrl(url, { audio: true });
    if (ref?.kind === "work" && ref.area === "uploads") out.add(ref.file);
  }
  return [...out];
}
