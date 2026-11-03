/**
 * Video editor: server side. Resolves client media URLs to local files,
 * runs ffprobe / ffmpeg (argv arrays, no shell, bounded runtime), and saves
 * exports to the gallery. Every file it writes lives in the work dir
 * (data/video-edit/<area>/) under a generated name, or — for gallery saves
 * — in ComfyUI's output/adrift_edit folder.
 */
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as WebReadableStream } from "stream/web";
import { fetchImageResponse, uploadImageToComfy } from "@/lib/comfy/http";
import { getRunRowsById, insertLocalOutputRun } from "@/lib/db";
import { env } from "@/lib/env";
import { groupRuns, proxyUrl, type RecentRun } from "@/lib/jobs/recentRuns";
import { withLock } from "@/lib/locks";
import { resolveOutputPath } from "@/lib/mesh/usdz";
import {
  aspectRatio,
  audioSegments,
  frameLayers,
  rangeSegments,
  timelineDuration,
} from "./editList";
import { readEmbedRecipe, readVideoEditRefDays } from "@/lib/runtimeSettings";
import { ADRIFT_VERSION } from "@/lib/recipe/stamp";
import {
  buildVideoEditRecipe,
  videoEditRecipeComment,
} from "@/lib/recipe/videoEditRecipe";
import { referencedUploads, refMaxAgeMs } from "./projectRefs";
import {
  buildCompositeFrameArgs,
  buildFilmstripArgs,
  buildConformArgs,
  buildFreezeArgs,
  buildFrameArgs,
  buildReverseArgs,
  buildProbeArgs,
  buildRenderArgs,
  buildWaveformArgs,
  filmstripTileCount,
  waveformWidth,
  parseAudioProbe,
  parseProbe,
  renderFormat,
  DEFAULT_LOUDNORM_LUFS,
  VP9_CRF,
  type ProbeInfo,
  type RenderCodec,
  type LaneInput,
  type RenderInput,
} from "./ffmpegArgs";
import {
  EXPORT_EXT,
  type ConformRequest,
  type DeriveRequest,
  type ExportSettings,
  type RenderRequest,
} from "./requests";
import {
  AUDIO_SOURCE_EXT,
  parseSourceUrl,
  parseWorkFile,
  sourceKey,
  workMediaUrl,
  WORK_AREAS,
  type SourceRef,
  type WorkArea,
} from "./sourceRef";
import {
  adriftDataPath,
  comfyInputDir,
  comfyOutputDir,
} from "@/lib/paths/resolveDirs";

export const GALLERY_SUBFOLDER = "adrift_edit";
/** Remote-ComfyUI gallery saves go through an in-memory upload; cap it. */
const MAX_UPLOAD_SAVE_BYTES = 512 * 1024 * 1024;
/** Largest source the server copies down from a remote ComfyUI. */
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export class VideoEditError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
  }
}

export function workRoot(): string {
  return path.resolve(
    process.env.ADRIFT_VIDEO_EDIT_DIR ||
      adriftDataPath("video-edit"),
  );
}

/** Absolute path of a work file, or null (bad name / escapes the root). */
export function workPath(
  file: string,
  root: string = workRoot(),
): string | null {
  const w = parseWorkFile(file);
  if (!w) return null;
  const [area, name] = w.file.split("/");
  return resolveOutputPath(root, name, area);
}

