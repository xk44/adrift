/**
 * Hugging Face Hub model search — enums, request validation and result
 * mapping for the read-only /api/hf/models proxy (GET
 * https://huggingface.co/api/models, no token).
 *
 * Every param is whitelisted here; the route never forwards raw client
 * input. Pagination is the Hub's opaque `cursor` from the `Link: rel="next"`
 * header.
 */

export const HF_API_ORIGIN = "https://huggingface.co";

export const HF_SORTS = [
  "trendingScore",
  "downloads",
  "likes",
  "lastModified",
  "createdAt",
] as const;
export type HfSort = (typeof HF_SORTS)[number];

export const HF_SORT_LABELS: Record<HfSort, string> = {
  trendingScore: "Trending",
  downloads: "Most Downloaded",
  likes: "Most Liked",
  lastModified: "Recently Updated",
  createdAt: "Newest",
};

export const HF_TASKS = [
  "text-to-image",
  "image-to-image",
  "image-to-video",
  "text-to-video",
  "image-text-to-text",
  "unconditional-image-generation",
  "image-to-3d",
  "text-to-3d",
  "text-to-speech",
  "text-to-audio",
  "depth-estimation",
  "image-segmentation",
  "image-classification",
  "text-generation",
  "any-to-any",
  // Not a Hub pipeline: sent as the `super-resolution` tag filter.
  "super-resolution",
] as const;
export type HfTask = (typeof HF_TASKS)[number];

/** Tasks the Hub knows as tags, not `pipeline_tag` values. */
const TAG_TASKS = new Set<string>(["super-resolution"]);

export function hfTaskLabel(task: string): string {
  if (task === "super-resolution") return "Upscalers (super-resolution)";
  return task
    .split("-")
    .map((part) => (part === "to" ? "→" : part))
    .join(" ")
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\b3d\b/i, "3D");
}

/** Hub `library_name` values worth filtering on for this app. */
export const HF_LIBRARIES = [
  "diffusers",
  "transformers",
  "safetensors",
  "gguf",
  "mlx",
  "onnx",
  "peft",
  "timm",
] as const;
export type HfLibrary = (typeof HF_LIBRARIES)[number];

const SORT_SET = new Set<string>(HF_SORTS);
const TASK_SET = new Set<string>(HF_TASKS);
const LIB_SET = new Set<string>(HF_LIBRARIES);

export const isHfSort = (v: unknown): v is HfSort =>
  typeof v === "string" && SORT_SET.has(v);
export const isHfTask = (v: unknown): v is HfTask =>
  typeof v === "string" && TASK_SET.has(v);
export const isHfLibrary = (v: unknown): v is HfLibrary =>
  typeof v === "string" && LIB_SET.has(v);

/** `filter` values the proxy accepts: libraries + the `lora` tag. */
const FILTER_SET = new Set<string>([...HF_LIBRARIES, "lora"]);

/** Hub user/org names. */
export const HF_AUTHOR_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
/** Hub cursors are base64 JSON (url-encoded `=` already decoded by URL). */
export const HF_CURSOR_RE = /^[A-Za-z0-9+/=_-]{1,1024}$/;

export const HF_DEFAULT_LIMIT = 24;
export const HF_MAX_LIMIT = 100;
const HF_MAX_SEARCH = 128;

export type HfParseResult =
  { ok: true; upstream: URLSearchParams } | { ok: false; error: string };

/**
 * Validate the proxy's query string and build the upstream Hub query.
 * Unknown keys are ignored; known keys with bad values are rejected.
 */
export function parseHfModelsRequest(sp: URLSearchParams): HfParseResult {
  const upstream = new URLSearchParams();

  const rawSearch = sp.get("search");
  if (rawSearch !== null) {
    // eslint-disable-next-line no-control-regex
    const search = rawSearch.replace(/[\x00-\x1F\x7F]/g, "").trim();
    if (search.length > HF_MAX_SEARCH) {
      return { ok: false, error: `search must be ≤ ${HF_MAX_SEARCH} chars` };
    }
    if (search) upstream.set("search", search);
  }

  const sort = sp.get("sort") ?? "trendingScore";
  if (!isHfSort(sort)) {
    return { ok: false, error: `sort must be one of ${HF_SORTS.join(", ")}` };
  }
  upstream.set("sort", sort);
  upstream.set("direction", "-1");

  const task = sp.get("pipeline_tag");
  if (task !== null && task !== "") {
    if (!isHfTask(task)) return { ok: false, error: "invalid pipeline_tag" };
    if (TAG_TASKS.has(task)) upstream.append("filter", task);
    else upstream.set("pipeline_tag", task);
  }

  const filters = sp.getAll("filter").filter((f) => f !== "");
  if (filters.length > 4) return { ok: false, error: "too many filters" };
  for (const f of new Set(filters)) {
    if (!FILTER_SET.has(f)) return { ok: false, error: `invalid filter: ${f}` };
    upstream.append("filter", f);
  }

  const author = sp.get("author");
  if (author !== null && author !== "") {
    if (!HF_AUTHOR_RE.test(author))
      return { ok: false, error: "invalid author" };
    upstream.set("author", author);
  }

  const rawLimit = sp.get("limit");
  let limit = HF_DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > HF_MAX_LIMIT) {
      return { ok: false, error: `limit must be 1-${HF_MAX_LIMIT}` };
    }
    limit = n;
  }
  upstream.set("limit", String(limit));

  const cursor = sp.get("cursor");
  if (cursor !== null && cursor !== "") {
    if (!HF_CURSOR_RE.test(cursor))
      return { ok: false, error: "invalid cursor" };
    upstream.set("cursor", cursor);
  }

  // full=true adds `siblings` (file names) for the Explore compat chip / quant badge.
  upstream.set("full", "true");
  return { ok: true, upstream };
}

