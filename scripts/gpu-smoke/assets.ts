/**
 * Procedural test assets for the GPU smoke runner: gradient / shape PNGs, an
 * RGBA sticker, a speech-like tone WAV and a 1 s synthetic clip with that
 * tone as its soundtrack. Everything is drawn from code (no photos, no
 * people), so the files can be regenerated anywhere and never committed.
 *
 * PNG and WAV are encoded here with node:zlib; the clip's frames are drawn
 * here too and handed to ffmpeg (libx264 + AAC) only for the container.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export type SmokeAssetKind = "image" | "video" | "audio";

export interface SmokeAsset {
  file: string;
  kind: SmokeAssetKind;
  width?: number;
  height?: number;
  seconds?: number;
  fps?: number;
}

/** ComfyUI input subfolder the runner uploads into (`--run` only). */
export const SMOKE_SUBFOLDER = "adrift_smoke";

export const SMOKE_ASSETS = {
  gradient: {
    file: "adrift_smoke_gradient.png",
    kind: "image",
    width: 256,
    height: 256,
  },
  shapes: {
    file: "adrift_smoke_shapes.png",
    kind: "image",
    width: 384,
    height: 256,
  },
  sticker: {
    file: "adrift_smoke_sticker.png",
    kind: "image",
    width: 128,
    height: 128,
  },
  tone: { file: "adrift_smoke_tone.wav", kind: "audio", seconds: 2 },
  clip: {
    file: "adrift_smoke_clip.mp4",
    kind: "video",
    width: 256,
    height: 256,
    seconds: 1,
    fps: 24,
  },
} as const satisfies Record<string, SmokeAsset>;

export type SmokeAssetId = keyof typeof SMOKE_ASSETS;

export function isSmokeAssetId(id: unknown): id is SmokeAssetId {
  return typeof id === "string" && Object.hasOwn(SMOKE_ASSETS, id);
}

/**
 * --source overrides: point a source id at a file already in ComfyUI's input
 * folder (real footage for a quality pass) instead of the procedural asset.
 */
interface SourceOverride {
  subfolder: string;
  file: string;
  width?: number;
  height?: number;
  seconds?: number;
}
const sourceOverrides = new Map<SmokeAssetId, SourceOverride>();

/**
 * Parse "<id>=<input-relative path>[@WxH][:SECONDS]" and register it; throws
 * on bad input. Size / seconds feed the seed run the way a real upload would.
 */
export function setSmokeSourceOverride(spec: string): void {
  const eq = spec.indexOf("=");
  const id = spec.slice(0, eq);
  let rel = spec.slice(eq + 1).replace(/^\/+/, "");
  let seconds: number | undefined;
  let width: number | undefined;
  let height: number | undefined;
  const sec = /:(\d+(?:\.\d+)?)$/.exec(rel);
  if (sec) {
    seconds = Number(sec[1]);
    rel = rel.slice(0, sec.index);
  }
  const size = /@(\d+)x(\d+)$/.exec(rel);
  if (size) {
    width = Number(size[1]);
    height = Number(size[2]);
    rel = rel.slice(0, size.index);
  }
  if (eq < 1 || !isSmokeAssetId(id))
    throw new Error(`--source wants <id>=<path>, id one of ${Object.keys(SMOKE_ASSETS).join(", ")}; got "${spec}"`);
  if (!rel || rel.split("/").some((s) => s === ".." || s === ""))
    throw new Error(`--source path must be relative to ComfyUI input/, got "${rel}"`);
  const cut = rel.lastIndexOf("/");
  sourceOverrides.set(id, {
    subfolder: cut < 0 ? "" : rel.slice(0, cut),
    file: cut < 0 ? rel : rel.slice(cut + 1),
    ...(width && height ? { width, height } : {}),
    ...(seconds ? { seconds } : {}),
  });
}