function newWorkFile(
  area: WorkArea,
  ext: string,
  stem?: string,
): {
  file: string;
  abs: string;
} {
  const name =
    stem ??
    `${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
  const file = `${area}/${name}.${ext}`;
  const abs = workPath(file);
  if (!abs) throw new VideoEditError("bad work file name");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return { file, abs };
}

// binaries

function binCandidates(name: "ffmpeg" | "ffprobe"): string[] {
  const envKey = name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
  const out: string[] = [];
  const fromEnv = process.env[envKey];
  if (fromEnv) out.push(fromEnv);
  if (name === "ffprobe" && process.env.FFMPEG_PATH) {
    out.push(
      path.join(
        path.dirname(process.env.FFMPEG_PATH),
        process.platform === "win32" ? "ffprobe.exe" : "ffprobe",
      ),
    );
  }
  if (process.platform === "darwin") {
    out.push(`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`);
  } else if (process.platform === "linux") {
    out.push(`/usr/bin/${name}`, `/usr/local/bin/${name}`);
  }
  return out;
}

const binCache = new Map<string, string>();

export function findBinary(name: "ffmpeg" | "ffprobe"): string {
  const hit = binCache.get(name);
  if (hit) return hit;
  const found =
    binCandidates(name).find((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    }) ?? (process.platform === "win32" ? `${name}.exe` : name);
  binCache.set(name, found);
  return found;
}

type RunResult = { ok: true; stdout: string } | { ok: false; error: string };

/**
 * Error text safe to send to the browser: absolute paths (work dir, ComfyUI
 * install, home) are cut down to their file name.
 */
export function redactPaths(text: string): string {
  return text.replace(
    /(?:[A-Za-z]:)?(?:[\\/][^\s'"\\/:]+){2,}[\\/]?/g,
    (m) => {
      const parts = m.split(/[\\/]/).filter(Boolean);
      return parts.at(-1) ?? "";
    },
  );
}

/**
 * Spawn without a shell; kill after `timeoutMs` or when `signal` aborts (the
 * client went away); keep a stderr tail.
 */
export function runBinary(
  bin: string,
  args: string[],
  timeoutMs: number,
  opts: { captureStdout?: boolean; signal?: AbortSignal } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) {
      resolve({ ok: false, error: "cancelled" });
      return;
    }
    let stdout = "";
    let tail = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        ok: false,
        error: redactPaths(`spawn failed: ${(err as Error).message}`),
      });
      return;
    }
    child.stdout?.on("data", (c: Buffer) => {
      if (opts.captureStdout && stdout.length < 4_000_000)
        stdout += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      tail = (tail + c.toString()).slice(-3000);
    });
    let cancelled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const onAbort = () => {
      cancelled = true;
      child.kill("SIGKILL");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (err: Error) => {
      done();
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      resolve({
        ok: false,
        error: missing
          ? `${path.basename(bin)} not found (install ffmpeg or set FFMPEG_PATH)`
          : redactPaths(`spawn failed: ${err.message}`),
      });
    });
    child.on("close", (code: number | null, signal: string | null) => {
      done();
      if (cancelled) {
        resolve({ ok: false, error: "cancelled" });
        return;
      }
      if (code === 0) {
        resolve({ ok: true, stdout });
        return;
      }
      const last =
        tail
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .at(-1) ?? "";
      resolve({
        ok: false,
        error: redactPaths(
          `${signal ? `killed (${signal})` : `exit ${code}`} ${last}`.trim(),
        ),
      });
    });
  });
}

// queues

/**
 * ffmpeg runs one at a time per lane: range cuts (a user waiting to start a
 * tool) never queue behind a long export. A lane holds one running job and
 * at most MAX_QUEUED waiting ones; more is a 429.
 */
export const MAX_QUEUED = 2;
export type RenderLane = "cut" | "export";
const lanePending: Record<RenderLane, number> = { cut: 0, export: 0 };

export function lanePendingCount(lane: RenderLane): number {
  return lanePending[lane];
}

function assertLaneOpen(lane: RenderLane): void {
  if (lanePending[lane] > MAX_QUEUED)
    throw new VideoEditError(
      lane === "cut"
        ? "busy cutting other ranges; try again in a moment"
        : "busy with other exports; try again when they finish",
      429,
    );
}

export async function inLane<T>(
  lane: RenderLane,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  assertLaneOpen(lane);
  lanePending[lane] += 1;
  try {
    return await withLock(`video-edit-${lane}`, async () => {
      if (signal?.aborted) throw new VideoEditError("cancelled", 499);
      return fn();
    });
  } finally {
    lanePending[lane] -= 1;
  }
}

// housekeeping

const HOUR = 3_600_000;
/**
 * How long derived files live: range cuts and renders, filmstrips and
 * frames, downloaded sources. Uploads are the user's own files and never
 * age out: a saved project may still use them (see projectRefs).
 */
const AREA_MAX_AGE: Partial<Record<WorkArea, number>> = {
  renders: 48 * HOUR,
  thumbs: 7 * 24 * HOUR,
  cache: 7 * 24 * HOUR,
};
/** Oldest files go first once the work dir is bigger than this. */
const MAX_WORK_BYTES = 20 * 1024 ** 3;
/** Renders refuse to start with less free space than this. */
const MIN_FREE_BYTES = 1024 ** 3;
const SWEEP_EVERY = 15 * 60_000;
let lastSweep = 0;

/**
 * Remove old generated files from the work dir: derived files past their
 * area's age, then — while the dir is over its size cap — the oldest
 * renders/cache/thumbs, then the oldest uploads no saved project uses.
 * Uploads a project references are never removed. Only plain files directly
 * inside the known areas are touched. Returns the number removed.
 * `refMaxAge` (ms, null = never) is how long an unopened project keeps its
 * uploads pinned; it defaults to the "Keep uploads for saved projects"
 * setting, which defaults to forever.
 */
export function sweepWorkDir(
  now = Date.now(),
  root = workRoot(),
  maxBytes = MAX_WORK_BYTES,
  refMaxAge: number | null = refMaxAgeMs(readVideoEditRefDays()),
): number {
  const files: {
    abs: string;
    file: string;
    area: WorkArea;
    size: number;
    mtime: number;
  }[] = [];
  for (const area of WORK_AREAS) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(root, area));
    } catch {
      continue;
    }
    for (const name of names) {
      const abs = path.join(root, area, name);
      try {
        const st = fs.lstatSync(abs);
        if (st.isFile())
          files.push({
            abs,
            file: `${area}/${name}`,
            area,
            size: st.size,
            mtime: st.mtimeMs,
          });
      } catch {
        // gone already
      }
    }
  }
  let removed = 0;
  const drop = (abs: string) => {
    try {
      fs.unlinkSync(abs);
      removed += 1;
      return true;
    } catch {
      return false;
    }
  };
  const kept = files.filter((f) => {
    const maxAge = AREA_MAX_AGE[f.area];
    return !(maxAge !== undefined && now - f.mtime > maxAge && drop(f.abs));
  });
  let total = kept.reduce((s, f) => s + f.size, 0);
  if (total > maxBytes) {
    const used = referencedUploads(root, now, refMaxAge);
    // Leave anything from the last hour (it may be in use right now).
    const idle = kept
      .filter((f) => now - f.mtime > HOUR)
      .sort((a, b) => a.mtime - b.mtime);
    const victims = [
      ...idle.filter((f) => f.area !== "uploads"),
      ...idle.filter((f) => f.area === "uploads" && !used.has(f.file)),
    ];
    for (const f of victims) {
      if (total <= maxBytes) break;
      if (drop(f.abs)) total -= f.size;
    }
  }
  return removed;
}

/** Sweep at most every 15 min (first call on server start), never throws. */
export function maybeSweep(now = Date.now()): void {
  if (now - lastSweep < SWEEP_EVERY) return;
  lastSweep = now;
  try {
    sweepWorkDir(now);
  } catch {
    // housekeeping only
  }
}

/** 507 when the work dir's disk is nearly full. */
export function ensureFreeSpace(root = workRoot()): void {
  let free = Number.POSITIVE_INFINITY;
  try {
    fs.mkdirSync(root, { recursive: true });
    const st = fs.statfsSync(root);
    free = Number(st.bavail) * Number(st.bsize);
  } catch {
    return;
  }
  if (free < MIN_FREE_BYTES)
    throw new VideoEditError(
      "the server is almost out of disk space; free some space and try again",
      507,
    );
}

// sources

const extOf = (name: string) =>
  (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? "mp4").toLowerCase();

/**
 * Local path of a source. Work files directly; ComfyUI files from the local
 * install when it has them, else downloaded once into cache/ (keyed by
 * ref, so re-renders reuse it).
 */
export async function localSourcePath(ref: SourceRef): Promise<string> {
  if (ref.kind === "work") {
    const abs = workPath(ref.file);
    if (!abs || !fs.existsSync(abs))
      throw new VideoEditError("video file not found", 404);
    return abs;
  }
  const local = resolveOutputPath(
    ref.type === "output"
      ? comfyOutputDir(env.COMFY_ROOT)
      : ref.type === "input"
        ? comfyInputDir(env.COMFY_ROOT)
        : path.join(env.COMFY_ROOT, ref.type),
    ref.filename,
    ref.subfolder,
  );
  if (local && fs.existsSync(local) && fs.statSync(local).isFile())
    return local;

  // ComfyUI reuses temp/ names (previews), so those are fetched fresh each
  // time instead of cached by name; output/input names are unique.
  const stem =
    ref.type === "temp"
      ? `tmp_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`
      : crypto
          .createHash("sha1")
          .update(sourceKey(ref))
          .digest("hex")
          .slice(0, 24);
  const ext = extOf(ref.filename);
  const file = `cache/${stem}.${ext}`;
  const abs = workPath(file);
  if (!abs) throw new VideoEditError("bad cache path");
  return withLock(`video-edit-dl:${file}`, async () => {
    if (fs.existsSync(abs)) return abs;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    let res: Response;
    try {
      res = await fetchImageResponse(ref.filename, ref.subfolder, ref.type);
    } catch (e) {
      throw new VideoEditError(
        redactPaths(
          `could not read the video from ComfyUI: ${(e as Error).message}`,
        ),
        502,
      );
    }
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_DOWNLOAD_BYTES || !res.body)
      throw new VideoEditError("video is too large to edit", 413);
    const tmp = `${abs}.part`;
    let seen = 0;
    const capped = Readable.fromWeb(
      res.body as unknown as WebReadableStream,
    ).on("data", (c: Buffer) => {
      seen += c.length;
      if (seen > MAX_DOWNLOAD_BYTES)
        capped.destroy(new VideoEditError("video is too large to edit", 413));
    });
    try {
      await pipeline(capped, fs.createWriteStream(tmp));
      fs.renameSync(tmp, abs);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e instanceof VideoEditError
        ? e
        : new VideoEditError(
            redactPaths(`download failed: ${(e as Error).message}`),
            502,
          );
    }
    return abs;
  });
}

const probeCache = new Map<string, { mtime: number; info: ProbeInfo }>();

export async function probeFile(abs: string): Promise<ProbeInfo> {
  const st = fs.statSync(abs);
  const hit = probeCache.get(abs);
  if (hit && hit.mtime === st.mtimeMs) return hit.info;
  const r = await runBinary(
    findBinary("ffprobe"),
    buildProbeArgs(abs),
    30_000,
    {
      captureStdout: true,
    },
  );
  if (!r.ok)
    throw new VideoEditError(`could not read the video: ${r.error}`, 422);
  let info: ProbeInfo | null = null;
  try {
    info = parseProbe(JSON.parse(r.stdout));
  } catch {
    info = null;
  }
  if (!info || info.duration <= 0)
    throw new VideoEditError("that file has no playable video stream", 422);
  if (probeCache.size > 500) probeCache.clear();
  probeCache.set(abs, { mtime: st.mtimeMs, info });
  return info;
}

export async function probeSource(ref: SourceRef): Promise<ProbeInfo> {
  return probeFile(await localSourcePath(ref));
}

const audioProbeCache = new Map<string, { mtime: number; duration: number }>();

/** Length of an audio file (or a video's sound) for the A2 lane. */
export async function probeAudioFile(abs: string): Promise<{ duration: number }> {
  const st = fs.statSync(abs);
  const hit = audioProbeCache.get(abs);
  if (hit && hit.mtime === st.mtimeMs) return { duration: hit.duration };
  const r = await runBinary(
    findBinary("ffprobe"),
    buildProbeArgs(abs, true),
    30_000,
    { captureStdout: true },
  );
  if (!r.ok)
    throw new VideoEditError(`could not read the audio: ${r.error}`, 422);
  let info: { duration: number } | null = null;
  try {
    info = parseAudioProbe(JSON.parse(r.stdout), {
      audioOnly: AUDIO_SOURCE_EXT.test(abs),
    });
  } catch {
    info = null;
  }
  if (!info) throw new VideoEditError("that file has no playable sound", 422);
  if (audioProbeCache.size > 500) audioProbeCache.clear();
  audioProbeCache.set(abs, { mtime: st.mtimeMs, duration: info.duration });
  return info;
}

/** Probe reply for an audio source, in the video probe's shape. */
export async function probeAudioSource(ref: SourceRef): Promise<ProbeInfo> {
  const { duration } = await probeAudioFile(await localSourcePath(ref));
  return {
    duration,
    width: 0,
    height: 0,
    fps: 0,
    hasAudio: true,
    videoCodec: "",
    hdr: false,
  };
}

/**
 * Filmstrip sprite for a source (cached by source + size). The tile count
 * comes from the source's length, not the request.
 */
export async function filmstrip(
  ref: SourceRef,
  height: number,
): Promise<{
  url: string;
  count: number;
  tileWidth: number;
  tileHeight: number;
}> {
  const abs = await localSourcePath(ref);
  const info = await probeFile(abs);
  const aspect =
    info.width > 0 && info.height > 0 ? info.width / info.height : 16 / 9;
  const tileHeight = Math.round(height / 2) * 2;
  const tileWidth = Math.max(2, Math.round((tileHeight * aspect) / 2) * 2);
  const count = filmstripTileCount(info.duration);
  const st = fs.statSync(abs);
  const stem = crypto
    .createHash("sha1")
    .update(`${abs}|${st.mtimeMs}|${st.size}|${tileHeight}`)
    .digest("hex")
    .slice(0, 24);
  const out = newWorkFile("thumbs", "jpg", `strip_${stem}`);
  if (!fs.existsSync(out.abs)) {
    await withLock(`video-edit-strip:${stem}`, async () => {
      if (fs.existsSync(out.abs)) return;
      // Written under a temporary name and renamed, so a half-written
      // sprite is never served or treated as cached.
      const tmp = out.abs.replace(/\.jpg$/, ".part.jpg");
      const r = await runBinary(
        findBinary("ffmpeg"),
        buildFilmstripArgs(
          abs,
          info.duration,
          count,
          tileWidth,
          tileHeight,
          tmp,
        ),
        60_000,
      );
      if (!r.ok || !fs.existsSync(tmp)) {
        fs.rmSync(tmp, { force: true });
        throw new VideoEditError(
          `filmstrip failed: ${r.ok ? "no image" : r.error}`,
        );
      }
      fs.renameSync(tmp, out.abs);
    });
  }
  return { url: workMediaUrl(out.file), count, tileWidth, tileHeight };
}

/**
 * Audio waveform PNG for a source (cached by source + height); null when
 * the source has no audio.
 */
export async function waveform(
  ref: SourceRef,
  height: number,
  audio = false,
): Promise<{ url: string; width: number; height: number; duration: number } | null> {
  const abs = await localSourcePath(ref);
  const info = audio ? await probeAudioSource(ref) : await probeFile(abs);
  if (!info.hasAudio) return null;
  const h = Math.round(height / 2) * 2;
  const width = waveformWidth(info.duration);
  const st = fs.statSync(abs);
  const stem = crypto
    .createHash("sha1")
    .update(`${abs}|${st.mtimeMs}|${st.size}|${h}|wave`)
    .digest("hex")
    .slice(0, 24);
  const out = newWorkFile("thumbs", "png", `wave_${stem}`);
  if (!fs.existsSync(out.abs)) {
    await withLock(`video-edit-wave:${stem}`, async () => {
      if (fs.existsSync(out.abs)) return;
      const tmp = out.abs.replace(/\.png$/, ".part.png");
      const r = await runBinary(
        findBinary("ffmpeg"),
        buildWaveformArgs(abs, width, h, tmp, audio),
        60_000,
      );
      if (!r.ok || !fs.existsSync(tmp)) {
        fs.rmSync(tmp, { force: true });
        throw new VideoEditError(
          `waveform failed: ${r.ok ? "no image" : r.error}`,
        );
      }
      fs.renameSync(tmp, out.abs);
    });
  }
  return {
    url: workMediaUrl(out.file),
    width,
    height: h,
    duration: info.duration,
  };
}

// render

export interface RenderResult {
  file: string;
  url: string;
  kind: "video" | "image";
  width: number;
  height: number;
  duration: number;
  fps: number;
  hasAudio: boolean;
  /** Present when saved to the gallery. */
  run?: RecentRun;
  /** Why a requested gallery save did not happen. */
  saveError?: string;
}

async function renderInputs(
  req: RenderRequest,
): Promise<{
  inputs: RenderInput[];
  pieces: { width: number; height: number; fps: number; hdr: boolean }[];
}> {
  const segs = rangeSegments(req.edit, req.start, req.end);
  if (segs.length === 0) throw new VideoEditError("the range is empty", 400);
  const inputs: RenderInput[] = [];
  const pieces: {
    width: number;
    height: number;
    fps: number;
    hdr: boolean;
  }[] = [];
  let skipped = false;
  for (const s of segs) {
    const ref = parseSourceUrl(s.url);
    if (!ref) throw new VideoEditError("unsupported source", 400);
    const abs = await localSourcePath(ref);
    // Trust the probe over the client's numbers.
    const info = await probeFile(abs);
    const out = Math.min(s.out, info.duration);
    if (out - s.in <= 0.01) {
      skipped = true;
      continue;
    }
    // A tool cut keeps the timeline's timing (speed) but not the mix,
    // fades or transitions: those stay clip settings and apply on export.
    const finalMix = req.mode !== "range";
    const xfade = finalMix && !skipped && inputs.length > 0 ? s.xfadeIn : 0;
    skipped = false;
    inputs.push({
      path: abs,
      in: s.in,
      out,
      audio: info.hasAudio && !s.muted && (!finalMix || s.volume > 0),
      ...(s.speed !== 1 ? { speed: s.speed } : {}),
      ...(finalMix && s.volume !== 1 ? { volume: s.volume } : {}),
      ...(finalMix && s.fadeIn > 0 ? { fadeIn: s.fadeIn } : {}),
      ...(finalMix && s.fadeOut > 0 ? { fadeOut: s.fadeOut } : {}),
      ...(xfade ? { xfadeIn: xfade } : {}),
    });
    pieces.push({
      width: info.width,
      height: info.height,
      fps: info.fps,
      hdr: info.hdr,
    });
  }
  if (inputs.length === 0) throw new VideoEditError("the range is empty", 400);
  return { inputs, pieces };
}

/** A2 lane pieces of an export (tool cuts leave the lane out). */
async function laneInputs(req: RenderRequest): Promise<LaneInput[]> {
  if (req.mode !== "mp4") return [];
  const out: LaneInput[] = [];
  for (const s of audioSegments(req.edit, req.start, req.end)) {
    const ref = parseSourceUrl(s.url, { audio: true });
    if (!ref) throw new VideoEditError("unsupported audio source", 400);
    const abs = await localSourcePath(ref);
    const { duration } = await probeAudioFile(abs);
    const end = Math.min(s.out, duration);
    if (end - s.in <= 0.01) continue;
    out.push({
      path: abs,
      in: s.in,
      out: end,
      at: s.at,
      ...(s.gain !== 1 ? { gain: s.gain } : {}),
      ...(s.fadeIn > 0 ? { fadeIn: s.fadeIn } : {}),
      ...(s.fadeOut > 0 ? { fadeOut: Math.min(s.fadeOut, (end - s.in) / 2) } : {}),
    });
  }
  return out;
}

/** Encoder settings: range cuts are tool inputs, exports are finals. */
export function encodeSettings(
  mode: "mp4" | "range",
  quality: ExportSettings["quality"] = "high",
): {
  preset: "fast" | "medium" | "slow";
  crf: number;
} {
  // A cut is an intermediate a tool decodes again: keep it near-lossless so
  // the tool does not see (and the result does not carry) extra artefacts,
  // and quick so the user is not kept waiting (fast vs veryfast: +1.5 dB
  // PSNR at crf 12 for ~1.5x the encode time on a 720p clip).
  if (mode === "range") return { preset: "fast", crf: 12 };
  if (quality === "balanced") return { preset: "medium", crf: 20 };
  if (quality === "small") return { preset: "medium", crf: 24 };
  // A final: slow at crf 17 is ~+0.65 dB over fast/18 at the same size, and
  // clips here are seconds long, so the extra encode time is small.
  return { preset: "slow", crf: 17 };
}

/** Codec, file type and encoder settings for a final in the chosen format. */
export function exportEncoding(output: ExportSettings): {
  codec: RenderCodec;
  ext: string;
  crf?: number;
  preset?: "fast" | "medium" | "slow";
} {
  const ext = EXPORT_EXT[output.format];
  if (output.format === "prores") return { codec: "prores", ext };
  if (output.format === "webm")
    return { codec: "vp9", ext, crf: VP9_CRF[output.quality] };
  return { codec: "h264", ext, ...encodeSettings("mp4", output.quality) };
}

/**
 * Encode time budget: about 8 s per output second at 1080p H.264, more for
 * bigger frames and VP9 (much slower to encode).
 */
export function renderTimeoutMs(
  duration: number,
  width: number,
  height: number,
  codec: RenderCodec = "h264",
): number {
  const pixels = Math.max(1, (width * height) / (1920 * 1080));
  const k = codec === "vp9" ? 3 : 1;
  return Math.round(
    Math.min(30 * 60_000, 60_000 + duration * 8_000 * pixels * k),
  );
}

export async function render(
  req: RenderRequest,
  signal?: AbortSignal,
): Promise<RenderResult> {
  maybeSweep();
  ensureFreeSpace();
  if (req.mode === "frame") return renderFrame(req, signal);
  const lane: RenderLane = req.mode === "range" ? "cut" : "export";
  // Fail fast (before resolving / downloading sources) when the lane is full.
  assertLaneOpen(lane);
  const { inputs, pieces } = await renderInputs(req);
  const audioLane = await laneInputs(req);
  // Tool cuts keep the source frame; the export frame / size / rate apply
  // to finals only.
  const final = req.mode !== "range";
  const frame = final ? req.edit.frame : undefined;
  const fmt = renderFormat(
    pieces,
    final
      ? {
          aspect: frame ? aspectRatio(frame.aspect) : undefined,
          shortSide:
            req.output.resolution === "keep"
              ? undefined
              : Number(req.output.resolution),
          fps: req.output.fps || undefined,
        }
      : {},
  );
  const withAudio = inputs.some((i) => i.audio) || audioLane.length > 0;
  const area: WorkArea = "renders";
  // Tool cuts are always H.264 mp4 (every tool reads it).
  const enc = final
    ? exportEncoding(req.output)
    : { codec: "h264" as const, ext: "mp4", ...encodeSettings("range") };
  const out = newWorkFile(area, enc.ext);
  const duration = inputs.reduce(
    (s, i) => s + (i.out - i.in) / (i.speed ?? 1),
    0,
  );
  const timeoutMs = renderTimeoutMs(duration, fmt.width, fmt.height, enc.codec);
  // Finals carry their recipe; cuts for a tool are intermediates.
  const embed = final && readEmbedRecipe();
  const args = buildRenderArgs(inputs, out.abs, {
    ...fmt,
    withAudio,
    ...(audioLane.length ? { lane: audioLane } : {}),
    ...(final && req.output.duck ? { duck: true } : {}),
    ...(final && req.output.loudnorm ? { loudnorm: DEFAULT_LOUDNORM_LUFS } : {}),
    bt709: !pieces.some((p) => p.hdr),
    ...(frame ? { fit: { x: frame.x, y: frame.y } } : {}),
    codec: enc.codec,
    ...(enc.crf !== undefined ? { crf: enc.crf } : {}),
    ...(enc.preset ? { preset: enc.preset } : {}),
    stripMetadata: final && !embed,
    ...(embed
      ? {
          comment: videoEditRecipeComment(
            buildVideoEditRecipe(inputs, fmt, ADRIFT_VERSION, audioLane),
          ),
        }
      : {}),
  });
  const r = await inLane(
    lane,
    () => runBinary(findBinary("ffmpeg"), args, timeoutMs, { signal }),
    signal,
  ).catch((e) => {
    fs.rmSync(out.abs, { force: true });
    throw e;
  });
  if (!r.ok) {
    fs.rmSync(out.abs, { force: true });
    if (r.error === "cancelled") throw new VideoEditError("cancelled", 499);
    throw new VideoEditError(`render failed: ${r.error}`);
  }
  const result: RenderResult = {
    file: out.file,
    url: workMediaUrl(out.file),
    kind: "video",
    width: fmt.width,
    height: fmt.height,
    duration: Math.round(duration * 1000) / 1000,
    fps: fmt.fps,
    hasAudio: withAudio,
  };
  if (req.save) return saveResult(result, out.abs, req);
  return result;
}

async function renderFrame(
  req: RenderRequest,
  signal?: AbortSignal,
): Promise<RenderResult> {
  const total = timelineDuration(req.edit);
  // A frame "at" the very end is the last frame, not past it.
  const t = Math.min(req.t, Math.max(0, total - 0.001));
  const layers = frameLayers(req.edit, t).filter((l) => l.weight > 1e-3);
  if (!layers.length) throw new VideoEditError("no frame at that time", 400);
  const inputs = await Promise.all(
    layers.map(async (l) => {
      const ref = parseSourceUrl(l.url);
      if (!ref) throw new VideoEditError("unsupported source", 400);
      const abs = await localSourcePath(ref);
      const info = await probeFile(abs);
      return {
        ...l,
        path: abs,
        t: Math.min(l.time, Math.max(0, info.duration - 0.001)),
        info,
      };
    }),
  );
  const info = inputs[0].info;
  const out = newWorkFile("thumbs", "png");
  const plain = inputs.length === 1 && inputs[0].level >= 1;
  const r = await runBinary(
    findBinary("ffmpeg"),
    plain
      ? buildFrameArgs(inputs[0].path, inputs[0].t, out.abs)
      : buildCompositeFrameArgs(
          inputs,
          out.abs,
          info.width || 1280,
          info.height || 720,
        ),
    60_000,
    { signal },
  );
  if (!r.ok || !fs.existsSync(out.abs)) {
    fs.rmSync(out.abs, { force: true });
    throw new VideoEditError(
      `frame export failed: ${r.ok ? "no frame" : r.error}`,
    );
  }
  const result: RenderResult = {
    file: out.file,
    url: workMediaUrl(out.file),
    kind: "image",
    width: info.width,
    height: info.height,
    duration: 0,
    fps: 0,
    hasAudio: false,
  };
  if (req.save) return saveResult(result, out.abs, req);
  return result;
}

/**
 * Put an export in the gallery: copy into ComfyUI's output/adrift_edit when
 * the install is local (no size limit), else upload to its input dir. Then
 * record a finished run so history lists it. A failed save keeps the work
 * file (still downloadable) and reports why.
 */
async function saveResult(
  result: RenderResult,
  abs: string,
  req: RenderRequest,
): Promise<RenderResult> {
  const ext = path.extname(abs).slice(1).toLowerCase() || "mp4";
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const filename = `adrift_edit_${stamp}_${crypto.randomBytes(3).toString("hex")}.${ext}`;
  let type: "output" | "input" = "output";
  let subfolder = GALLERY_SUBFOLDER;
  try {
    const outputRoot = comfyOutputDir(env.COMFY_ROOT);
    const dest = resolveOutputPath(outputRoot, filename, GALLERY_SUBFOLDER);
    if (dest && fs.existsSync(outputRoot)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // Clone where the filesystem can (APFS / btrfs), else a plain copy;
      // the work file is removed once the run is recorded.
      fs.copyFileSync(abs, dest, fs.constants.COPYFILE_FICLONE);
    } else {
      if (fs.statSync(abs).size > MAX_UPLOAD_SAVE_BYTES)
        throw new Error(
          "the export is too large to upload to a remote ComfyUI (download it instead)",
        );
      const ref = await uploadImageToComfy(
        new Uint8Array(fs.readFileSync(abs)),
        filename,
        GALLERY_SUBFOLDER,
      );
      const m = /^(?:(.*)\/)?([^/]+) \[input\]$/.exec(ref);
      type = "input";
      subfolder = m?.[1] ?? GALLERY_SUBFOLDER;
    }
    const runId = `vedit-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
    const text =
      req.label ||
      (result.kind === "video" ? "Edited video" : "Frame from an edited video");
    insertLocalOutputRun({
      runId,
      text,
      params: {
        tool: "video_edit",
        mode: req.mode,
        clips: req.edit.clips.length,
        ...(result.kind === "video" ? { duration: result.duration } : {}),
        // Enough to see (and later reopen) what the export was made from.
        ...(req.mode === "frame" ? { t: req.t } : { start: req.start, end: req.end }),
        ...(req.mode === "mp4"
          ? { output: req.output, ...(req.edit.frame ? { frame: req.edit.frame } : {}) }
          : {}),
        edit: req.edit.clips.slice(0, 50).map((c) => ({
          url: c.src.url,
          in: c.in,
          out: c.out,
          ...(c.muted ? { muted: true } : {}),
          ...(c.madeBy ? { madeBy: c.madeBy } : {}),
          ...(c.speed !== undefined ? { speed: c.speed } : {}),
          ...(c.volume !== undefined ? { volume: c.volume } : {}),
          ...(c.fadeIn ? { fadeIn: c.fadeIn } : {}),
          ...(c.fadeOut ? { fadeOut: c.fadeOut } : {}),
        })),
      },
      width: result.width || null,
      height: result.height || null,
      source: "video_edit",
      output: {
        filename,
        subfolder,
        type,
        mediaType: result.kind,
      },
    });
    const run = groupRuns(getRunRowsById(runId))[0];
    // The gallery has it now; the work copy is not needed.
    fs.rmSync(abs, { force: true });
    return { ...result, run, url: proxyUrl(filename, subfolder, type) };
  } catch (e) {
    return {
      ...result,
      saveError: redactPaths(
        `could not add it to the gallery: ${(e as Error).message}`,
      ),
    };
  }
}