export function hfModelsUpstreamUrl(upstream: URLSearchParams): string {
  return `${HF_API_ORIGIN}/api/models?${upstream.toString()}`;
}

/**
 * Pull the next-page cursor out of a Hub `Link` header. Only trusts a
 * rel="next" link that points back at huggingface.co.
 */
export function parseHfNextCursor(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (!m) continue;
    try {
      const u = new URL(m[1]);
      if (u.protocol !== "https:" || u.hostname !== "huggingface.co")
        return null;
      const cursor = u.searchParams.get("cursor");
      return cursor && HF_CURSOR_RE.test(cursor) ? cursor : null;
    } catch {
      return null;
    }
  }
  return null;
}

// Result mapping

/** HF result in the model browser's card shape. */
export interface HfModelSummary {
  id: string;
  name: string;
  author: string | null;
  downloads: number;
  likes: number;
  tags: string[];
  pipelineTag: string | null;
  library: string | null;
  lastModified: string | null;
  createdAt: string | null;
  gated: boolean;
  /** Hub `not-for-all-audiences` tag */
  adult: boolean;
  url: string;
  /** Single-file weights in the repo (from `siblings`); size only when the Hub sends it. */
  files?: HfModelFile[];
}

export interface HfModelFile {
  name: string;
  bytes?: number;
}

const HF_FILE_RE = /\.(safetensors|sft|gguf)$/i;
const HF_MAX_FILES = 64;

/** Weight files from a Hub `siblings` array (names only on list endpoints). */
export function mapHfSiblings(raw: unknown): HfModelFile[] {
  if (!Array.isArray(raw)) return [];
  const out: HfModelFile[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const r = s as Record<string, unknown>;
    const name = r.rfilename;
    if (typeof name !== "string" || !HF_FILE_RE.test(name)) continue;
    // Diffusers shards aren't single-file models ComfyUI can load.
    if (/-\d{5}-of-\d{5}\./.test(name)) continue;
    const size = r.size;
    out.push(
      typeof size === "number" && Number.isFinite(size) && size > 0
        ? { name, bytes: size }
        : { name },
    );
    if (out.length >= HF_MAX_FILES) break;
  }
  return out;
}

const HF_REPO_ID_RE =
  /^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)?$/;

/** Map one raw Hub item; returns null for malformed entries. */
export function mapHfModel(raw: unknown): HfModelSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id =
    typeof r.id === "string"
      ? r.id
      : typeof r.modelId === "string"
        ? r.modelId
        : null;
  if (!id || !HF_REPO_ID_RE.test(id)) return null;
  const tags = Array.isArray(r.tags)
    ? r.tags.filter((t): t is string => typeof t === "string").slice(0, 40)
    : [];
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const slash = id.indexOf("/");
  return {
    id,
    name: slash >= 0 ? id.slice(slash + 1) : id,
    author: str(r.author) ?? (slash >= 0 ? id.slice(0, slash) : null),
    downloads: num(r.downloads),
    likes: num(r.likes),
    tags,
    pipelineTag: str(r.pipeline_tag),
    library: str(r.library_name),
    lastModified: str(r.lastModified),
    createdAt: str(r.createdAt),
    gated: r.gated === true || r.gated === "auto" || r.gated === "manual",
    adult: tags.includes("not-for-all-audiences"),
    url: `${HF_API_ORIGIN}/${id}`,
    files: mapHfSiblings(r.siblings),
  };
}

export function mapHfModels(raw: unknown): HfModelSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(mapHfModel).filter((m): m is HfModelSummary => m !== null);
}

/** Display tags: drop the noisy `region:` / `license:` / `base_model:adapter:` bits. */
export function hfDisplayTags(m: HfModelSummary, max = 4): string[] {
  return m.tags
    .filter(
      (t) =>
        !t.startsWith("region:") &&
        !t.startsWith("license:") &&
        !t.startsWith("base_model:") &&
        !t.startsWith("template:") &&
        !t.startsWith("endpoints_") &&
        !t.startsWith("autotrain") &&
        t !== m.pipelineTag &&
        t !== m.library &&
        t !== "not-for-all-audiences",
    )
    .slice(0, max);
}

/** `base_model:<repo>` tag → repo id (first non-adapter one). */
export function hfBaseModel(m: HfModelSummary): string | null {
  for (const t of m.tags) {
    const match = t.match(
      /^base_model:(?!adapter:|finetune:|quantized:|merge:)(.+)$/,
    );
    if (match) return match[1];
  }
  return null;
}
