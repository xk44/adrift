/**
 * Opt-in "master file" outputs (VFX formats) and consistent download names.
 *
 * The normal save nodes stay as they are (8-bit PNG / H.264 previews feed the
 * gallery). When the user picks a master format, a parallel save node is
 * added next to each image/video saver:
 *
 *   png16       SaveImageAdvanced  format=png, bit_depth=16-bit
 *   exr         SaveImageAdvanced  format=exr, bit_depth=16-bit float (sRGB in)
 *   prores4444  VHS_VideoCombine   format=video/ProRes, profile=4444
 *
 * Each option is only offered when the backend's /object_info has the node
 * and the option (detectMasterFormats). Master files are written under the
 * `adrift_master/` subfolder and tagged `_meta.adrift_master`, so
 * extractOutputs reports them as plain downloads ("Other outputs") instead of
 * gallery media.
 *
 * Pure and client-safe: no Node or server imports.
 */

import type { Workflow, WorkflowNode } from "@/types";

export type ImageMasterFormat = "png" | "png16" | "exr";
export type VideoMasterFormat = "h264" | "prores4444";

export interface MasterChoice {
  image?: ImageMasterFormat;
  video?: VideoMasterFormat;
}

export interface MasterAvailability {
  image: ImageMasterFormat[];
  video: VideoMasterFormat[];
}

/** Subfolder every master file is written to (also how outputs spot them). */
export const MASTER_SUBFOLDER = "adrift_master";
/**
 * Subfolder of internal sidecar files a tool saves for a later run (e.g. the
 * Extend video lossless tail PNGs). Nodes writing there are tagged
 * `_meta.adrift_sidecar`; extractOutputs drops their files entirely.
 */
export const SIDECAR_SUBFOLDER = "adrift_ctx";
/** One prefix for every downloaded file. */
export const DOWNLOAD_PREFIX = "Adrift_";

export const IMAGE_MASTER_LABELS: Record<ImageMasterFormat, string> = {
  png: "PNG (8-bit)",
  png16: "PNG 16-bit",
  exr: "EXR (16-bit float)",
};
export const VIDEO_MASTER_LABELS: Record<VideoMasterFormat, string> = {
  h264: "H.264 MP4",
  prores4444: "ProRes 4444 (.mov)",
};

const IMAGE_FORMATS: readonly ImageMasterFormat[] = ["png", "png16", "exr"];
const VIDEO_FORMATS: readonly VideoMasterFormat[] = ["h264", "prores4444"];

export function isImageMasterFormat(v: unknown): v is ImageMasterFormat {
  return typeof v === "string" && (IMAGE_FORMATS as string[]).includes(v);
}
export function isVideoMasterFormat(v: unknown): v is VideoMasterFormat {
  return typeof v === "string" && (VIDEO_FORMATS as string[]).includes(v);
}

/** Parse a request value like `{ image: "exr", video: "prores4444" }`. */
export function parseMasterChoice(raw: unknown): MasterChoice | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const choice: MasterChoice = {};
  if (isImageMasterFormat(r.image) && r.image !== "png") choice.image = r.image;
  if (isVideoMasterFormat(r.video) && r.video !== "h264")
    choice.video = r.video;
  return choice.image || choice.video ? choice : null;
}

/** Cookie form ("image:exr,video:prores4444"), so plain fetches carry it. */
export const MASTER_COOKIE = "adrift_master";

export function encodeMasterCookie(choice: MasterChoice): string {
  const parts: string[] = [];
  if (choice.image && choice.image !== "png")
    parts.push(`image:${choice.image}`);
  if (choice.video && choice.video !== "h264")
    parts.push(`video:${choice.video}`);
  return parts.join(",");
}