// conform

/** Codecs an mp4 can carry as they are. */
const MP4_COPY_CODECS = new Set(["h264", "hevc", "av1"]);

/**
 * A tool result made ready to replace its range: the cut's original sound
 * under it and / or the edit's frame rate. Written to uploads/ so the
 * project's refs keep it.
 */
export async function conformResult(
  req: ConformRequest,
  signal?: AbortSignal,
): Promise<{ url: string; file: string; info: ProbeInfo }> {
  maybeSweep();
  ensureFreeSpace();
  assertLaneOpen("cut");
  const videoAbs = await localSourcePath(req.video);
  const info = await probeFile(videoAbs);
  let audioAbs: string | undefined;
  if (req.audio) {
    audioAbs = await localSourcePath(req.audio).catch((e) => {
      throw e instanceof VideoEditError && e.status === 404
        ? new VideoEditError(
            "the original cut is gone (housekeeping); untick Keep the original sound",
            404,
          )
        : e;
    });
    const a = await probeFile(audioAbs);
    if (!a.hasAudio)
      throw new VideoEditError("the original range has no sound", 400);
  }
  const fps =
    req.fps && Math.abs(req.fps - info.fps) > 0.01 ? req.fps : undefined;
  if (!audioAbs && !fps)
    throw new VideoEditError("it already matches", 400);
  const out = newWorkFile("uploads", "mp4");
  const args = buildConformArgs(videoAbs, out.abs, {
    duration: info.duration,
    ...(audioAbs ? { audioPath: audioAbs } : {}),
    ...(fps ? { fps } : {}),
    copyVideo: MP4_COPY_CODECS.has(info.videoCodec),
  });
  const r = await inLane(
    "cut",
    () =>
      runBinary(
        findBinary("ffmpeg"),
        args,
        Math.min(20 * 60_000, 60_000 + info.duration * 8_000),
        { signal },
      ),
    signal,
  ).catch((e) => {
    fs.rmSync(out.abs, { force: true });
    throw e;
  });
  if (!r.ok) {
    fs.rmSync(out.abs, { force: true });
    if (r.error === "cancelled") throw new VideoEditError("cancelled", 499);
    throw new VideoEditError(`could not conform the result: ${r.error}`);
  }
  return {
    url: workMediaUrl(out.file),
    file: out.file,
    info: await probeFile(out.abs),
  };
}

