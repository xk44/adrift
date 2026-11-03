/**
 * Minimal Gradio HTTP client for the HairDeck demo (Gradio 5+ /gradio_api
 * routes, plain fetch): upload -> call/generate -> SSE result -> file=.
 * Every request has a timeout and every body a byte cap; only the files
 * HairDeck is known to write are fetched.
 */
import type { HairDeckRequest } from "./config";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const HAIRDECK_TIMEOUTS = {
  info: 5_000,
  upload: 60_000,
  call: 30_000,
  /** One job: queue wait plus ~30 + 10 s per variation on a free GPU. */
  result: 15 * 60_000,
  file: 60_000,
};
export const HAIRDECK_FILE_LIMITS = {
  maxFiles: 32,
  perFileBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  sseBytes: 4 * 1024 * 1024,
  jsonBytes: 1024 * 1024,
};

export class HairDeckError extends Error {
  override name = "HairDeckError";
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

/** Duck-typed so a second copy of this module (bundles, tests) still matches. */
export function isHairDeckError(e: unknown): e is HairDeckError {
  return (
    e instanceof HairDeckError ||
    (e instanceof Error && e.name === "HairDeckError" && typeof (e as HairDeckError).status === "number")
  );
}

export type HairDeckFileKind = "mesh" | "cards" | "chains" | "preview";

export interface HairDeckFile {
  /** Basename as HairDeck wrote it (hair_seed3_nohead.glb, prep.png, ...). */
  name: string;
  kind: HairDeckFileKind;
  /** Seed parsed from the name; null for the shared preview. */
  seed: number | null;
  bytes: Uint8Array;
}

/** Files HairDeck writes per seed; anything else in the reply is ignored. */
const RESULT_FILE_RE =
  /^(?:hair_seed(\d{1,10})(?:_nohead)?(?:_chains)?\.glb|cards_seed(\d{1,10})\.json|chains_seed(\d{1,10})\.json)$/;
const PREVIEW_RE = /\.(?:png|jpe?g|webp)$/i;

function classify(
  name: string,
): { kind: HairDeckFileKind; seed: number } | null {
  const m = RESULT_FILE_RE.exec(name);
  if (!m) return null;
  if (m[1] !== undefined) return { kind: "mesh", seed: Number(m[1]) };
  if (m[2] !== undefined) return { kind: "cards", seed: Number(m[2]) };
  return { kind: "chains", seed: Number(m[3]) };
}

function timeoutSignal(ms: number, outer?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return outer ? AbortSignal.any([t, outer]) : t;
}

async function request(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  ms: number,
  what: string,
  outer?: AbortSignal,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...init,
      cache: "no-store",
      redirect: "error",
      signal: timeoutSignal(ms, outer),
    });
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "TimeoutError")
      throw new HairDeckError(
        `HairDeck did not answer the ${what} in time.`,
        504,
      );
    if (name === "AbortError") throw new HairDeckError("Cancelled.", 499);
    throw new HairDeckError(`Could not reach HairDeck (${what}).`, 502);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new HairDeckError(
      `HairDeck ${what} failed (HTTP ${res.status}).`,
      502,
    );
  }
  return res;
}

/** Read a body up to `cap` bytes; larger bodies are an error. */
async function readCapped(
  res: Response,
  cap: number,
  what: string,
): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => {});
    throw new HairDeckError(`HairDeck ${what} is too large.`, 502);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new HairDeckError(`HairDeck ${what} is too large.`, 502);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function readJson(res: Response, what: string): Promise<unknown> {
  const bytes = await readCapped(res, HAIRDECK_FILE_LIMITS.jsonBytes, what);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HairDeckError(`HairDeck ${what} was not JSON.`, 502);
  }
}

/** Reachable and serving the generate endpoint? */
export async function hairdeckProbe(
  base: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ reachable: true } | { reachable: false; error: string }> {
  try {
    const res = await request(
      fetchImpl,
      `${base}/gradio_api/info`,
      { method: "GET" },
      HAIRDECK_TIMEOUTS.info,
      "status check",
    );
    const info = (await readJson(res, "status check")) as {
      named_endpoints?: Record<string, unknown>;
    } | null;
    if (!info?.named_endpoints || !("/generate" in info.named_endpoints))
      return {
        reachable: false,
        error: "The server answered but has no HairDeck generate endpoint.",
      };
    return { reachable: true };
  } catch (e) {
    return { reachable: false, error: (e as Error).message };
  }
}

/** Terminal SSE event -> result, or null for progress/heartbeat events. */
function sseEvent(event: string, data: string): unknown[] | null {
  if (event === "error") {
    let msg = "";
    try {
      const parsed = JSON.parse(data) as unknown;
      if (typeof parsed === "string") msg = parsed;
      else if (parsed && typeof parsed === "object" && "error" in parsed)
        msg = String((parsed as { error: unknown }).error ?? "");
    } catch {
      msg = data;
    }
    throw new HairDeckError(
      `HairDeck failed${msg && msg !== "null" ? `: ${msg.slice(0, 300)}` : "."}`,
      502,
    );
  }
  if (event !== "complete") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new HairDeckError("HairDeck sent an unreadable result.", 502);
  }
  if (!Array.isArray(parsed))
    throw new HairDeckError("HairDeck sent an unreadable result.", 502);
  return parsed;
}

