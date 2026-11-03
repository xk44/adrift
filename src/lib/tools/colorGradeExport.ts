/**
 * Provenance for Color Grade exports: a JSON sidecar with the look and every
 * slider value, the same JSON embedded in the PNG as an "adrift" tEXt chunk,
 * and the shared Adrift_<tool>_<seed>_v<N> download names.
 * Pure (no DOM) so it can be unit-tested.
 */
import { downloadName } from "@/lib/output/saveNodes";
import { GRADE_PRESETS, type GradeSettings } from "./colorGrade";

export const GRADE_TOOL_ID = "color_grade";
export const GRADE_SIDECAR_KIND = "adrift.color_grade";
/** PNG tEXt keyword the grade JSON is stored under. */
export const GRADE_PNG_KEY = "adrift";

export interface GradeSidecar {
  kind: typeof GRADE_SIDECAR_KIND;
  version: 1;
  tool: typeof GRADE_TOOL_ID;
  /** Look id ("" = custom sliders). */
  preset: string;
  presetLabel: string | null;
  settings: GradeSettings;
  width: number;
  height: number;
  /** Source label (file name / gallery prompt); never a data URL. */
  source: string | null;
  created: string;
}

export function gradeSidecar(opts: {
  preset: string;
  settings: GradeSettings;
  width: number;
  height: number;
  source?: string | null;
  now?: Date;
}): GradeSidecar {
  const source =
    typeof opts.source === "string" &&
    opts.source.trim() &&
    !/^(data|blob):/i.test(opts.source)
      ? opts.source.trim().slice(0, 200)
      : null;
  return {
    kind: GRADE_SIDECAR_KIND,
    version: 1,
    tool: GRADE_TOOL_ID,
    preset: opts.preset,
    presetLabel: GRADE_PRESETS.find((p) => p.id === opts.preset)?.label ?? null,
    settings: { ...opts.settings },
    width: opts.width,
    height: opts.height,
    source,
    created: (opts.now ?? new Date()).toISOString(),
  };
}

/** Image + sidecar names; the stamp stands in for a seed (no model run). */
export function gradeExportNames(stamp: number): { png: string; json: string } {
  const png = downloadName({ tool: GRADE_TOOL_ID, seed: stamp, ext: "png" });
  return { png, json: png.replace(/\.png$/, ".grade.json") };
}

/** JSON with every non-ASCII char escaped (safe for a Latin-1 tEXt chunk). */
export function asciiJson(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

let CRC_TABLE: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Insert a tEXt chunk (keyword, ASCII text) right after IHDR. Returns the
 * input unchanged when it is not a PNG.
 */
export function addPngTextChunk(
  png: Uint8Array,
  keyword: string,
  text: string,
): Uint8Array {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.length < 33 || sig.some((b, i) => png[i] !== b)) return png;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const ihdrEnd = 8 + 12 + view.getUint32(8);
  const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
  const data = new Uint8Array([...enc(keyword), 0, ...enc(text)]);
  const chunk = new Uint8Array(12 + data.length);
  const cv = new DataView(chunk.buffer);
  cv.setUint32(0, data.length);
  chunk.set(enc("tEXt"), 4);
  chunk.set(data, 8);
  cv.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, ihdrEnd), 0);
  out.set(chunk, ihdrEnd);
  out.set(png.subarray(ihdrEnd), ihdrEnd + chunk.length);
  return out;
}