/**
 * Reverse or freeze-frame: new near-lossless media in uploads/ (kept while a
 * project references it) that the timeline uses like any clip.
 */
export async function deriveClip(
  req: DeriveRequest,
  signal?: AbortSignal,
): Promise<{ url: string; file: string; info: ProbeInfo }> {
  maybeSweep();
  ensureFreeSpace();
  assertLaneOpen("cut");
  const abs = await localSourcePath(req.video);
  const info = await probeFile(abs);
  const end = Math.max(0, info.duration - 0.001);
  const out = newWorkFile("uploads", "mp4");
  let args: string[];
  let seconds: number;
  if (req.op === "reverse") {
    const a = Math.min(req.in, end);
    const b = Math.min(req.out, info.duration);
    if (b - a < 0.04) throw new VideoEditError("the clip is too short", 400);
    seconds = b - a;
    args = buildReverseArgs(abs, a, b, out.abs, info.hasAudio);
  } else {
    seconds = req.seconds;
    args = buildFreezeArgs(
      abs,
      Math.min(req.t, Math.max(0, info.duration - 1 / (info.fps || 24))),
      req.seconds,
      req.fps || info.fps,
      out.abs,
    );
  }
  const r = await inLane(
    "cut",
    () =>
      runBinary(
        findBinary("ffmpeg"),
        args,
        renderTimeoutMs(seconds, info.width, info.height),
        { signal },
      ),
    signal,
  ).catch((e) => {
    fs.rmSync(out.abs, { force: true });
    throw e;
  });
  if (!r.ok) {
    fs.rmSync(out.abs, { force: true });
    if (r.error === "cancelled") throw new VideoEditError("cancelled", 499);
    throw new VideoEditError(`could not ${req.op} the clip: ${r.error}`);
  }
  return {
    url: workMediaUrl(out.file),
    file: out.file,
    info: await probeFile(out.abs),
  };
}

