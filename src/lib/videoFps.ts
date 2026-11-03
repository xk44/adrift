/**
 * Frame rate of an uploaded clip, read from the file itself.
 *
 * The browser's <video> metadata has no fps, so probeVideo can't give one.
 * MP4 / MOV / M4V (ISO BMFF) carry it exactly: the video track's sample
 * count over its media duration (stts table, mdhd timescale). WebM and
 * broken files return null; callers then keep the graph's own fps.
 * Pure (no DOM).
 */

/** Highest fps the output nodes accept (CreateVideo's fps max). */
export const MAX_VIDEO_FPS = 120;

interface Box {
  type: string;
  start: number; // payload start
  end: number; // payload end (exclusive)
}

function readBoxes(view: DataView, from: number, to: number): Box[] {
  const out: Box[] = [];
  let pos = from;
  while (pos + 8 <= to) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(
      view.getUint8(pos + 4),
      view.getUint8(pos + 5),
      view.getUint8(pos + 6),
      view.getUint8(pos + 7),
    );
    let header = 8;
    if (size === 1) {
      if (pos + 16 > to) break;
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = to - pos;
    }
    if (size < header || pos + size > to) break;
    out.push({ type, start: pos + header, end: pos + size });
    pos += size;
  }
  return out;
}

function child(view: DataView, box: Box, type: string): Box | undefined {
  return readBoxes(view, box.start, box.end).find((b) => b.type === type);
}

function path(view: DataView, box: Box, types: string[]): Box | undefined {
  let cur: Box | undefined = box;
  for (const t of types) {
    if (!cur) return undefined;
    cur = child(view, cur, t);
  }
  return cur;
}

function trackFps(view: DataView, trak: Box): number | null {
  const mdia = child(view, trak, "mdia");
  if (!mdia) return null;
  const hdlr = child(view, mdia, "hdlr");
  if (!hdlr || hdlr.end - hdlr.start < 12) return null;
  const handler = String.fromCharCode(
    ...[8, 9, 10, 11].map((i) => view.getUint8(hdlr.start + i)),
  );
  if (handler !== "vide") return null;
  const mdhd = child(view, mdia, "mdhd");
  if (!mdhd) return null;
  const version = view.getUint8(mdhd.start);
  const tsAt = mdhd.start + (version === 1 ? 20 : 12);
  if (tsAt + 4 > mdhd.end) return null;
  const timescale = view.getUint32(tsAt);
  const stts = path(view, mdia, ["minf", "stbl", "stts"]);
  if (!stts || stts.end - stts.start < 8 || !timescale) return null;
  const count = view.getUint32(stts.start + 4);
  let samples = 0;
  let ticks = 0;
  for (let i = 0; i < count; i++) {
    const at = stts.start + 8 + i * 8;
    if (at + 8 > stts.end) return null;
    const n = view.getUint32(at);
    samples += n;
    ticks += n * view.getUint32(at + 4);
  }
  if (!samples || !ticks) return null;
  return (samples * timescale) / ticks;
}

/** fps rounded to 3 decimals (29.97, 23.976), or null when out of range. */
export function normalizeFps(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const fps = Math.round(value * 1000) / 1000;
  return fps >= 1 && fps <= MAX_VIDEO_FPS ? fps : null;
}

/** Video-track fps of an MP4 / MOV file, or null (not ISO BMFF, no video). */
export function mp4VideoFps(bytes: ArrayBuffer | Uint8Array): number | null {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  try {
    const moov = readBoxes(view, 0, view.byteLength).find(
      (b) => b.type === "moov",
    );
    if (!moov) return null;
    for (const box of readBoxes(view, moov.start, moov.end)) {
      if (box.type !== "trak") continue;
      const fps = normalizeFps(trackFps(view, box));
      if (fps !== null) return fps;
    }
  } catch {
    return null;
  }
  return null;
}
