/**
 * Judge mode policy (ADRIFT_JUDGE_MODE=1): a locked-down build of Adrift for
 * contest judges reached through a temporary tunnel. Edge-safe (no Node
 * imports): the middleware and the Node route guards share these rules.
 *
 * Layers:
 *  1. middleware.ts: judge token -> httpOnly cookie, every page except the
 *     judge studio and every API route not listed here -> 404.
 *  2. lib/auth.ts requireAdmin: in judge mode a request passes only with a
 *     valid judge cookie AND an allowlisted route (so a middleware bypass
 *     still cannot reach admin routes).
 *  3. lib/judge/judgeServer.ts withJudge(): per-route checks (action/tool
 *     allowlist, file/run ownership, upload type + size, quota, queue).
 *
 * In judge mode the admin key does NOT unlock anything: the judge instance is
 * judge-only. The owner keeps using the normal instance on its own port.
 */

export const JUDGE_COOKIE = "adrift_judge";
/** Query parameter carrying the token on the first visit. */
export const JUDGE_QUERY = "judge";
/** Cookie lifetime: covers the judging window (Oct 30 - Nov 6) with slack. */
export const JUDGE_COOKIE_MAX_AGE_S = 10 * 24 * 60 * 60;

export const DEFAULT_JUDGE_QUOTA = 15;
export const DEFAULT_JUDGE_UPLOAD_MB = 25;
/** A run holding the GPU slot longer than this is presumed dead. */
export const DEFAULT_JUDGE_LEASE_MS = 15 * 60 * 1000;