// uploads

/**
 * Stream a request body into uploads/ (byte-capped), probe it, and return
 * its media URL + info. Non-video files are removed again.
 */
export async function storeUpload(
  body: ReadableStream<Uint8Array>,
  ext: string,
  maxBytes: number,
  audio = false,
): Promise<{ url: string; file: string; info: ProbeInfo }> {
  const out = newWorkFile("uploads", ext);
  let seen = 0;
  const src = Readable.fromWeb(body as unknown as WebReadableStream).on(
    "data",
    (c: Buffer) => {
      seen += c.length;
      if (seen > maxBytes)
        src.destroy(new VideoEditError("file is too large", 413));
    },
  );
  try {
    await pipeline(src, fs.createWriteStream(out.abs));
    if (seen === 0) throw new VideoEditError("empty upload", 400);
    const info = audio
      ? await probeAudioSource({ kind: "work", file: out.file, area: "uploads" })
      : await probeFile(out.abs);
    return { url: workMediaUrl(out.file), file: out.file, info };
  } catch (e) {
    fs.rmSync(out.abs, { force: true });
    throw e instanceof VideoEditError
      ? e
      : new VideoEditError(
          redactPaths(`upload failed: ${(e as Error).message}`),
          400,
        );
  }
}

export const WORK_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  png: "image/png",
  jpg: "image/jpeg",
  flac: "audio/flac",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
};