export function decodeMasterCookie(
  value: string | undefined | null,
): MasterChoice | null {
  if (!value) return null;
  let text: string;
  try {
    text = decodeURIComponent(value);
  } catch {
    return null; // malformed cookie: ignore it rather than fail the job
  }
  const raw: Record<string, string> = {};
  for (const part of text.split(",")) {
    const [k, v] = part.split(":");
    if (k && v) raw[k.trim()] = v.trim();
  }
  return parseMasterChoice(raw);
}

/** Read the master cookie out of a raw Cookie header. */
export function masterChoiceFromCookieHeader(
  header: string | null | undefined,
): MasterChoice | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === MASTER_COOKIE) {
      return decodeMasterCookie(part.slice(eq + 1).trim());
    }
  }
  return null;
}

// Detection

type Spec = unknown[];

function inputSpec(
  info: Record<string, unknown>,
  cls: string,
  name: string,
): Spec | null {
  const node = info[cls] as
    | {
        input?: {
          required?: Record<string, unknown>;
          optional?: Record<string, unknown>;
        };
      }
    | undefined;
  const spec = node?.input?.required?.[name] ?? node?.input?.optional?.[name];
  return Array.isArray(spec) ? spec : null;
}

/** Sub-input options of one key of a COMFY_DYNAMICCOMBO_V3 input. */
function dynamicOption(
  spec: Spec | null,
  key: string,
): Record<string, unknown> | null {
  if (!spec || spec[0] !== "COMFY_DYNAMICCOMBO_V3") return null;
  const opts = (spec[1] as { options?: unknown } | undefined)?.options;
  if (!Array.isArray(opts)) return null;
  const hit = opts.find(
    (o) => !!o && typeof o === "object" && (o as { key?: unknown }).key === key,
  ) as { inputs?: { required?: Record<string, unknown> } } | undefined;
  return hit?.inputs?.required ?? (hit ? {} : null);
}

function comboHas(spec: unknown, value: string): boolean {
  if (!Array.isArray(spec)) return false;
  if (Array.isArray(spec[0])) return (spec[0] as unknown[]).includes(value);
  const opts = (spec[1] as { options?: unknown } | undefined)?.options;
  return Array.isArray(opts) && opts.includes(value);
}

function supportsPng16(info: Record<string, unknown>): boolean {
  const png = dynamicOption(
    inputSpec(info, "SaveImageAdvanced", "format"),
    "png",
  );
  return !!png && comboHas(png.bit_depth, "16-bit");
}

function supportsExr(info: Record<string, unknown>): boolean {
  const exr = dynamicOption(
    inputSpec(info, "SaveImageAdvanced", "format"),
    "exr",
  );
  return !!exr && comboHas(exr.bit_depth, "16-bit float");
}

function supportsProRes4444(info: Record<string, unknown>): boolean {
  const spec = inputSpec(info, "VHS_VideoCombine", "format");
  if (!spec || !comboHas(spec, "video/ProRes")) return false;
  const formats = (spec[1] as { formats?: Record<string, unknown> } | undefined)
    ?.formats;
  const prores = formats?.["video/ProRes"];
  if (!Array.isArray(prores)) return false;
  return prores.some(
    (w) =>
      Array.isArray(w) &&
      w[0] === "profile" &&
      Array.isArray(w[1]) &&
      w[1].includes("4444"),
  );
}

/** Which master formats this backend can write (defaults always listed). */
export function detectMasterFormats(
  info: Record<string, unknown> | null | undefined,
): MasterAvailability {
  const image: ImageMasterFormat[] = ["png"];
  const video: VideoMasterFormat[] = ["h264"];
  if (info) {
    if (supportsPng16(info)) image.push("png16");
    if (supportsExr(info)) image.push("exr");
    if (supportsProRes4444(info)) video.push("prores4444");
  }
  return { image, video };
}