/** Asset metadata with any --source override's size / seconds applied. */
export function smokeAssetMeta(id: SmokeAssetId): SmokeAsset {
  const o = sourceOverrides.get(id);
  const a: SmokeAsset = SMOKE_ASSETS[id];
  if (!o) return a;
  return {
    ...a,
    file: o.file,
    ...(o.width ? { width: o.width, height: o.height } : {}),
    ...(o.seconds ? { seconds: o.seconds } : {}),
  };
}

export function clearSmokeSourceOverrides(): void {
  sourceOverrides.clear();
}

/** Where a source lives under ComfyUI input/ (override or procedural asset). */
export function smokeAssetLocation(id: SmokeAssetId): { subfolder: string; file: string } {
  const o = sourceOverrides.get(id);
  return o ? { subfolder: o.subfolder, file: o.file } : { subfolder: SMOKE_SUBFOLDER, file: SMOKE_ASSETS[id].file };
}

export function smokeSourceOverrides(): Record<string, string> {
  return Object.fromEntries(
    [...sourceOverrides].map(([id, l]) => [id, l.subfolder ? `${l.subfolder}/${l.file}` : l.file]),
  );
}

export function smokeAssetRef(id: SmokeAssetId): string {
  const { subfolder, file } = smokeAssetLocation(id);
  return `${subfolder ? `${subfolder}/` : ""}${file} [input]`;
}

// PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode 8-bit RGB (3 channels) or RGBA (4) pixels as a PNG. */
export function encodePng(
  width: number,
  height: number,
  channels: 3 | 4,
  pixels: Uint8Array,
): Buffer {
  if (pixels.length !== width * height * channels)
    throw new Error("encodePng: pixel buffer size mismatch");
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(
      pixels.subarray(y * stride, (y + 1) * stride),
      y * (stride + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // colour type
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

type Rgb = [number, number, number];

/** Diagonal two-colour gradient with a soft disc ("a subject") in the middle. */
export function drawGradient(width: number, height: number, t = 0): Uint8Array {
  const px = new Uint8Array(width * height * 3);
  const cx = width * (0.35 + 0.3 * t);
  const cy = height * 0.55;
  const r = Math.min(width, height) * 0.22;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const g = (x / width + y / height) / 2;
      let c: Rgb = [
        Math.round(30 + 180 * g),
        Math.round(60 + 90 * (1 - g)),
        Math.round(140 + 100 * (1 - g)),
      ];
      const d = Math.hypot(x - cx, y - cy);
      if (d < r) {
        const k = Math.min(1, (r - d) / 4);
        const shade = 0.75 + 0.25 * (1 - d / r);
        const disc: Rgb = [235 * shade, 170 * shade, 60 * shade];
        c = c.map((v, i) => Math.round(v * (1 - k) + disc[i] * k)) as Rgb;
      }
      px.set(c, (y * width + x) * 3);
    }
  }
  return px;
}

/** Flat background with a rectangle, a triangle and a ring. */
export function drawShapes(width: number, height: number): Uint8Array {
  const px = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let c: Rgb = [228, 224, 214];
      const u = x / width;
      const v = y / height;
      if (u > 0.08 && u < 0.36 && v > 0.25 && v < 0.75) c = [40, 110, 200];
      // triangle: apex (0.5, 0.2), base y=0.8 between x 0.38 and 0.62
      if (v > 0.2 && v < 0.8) {
        const half = ((v - 0.2) / 0.6) * 0.12;
        if (Math.abs(u - 0.5) < half) c = [210, 70, 60];
      }
      const d = Math.hypot((u - 0.78) * width, (v - 0.5) * height);
      const ring = Math.min(width, height) * 0.2;
      if (d > ring * 0.65 && d < ring) c = [50, 160, 90];
      px.set(c, (y * width + x) * 3);
    }
  }
  return px;
}