export function isJudgeMode(): boolean {
  const v = (process.env.ADRIFT_JUDGE_MODE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Tokens from ADRIFT_JUDGE_TOKENS (comma/space list). Short ones are ignored. */
export function judgeTokens(): string[] {
  return (process.env.ADRIFT_JUDGE_TOKENS ?? "")
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 16 && t.length <= 256);
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function judgeQuota(): number {
  return positiveInt(process.env.ADRIFT_JUDGE_RUN_QUOTA, DEFAULT_JUDGE_QUOTA);
}

export function judgeUploadMaxBytes(): number {
  return (
    positiveInt(process.env.ADRIFT_JUDGE_UPLOAD_MB, DEFAULT_JUDGE_UPLOAD_MB) *
    1024 *
    1024
  );
}

export function judgeLeaseMs(): number {
  return positiveInt(process.env.ADRIFT_JUDGE_LEASE_MS, DEFAULT_JUDGE_LEASE_MS);
}

// Tool allowlist

/** Tools-page card keys a judge sees (everything else is hidden). */
export const JUDGE_CARD_KEYS: readonly string[] = [
  // LTX VFX (the "VFX Workflow Built with LTX" bonus)
  "action:ltx_alpha_matte",
  "action:ltx_clean_plate",
  "action:ltx_day_to_night",
  "action:ltx_add_water",
  "action:ltx_cinemagraph",
  "action:ltx_slow_motion",
  // LTX pipelines
  "action:ltx25_animate",
  "action:ltx25_transition",
  "action:video_expand",
  // Click to Ad
  "special:click_to_ad",
  // A few image tools
  "catalog:krea2-general-edit",
  "action:edit_flux3",
  "action:edit_qwen21",
  "action:upscale",
  "action:bg_remove",
];

/**
 * POST /api/jobs/action names a judge may queue, with their quota cost.
 * Cost 0 = light helper steps of the Click to Ad pipeline (LLM script,
 * TTS, ffmpeg assembly): they still wait for the single GPU slot.
 */
export const JUDGE_ACTION_COSTS: Readonly<Record<string, number>> = {
  ltx_alpha_matte: 1,
  ltx_clean_plate: 1,
  ltx_day_to_night: 1,
  ltx_add_water: 1,
  ltx_cinemagraph: 1,
  ltx_slow_motion: 1,
  ltx25_animate: 1,
  ltx25_transition: 1,
  video_expand: 1,
  edit_flux3: 1,
  edit_qwen21: 1,
  upscale: 1,
  bg_remove: 1,
  // Click to Ad steps
  pipeline_script: 0,
  voiceover: 0,
  pipeline_assemble: 0,
  music: 1,
  animate_low: 1,
  animate_high: 1,
  talking_avatar: 1,
};

/** POST /api/jobs/tool catalog ids (Click to Ad's default edit engine). */
export const JUDGE_CATALOG_TOOLS: Readonly<Record<string, number>> = {
  "krea2-general-edit": 1,
};

export function judgeActionCost(action: unknown): number | null {
  if (typeof action !== "string") return null;
  return Object.prototype.hasOwnProperty.call(JUDGE_ACTION_COSTS, action)
    ? JUDGE_ACTION_COSTS[action]
    : null;
}

export function judgeToolCost(toolId: unknown): number | null {
  if (typeof toolId !== "string") return null;
  return Object.prototype.hasOwnProperty.call(JUDGE_CATALOG_TOOLS, toolId)
    ? JUDGE_CATALOG_TOOLS[toolId]
    : null;
}

// Route allowlist

/**
 * What withJudge() does for the route. "open" = static catalog data with no
 * per-user content (no wrapper needed).
 */
export type JudgeRouteKind =
  | "open"
  | "status"
  | "upload"
  | "seed"
  | "action"
  | "tool"
  | "cancel"
  | "history"
  | "image";

interface RouteRule {
  method: string;
  /** Exact path, or a prefix ending in "/" for one dynamic segment. */
  path: string;
  kind: JudgeRouteKind;
}

const ROUTES: readonly RouteRule[] = [
  { method: "GET", path: "/api/health", kind: "open" },
  { method: "GET", path: "/api/tools", kind: "open" },
  { method: "GET", path: "/api/tools/model-status", kind: "open" },
  { method: "GET", path: "/api/oj/packs", kind: "open" },
  { method: "GET", path: "/api/krea2-edit-loras", kind: "open" },
  { method: "GET", path: "/api/judge/status", kind: "status" },
  { method: "POST", path: "/api/comfy/upload", kind: "upload" },
  { method: "POST", path: "/api/jobs/seed-run", kind: "seed" },
  { method: "POST", path: "/api/jobs/action", kind: "action" },
  { method: "POST", path: "/api/jobs/tool", kind: "tool" },
  { method: "POST", path: "/api/jobs/cancel", kind: "cancel" },
  { method: "GET", path: "/api/comfy/history/", kind: "history" },
  { method: "GET", path: "/api/comfy/image", kind: "image" },
];

/** The rule for an API request in judge mode, or null (-> 404). */
export function judgeRouteKind(
  pathname: string,
  method: string,
): JudgeRouteKind | null {
  const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p.includes("..") || p.includes("//") || p.includes("%")) return null;
  for (const r of ROUTES) {
    if (r.method !== m) continue;
    if (r.path.endsWith("/")) {
      const rest = p.startsWith(r.path) ? p.slice(r.path.length) : "";
      if (rest && !rest.includes("/")) return r.kind;
    } else if (p === r.path) {
      return r.kind;
    }
  }
  return null;
}

/** Page paths rewritten to the judge studio. */
const STUDIO_PATHS = new Set(["/", "/judge"]);

/** Public files a judge page may load (all tracked, shipped assets). */
const ASSET_EXACT = new Set([
  "/favicon.ico",
  "/favicon-32.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/adrift-icon.svg",
  "/adrift-mark.svg",
  "/manifest.webmanifest",
]);
const ASSET_PREFIXES = ["/_next/", "/tool-previews/"];

export type JudgePageDecision = "studio" | "asset" | "deny";

export function judgePageDecision(pathname: string): JudgePageDecision {
  if (pathname.includes("..") || pathname.includes("//")) return "deny";
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (STUDIO_PATHS.has(p)) return "studio";
  if (ASSET_EXACT.has(p)) return "asset";
  if (ASSET_PREFIXES.some((pre) => p.startsWith(pre))) return "asset";
  return "deny";
}

// Tokens (Edge: Web Crypto, constant-time over fixed-length digests)

async function sha256Bytes(text: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return new Uint8Array(buf);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Edge-runtime token check (node:crypto timingSafeEqual is not available in
 * middleware). Compares SHA-256 digests so token length never leaks, and
 * checks every configured token (no early exit).
 */
export async function isJudgeTokenEdge(candidate: string): Promise<boolean> {
  if (!candidate || candidate.length > 256) return false;
  const tokens = judgeTokens();
  if (tokens.length === 0) return false;
  const want = await sha256Bytes(candidate);
  let ok = false;
  for (const t of tokens) {
    if (bytesEqual(want, await sha256Bytes(t))) ok = true;
  }
  return ok;
}

/** One cookie value from a raw Cookie header. */
export function cookieValue(header: string | null, name: string): string {
  for (const part of (header ?? "").split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

// File references in request bodies

const ANNOTATED_RE = /^(.+?) \[(input|output|temp)\]$/;
const MEDIA_EXT =
  "png|jpe?g|webp|gif|bmp|tiff?|exr|mp4|webm|mov|m4v|mkv|avi|wav|mp3|flac|m4a|ogg|opus|safetensors|ckpt|pt|pth|bin|gguf|json|glb|gltf|obj|ply|usdz|txt|latent";
const BARE_FILE_RE = new RegExp(
  `^[\\w.\\-() ]+(?:/[\\w.\\-() ]+)*\\.(?:${MEDIA_EXT})$`,
  "i",
);

/** Ownership key of a ComfyUI file: "<type>/<subfolder/>name". */
export function fileKey(type: string, subfolder: string, filename: string) {
  const sub = subfolder.replace(/^\/+|\/+$/g, "");
  return `${type}/${sub ? `${sub}/` : ""}${filename}`;
}

/** Key for an annotated ref "sub/name.png [input]" (null if not one). */
export function fileKeyFromRef(ref: string): string | null {
  const m = ANNOTATED_RE.exec(ref.trim());
  if (!m) return null;
  const rel = m[1].replace(/^\/+/, "");
  const cut = rel.lastIndexOf("/");
  return cut < 0
    ? fileKey(m[2], "", rel)
    : fileKey(m[2], rel.slice(0, cut), rel.slice(cut + 1));
}

/** Key for a /api/comfy/image?… or ComfyUI /view?… URL (null if not one). */
export function fileKeyFromViewUrl(value: string): string | null {
  if (!/\/(?:api\/comfy\/image|view)\?/.test(value)) return null;
  try {
    const url = new URL(value, "http://judge.invalid");
    const filename = url.searchParams.get("filename");
    if (!filename) return null;
    return fileKey(
      url.searchParams.get("type") || "output",
      url.searchParams.get("subfolder") || "",
      filename,
    );
  } catch {
    return null;
  }
}

export interface BodyRefs {
  /** ComfyUI files the body points at (ownership keys). */
  files: string[];
  runIds: string[];
  promptIds: string[];
}

/** Body keys whose string value can never be a file ref. */
const TEXT_KEYS = new Set(["prompt", "negative", "text", "script", "topic"]);

/**
 * Every file / run / prompt reference in a JSON body. Annotated refs, view
 * URLs and bare media filenames all count as files: a judge may only point a
 * job at files they uploaded or that their own runs produced.
 */
export function collectBodyRefs(body: unknown): BodyRefs {
  const out: BodyRefs = { files: [], runIds: [], promptIds: [] };
  const walk = (value: unknown, key: string, depth: number) => {
    if (depth > 12) return;
    if (typeof value === "string") {
      if (key === "run_id" || key === "runId") {
        out.runIds.push(value);
        return;
      }
      if (key === "prompt_id" || key === "promptId") {
        out.promptIds.push(value);
        return;
      }
      const s = value.trim();
      if (!s || s.startsWith("data:")) return;
      const annotated = fileKeyFromRef(s);
      if (annotated) {
        out.files.push(annotated);
        return;
      }
      const viewed = fileKeyFromViewUrl(s);
      if (viewed) {
        out.files.push(viewed);
        return;
      }
      if (!TEXT_KEYS.has(key) && s.length <= 255 && BARE_FILE_RE.test(s)) {
        const rel = s.replace(/^\/+/, "");
        const cut = rel.lastIndexOf("/");
        out.files.push(
          cut < 0
            ? fileKey("input", "", rel)
            : fileKey("input", rel.slice(0, cut), rel.slice(cut + 1)),
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v, key, depth + 1);
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        walk(v, k, depth + 1);
    }
  };
  walk(body, "", 0);
  return out;
}

// Upload sniffing

export type UploadKind = "image" | "video" | "audio";

const MIME_KINDS: Readonly<Record<string, UploadKind>> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/jpg": "image",
  "image/webp": "image",
  "video/mp4": "video",
  "video/quicktime": "video",
  "video/webm": "video",
  "video/x-m4v": "video",
  "audio/wav": "audio",
  "audio/x-wav": "audio",
  "audio/wave": "audio",
  "audio/mpeg": "audio",
  "audio/mp3": "audio",
  "audio/mp4": "audio",
  "audio/x-m4a": "audio",
  "audio/flac": "audio",
  "audio/x-flac": "audio",
};

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let s = "";
  for (let i = from; i < Math.min(to, bytes.length); i++)
    s += String.fromCharCode(bytes[i]);
  return s;
}

/** What the file really is, from its first bytes (null = not allowed). */
export function sniffUpload(head: Uint8Array): UploadKind | null {
  const b = head;
  if (b.length < 12) return null;
  if (b[0] === 0x89 && ascii(b, 1, 4) === "PNG") return "image";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WAVE") return "audio";
  if (ascii(b, 4, 8) === "ftyp") {
    const brand = ascii(b, 8, 12);
    return brand.startsWith("M4A") ? "audio" : "video";
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
    return "video";
  if (ascii(b, 0, 4) === "fLaC") return "audio";
  if (ascii(b, 0, 3) === "ID3") return "audio";
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "audio";
  return null;
}

/**
 * Checks a data: URL upload: declared MIME in the allowlist, decoded size
 * under the cap, and the magic bytes agree with the declared kind.
 */
export function checkJudgeUpload(
  dataUrl: unknown,
  maxBytes: number,
):
  | { ok: true; kind: UploadKind }
  | { ok: false; error: string; status: number } {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:"))
    return { ok: false, error: "Upload must be a data: URL.", status: 400 };
  const comma = dataUrl.indexOf(",");
  const header = dataUrl.slice(5, comma < 0 ? 0 : comma).toLowerCase();
  const mime = header.split(";")[0].trim();
  const kind = MIME_KINDS[mime];
  if (!kind || !header.includes(";base64"))
    return {
      ok: false,
      error:
        "Only PNG, JPEG, WebP, MP4, MOV, WebM, WAV, MP3, M4A or FLAC uploads.",
      status: 415,
    };
  const b64 = dataUrl.slice(comma + 1);
  const approxBytes = Math.floor((b64.length * 3) / 4);
  if (approxBytes > maxBytes)
    return {
      ok: false,
      error: `Uploads are limited to ${Math.round(maxBytes / (1024 * 1024))} MB in this preview.`,
      status: 413,
    };
  let head: Uint8Array;
  try {
    const bin = atob(b64.slice(0, 64).replace(/[^A-Za-z0-9+/]/g, ""));
    head = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return { ok: false, error: "Upload is not valid base64.", status: 400 };
  }
  const real = sniffUpload(head);
  if (real !== kind)
    return {
      ok: false,
      error: "The file's contents don't match its type.",
      status: 415,
    };
  return { ok: true, kind };
}