/** Drop choices the backend can't honour. */
export function supportedChoice(
  choice: MasterChoice | null | undefined,
  available: MasterAvailability,
): MasterChoice | null {
  if (!choice) return null;
  const out: MasterChoice = {};
  if (
    choice.image &&
    choice.image !== "png" &&
    available.image.includes(choice.image)
  )
    out.image = choice.image;
  if (
    choice.video &&
    choice.video !== "h264" &&
    available.video.includes(choice.video)
  )
    out.video = choice.video;
  return out.image || out.video ? out : null;
}

// Graph rewrite

/** File-name-safe token ("Color grade" -> "color-grade"). */
export function nameToken(value: unknown, fallback: string): string {
  const s = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || fallback;
}

export interface MasterContext {
  /** Tool / action id ("upscale", "color_grade"); "create" for plain runs. */
  tool?: string;
  seed?: number | string | null;
}

function masterPrefix(ctx: MasterContext): string {
  const seed =
    ctx.seed === undefined || ctx.seed === null || ctx.seed === ""
      ? "0"
      : nameToken(ctx.seed, "0");
  return `${MASTER_SUBFOLDER}/${DOWNLOAD_PREFIX}${nameToken(ctx.tool, "create")}_${seed}_master`;
}

function isLink(v: unknown): v is [string, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === "string" &&
    typeof v[1] === "number"
  );
}

function nextIdFactory(graph: Workflow): () => string {
  let n = 0;
  for (const id of Object.keys(graph)) {
    const k = Number(id);
    if (Number.isInteger(k) && k > n) n = k;
  }
  let next = Math.max(n + 1, 9000);
  return () => {
    while (graph[String(next)]) next++;
    return String(next++);
  };
}

export function isMasterNode(
  node: { _meta?: unknown } | undefined | null,
): boolean {
  const meta = node?._meta as { adrift_master?: unknown } | undefined;
  return meta?.adrift_master === true;
}

export function isSidecarNode(
  node: { _meta?: unknown } | undefined | null,
): boolean {
  const meta = node?._meta as { adrift_sidecar?: unknown } | undefined;
  return meta?.adrift_sidecar === true;
}

export function isSidecarSubfolder(
  subfolder: string | undefined | null,
): boolean {
  return !!subfolder && subfolder.split("/").includes(SIDECAR_SUBFOLDER);
}

const IMAGE_SAVERS = new Set(["SaveImage"]);
const VHS_SAVERS = new Set(["VHS_VideoCombine"]);
const VIDEO_SAVERS = new Set(["SaveVideo"]);

/**
 * Return a copy of `graph` with a master save node beside every image / video
 * saver. Returns the original graph untouched when nothing applies.
 */