/** Read a Gradio SSE stream until `complete` or `error` (byte-capped). */
export async function readResult(res: Response): Promise<unknown[]> {
  if (!res.body) throw new HairDeckError("HairDeck sent an empty result stream.", 502);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let total = 0;
  let event = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        total += value.byteLength;
        if (total > HAIRDECK_FILE_LIMITS.sseBytes)
          throw new HairDeckError("HairDeck result stream is too large.", 502);
        buf += decoder.decode(value, { stream: true });
      }
      if (done) buf += "\n";
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          const out = sseEvent(event, line.slice(5).trim());
          if (out) return out;
        }
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new HairDeckError(
    "HairDeck closed the result stream without a result.",
    502,
  );
}

interface FileRef {
  path: string;
  name: string;
}

function fileRef(v: unknown): FileRef | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== "string" || !o.path || o.path.length > 1024)
    return null;
  if (/[\0\r\n]/.test(o.path) || o.path.split(/[\\/]/).includes(".."))
    return null;
  const base = o.path.split(/[\\/]/).pop() ?? "";
  const name =
    typeof o.orig_name === "string" && o.orig_name ? o.orig_name : base;
  return { path: o.path, name: name.split(/[\\/]/).pop() ?? base };
}

/** Every Gradio FileData in a reply value (nested lists/updates included). */
function collectFiles(v: unknown, out: FileRef[], depth = 0): void {
  if (depth > 6 || out.length > 256) return;
  const ref = fileRef(v);
  if (ref) {
    out.push(ref);
    return;
  }
  if (Array.isArray(v)) for (const x of v) collectFiles(x, out, depth + 1);
  else if (v && typeof v === "object")
    for (const x of Object.values(v)) collectFiles(x, out, depth + 1);
}

/** Pick the files Adrift keeps: the prep preview (output 0) plus per-seed results. */
export function selectResultFiles(
  data: unknown[],
): { ref: FileRef; kind: HairDeckFileKind; seed: number | null }[] {
  const picked: {
    ref: FileRef;
    kind: HairDeckFileKind;
    seed: number | null;
  }[] = [];
  const seen = new Set<string>();
  const preview = fileRef(data[0]);
  if (preview && PREVIEW_RE.test(preview.name)) {
    picked.push({ ref: preview, kind: "preview", seed: null });
    seen.add(preview.path);
  }
  const refs: FileRef[] = [];
  collectFiles(data.slice(1), refs);
  for (const ref of refs) {
    if (seen.has(ref.path)) continue;
    const c = classify(ref.name);
    if (!c) continue;
    seen.add(ref.path);
    picked.push({ ref, kind: c.kind, seed: c.seed });
    if (picked.length >= HAIRDECK_FILE_LIMITS.maxFiles) break;
  }
  return picked;
}

function fileUrl(base: string, p: string): string {
  const lead = p.startsWith("/") ? "/" : "";
  const segs = p.replace(/^\/+/, "").split("/").map(encodeURIComponent);
  return `${base}/gradio_api/file=${lead}${segs.join("/")}`;
}

/**
 * Run one HairDeck job and download its results. `signal` aborts every
 * stage (the browser left or the caller gave up).
 */
export async function runHairDeck(
  base: string,
  req: HairDeckRequest,
  opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<HairDeckFile[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const signal = opts.signal;
  const ext =
    req.image.mime === "image/png"
      ? "png"
      : req.image.mime === "image/webp"
        ? "webp"
        : "jpg";

  const form = new FormData();
  form.append(
    "files",
    new Blob([new Uint8Array(req.image.bytes)], { type: req.image.mime }),
    `portrait.${ext}`,
  );
  const up = await request(
    fetchImpl,
    `${base}/gradio_api/upload`,
    { method: "POST", body: form },
    HAIRDECK_TIMEOUTS.upload,
    "upload",
    signal,
  );
  const paths = await readJson(up, "upload");
  if (!Array.isArray(paths) || typeof paths[0] !== "string" || !paths[0])
    throw new HairDeckError("HairDeck upload returned no file.", 502);

  const payload = {
    data: [
      { path: paths[0], meta: { _type: "gradio.FileData" } },
      req.seed,
      req.steps,
      req.cfg,
      req.variations,
      true,
      req.chains,
    ],
  };
  const call = await request(
    fetchImpl,
    `${base}/gradio_api/call/generate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    HAIRDECK_TIMEOUTS.call,
    "job submit",
    signal,
  );
  const ev = (await readJson(call, "job submit")) as {
    event_id?: unknown;
  } | null;
  const eventId = ev?.event_id;
  if (typeof eventId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(eventId))
    throw new HairDeckError("HairDeck did not return a job id.", 502);

  const stream = await request(
    fetchImpl,
    `${base}/gradio_api/call/generate/${eventId}`,
    { method: "GET", headers: { accept: "text/event-stream" } },
    HAIRDECK_TIMEOUTS.result,
    "job",
    signal,
  );
  const data = await readResult(stream);

  const picks = selectResultFiles(data);
  if (!picks.some((p) => p.kind === "mesh"))
    throw new HairDeckError("HairDeck finished without a hair mesh.", 502);
  const files: HairDeckFile[] = [];
  let total = 0;
  for (const p of picks) {
    const res = await request(
      fetchImpl,
      fileUrl(base, p.ref.path),
      { method: "GET" },
      HAIRDECK_TIMEOUTS.file,
      `download of ${p.ref.name}`,
      signal,
    );
    const bytes = await readCapped(
      res,
      HAIRDECK_FILE_LIMITS.perFileBytes,
      p.ref.name,
    );
    total += bytes.byteLength;
    if (total > HAIRDECK_FILE_LIMITS.totalBytes)
      throw new HairDeckError("HairDeck results are too large.", 502);
    files.push({ name: p.ref.name, kind: p.kind, seed: p.seed, bytes });
  }
  return files;
}