/** Five-point star on a transparent background (RGBA). */
export function drawSticker(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const c = size / 2;
  const outer = size * 0.46;
  const inner = outer * 0.45;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? outer : inner;
    pts.push([c + rad * Math.cos(a), c + rad * Math.sin(a)]);
  }
  const inside = (x: number, y: number) => {
    let hit = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
        hit = !hit;
    }
    return hit;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inside(x + 0.5, y + 0.5)) continue;
      const o = (y * size + x) * 4;
      px[o] = 250;
      px[o + 1] = 205;
      px[o + 2] = 40;
      px[o + 3] = 255;
    }
  }
  return px;
}

// WAV

export const SMOKE_SAMPLE_RATE = 24000;

/**
 * Speech-like tone (16-bit mono PCM): a gliding 140-220 Hz fundamental with
 * formant-ish harmonics, chopped into ~4 syllables per second.
 */
export function synthToneSamples(seconds: number): Int16Array {
  const n = Math.round(seconds * SMOKE_SAMPLE_RATE);
  const out = new Int16Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SMOKE_SAMPLE_RATE;
    const f0 = 180 + 40 * Math.sin(2 * Math.PI * 0.7 * t);
    phase += (2 * Math.PI * f0) / SMOKE_SAMPLE_RATE;
    const syll = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 0.6;
    const fade = Math.min(1, t / 0.05, (seconds - t) / 0.05);
    const v =
      0.55 * Math.sin(phase) +
      0.25 * Math.sin(3 * phase) +
      0.12 * Math.sin(5 * phase);
    out[i] = Math.round(v * syll * Math.max(0, fade) * 0.6 * 32767);
  }
  return out;
}

export function encodeWav(samples: Int16Array, sampleRate: number): Buffer {
  const data = Buffer.from(
    samples.buffer,
    samples.byteOffset,
    samples.byteLength,
  );
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// Writer

/** Write every asset into `dir`; returns id -> absolute path. */
export function writeSmokeAssets(
  dir: string,
  opts: { ffmpeg?: string } = {},
): Record<SmokeAssetId, string> {
  fs.mkdirSync(dir, { recursive: true });
  const out = {} as Record<SmokeAssetId, string>;
  const at = (id: SmokeAssetId) =>
    (out[id] = path.join(dir, SMOKE_ASSETS[id].file));

  const g = SMOKE_ASSETS.gradient;
  fs.writeFileSync(
    at("gradient"),
    encodePng(g.width, g.height, 3, drawGradient(g.width, g.height)),
  );
  const s = SMOKE_ASSETS.shapes;
  fs.writeFileSync(
    at("shapes"),
    encodePng(s.width, s.height, 3, drawShapes(s.width, s.height)),
  );
  const st = SMOKE_ASSETS.sticker;
  fs.writeFileSync(
    at("sticker"),
    encodePng(st.width, st.height, 4, drawSticker(st.width)),
  );
  const tone = SMOKE_ASSETS.tone;
  fs.writeFileSync(
    at("tone"),
    encodeWav(synthToneSamples(tone.seconds), SMOKE_SAMPLE_RATE),
  );

  // Clip: the disc slides across the gradient; the tone is its soundtrack.
  const c = SMOKE_ASSETS.clip;
  const frames = c.seconds * c.fps;
  const raw = Buffer.alloc(c.width * c.height * 3 * frames);
  for (let f = 0; f < frames; f++) {
    raw.set(
      drawGradient(c.width, c.height, f / (frames - 1)),
      f * c.width * c.height * 3,
    );
  }
  const res = spawnSync(
    opts.ffmpeg ?? "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-s",
      `${c.width}x${c.height}`,
      "-r",
      String(c.fps),
      "-i",
      "pipe:0",
      "-i",
      out.tone,
      "-t",
      String(c.seconds),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      at("clip"),
    ],
    { input: raw, maxBuffer: 16 * 1024 * 1024 },
  );
  if (res.error || res.status !== 0) {
    throw new Error(
      `ffmpeg failed to write ${c.file}: ${res.error?.message ?? res.stderr?.toString().trim()}`,
    );
  }
  return out;
}