export function addMasterOutputs(
  graph: Workflow,
  choice: MasterChoice | null | undefined,
  ctx: MasterContext = {},
): { graph: Workflow; added: string[] } {
  if (!choice || (!choice.image && !choice.video)) return { graph, added: [] };
  // Packs that write their own masters (HDR tools) are not mirrored again.
  if (Object.values(graph).some(isMasterNode)) return { graph, added: [] };
  const out = JSON.parse(JSON.stringify(graph)) as Workflow;
  const newId = nextIdFactory(out);
  const prefix = masterPrefix(ctx);
  const added: string[] = [];
  const meta = (title: string) =>
    ({ title, adrift_master: true }) as unknown as WorkflowNode["_meta"];

  for (const [id, node] of Object.entries(graph)) {
    if (!node || isMasterNode(node) || isSidecarNode(node)) continue;
    const inputs = node.inputs ?? {};

    if (
      choice.image &&
      IMAGE_SAVERS.has(node.class_type) &&
      isLink(inputs.images)
    ) {
      const mid = newId();
      const formatInputs =
        choice.image === "exr"
          ? {
              format: "exr",
              "format.bit_depth": "16-bit float",
              "format.input_color_space": "sRGB",
            }
          : {
              format: "png",
              "format.bit_depth": "16-bit",
              "format.input_color_space": "sRGB",
            };
      out[mid] = {
        class_type: "SaveImageAdvanced",
        inputs: {
          images: inputs.images,
          filename_prefix: prefix,
          ...formatInputs,
        },
        _meta: meta(
          choice.image === "exr"
            ? "Master file (EXR)"
            : "Master file (PNG 16-bit)",
        ),
      };
      added.push(mid);
      continue;
    }

    if (
      choice.video === "prores4444" &&
      VHS_SAVERS.has(node.class_type) &&
      isLink(inputs.images)
    ) {
      // VHS "video/16bit-png" etc. are not videos users download; only mirror
      // real video encodes.
      const fmt = String(inputs.format ?? "");
      if (!fmt.startsWith("video/") || fmt.includes("png")) continue;
      const mid = newId();
      out[mid] = {
        class_type: "VHS_VideoCombine",
        inputs: {
          images: inputs.images,
          frame_rate: inputs.frame_rate ?? 24,
          loop_count: 0,
          filename_prefix: prefix,
          format: "video/ProRes",
          profile: "4444",
          pingpong: false,
          save_output: true,
          ...(inputs.audio !== undefined ? { audio: inputs.audio } : {}),
        },
        _meta: meta("Master file (ProRes 4444)"),
      };
      added.push(mid);
      continue;
    }

    if (
      choice.video === "prores4444" &&
      VIDEO_SAVERS.has(node.class_type) &&
      isLink(inputs.video)
    ) {
      const parts = newId();
      out[parts] = {
        class_type: "GetVideoComponents",
        inputs: { video: inputs.video },
        _meta: meta("Master file frames"),
      };
      const mid = newId();
      out[mid] = {
        class_type: "VHS_VideoCombine",
        inputs: {
          images: [parts, 0],
          audio: [parts, 1],
          frame_rate: [parts, 2],
          loop_count: 0,
          filename_prefix: prefix,
          format: "video/ProRes",
          profile: "4444",
          pingpong: false,
          save_output: true,
        },
        _meta: meta("Master file (ProRes 4444)"),
      };
      added.push(parts, mid);
    }
  }
  return added.length ? { graph: out, added } : { graph, added: [] };
}

/** True for a master-file view (subfolder `adrift_master`, any nesting). */
export function isMasterSubfolder(
  subfolder: string | undefined | null,
): boolean {
  return !!subfolder && subfolder.split("/").includes(MASTER_SUBFOLDER);
}

// Download names

/** Tool id from a run's params (action provenance first, then tool_id). */
export function toolFromParams(
  params: Record<string, unknown> | null | undefined,
): string {
  const prov = params?.action_provenance as
    { via?: unknown; id?: unknown } | undefined;
  const raw =
    (prov && typeof prov === "object" && (prov.via || prov.id)) ||
    params?.tool_id ||
    params?.action ||
    "create";
  return nameToken(raw, "create");
}

/** Extension of a URL / filename (query-safe), lowercase, no dot. */
export function extFromUrl(
  url: string | undefined | null,
  fallback: string,
): string {
  if (!url) return fallback;
  let path = url;
  try {
    const u = new URL(url, "http://x");
    path = u.searchParams.get("filename") ?? u.pathname;
  } catch {
    /* keep raw */
  }
  const m = path.match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : fallback;
}

/** `Adrift_<tool>_<seed>_v<N>.<ext>` */
export function downloadName(opts: {
  tool?: string | null;
  seed?: number | string | null;
  version?: number | null;
  ext: string;
}): string {
  const tool = nameToken(opts.tool, "create");
  const seed =
    opts.seed === undefined || opts.seed === null || opts.seed === ""
      ? "0"
      : nameToken(opts.seed, "0");
  const v =
    Number.isFinite(opts.version) && (opts.version as number) > 0
      ? Math.floor(opts.version as number)
      : 1;
  const ext = opts.ext.replace(/^\./, "").toLowerCase() || "bin";
  return `${DOWNLOAD_PREFIX}${tool}_${seed}_v${v}.${ext}`;
}
