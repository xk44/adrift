// Adrift MCP server core: stdio JSON-RPC 2.0 (newline-delimited) per the Model
// Context Protocol spec, talking to a running Adrift over HTTP. No deps.
// Entry point: scripts/adrift-mcp.mjs. Docs: docs/MCP.md.
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const SERVER_INFO = { name: "adrift", version: "1.0.0" };
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const CATALOG_TTL_MS = 30_000;

export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** A failed Adrift call or bad tool input: reported as an isError tool result. */
export class ToolError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

const MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  webm: "video/webm",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  flac: "audio/flac",
};
const EXT_BY_MIME = Object.fromEntries(
  Object.entries(MIME_BY_EXT).map(([e, m]) => [m, e]),
);
EXT_BY_MIME["image/jpeg"] = "jpg";
EXT_BY_MIME["audio/x-wav"] = "wav";
EXT_BY_MIME["audio/wave"] = "wav";

const REF_RE = /^(.+?) \[(input|output|temp)\]$/;

export function isLoopbackUrl(url) {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "::1" || /^127\./.test(h);
  } catch {
    return false;
  }
}

// --- media headers ----------------------------------------------------------

/** { width, height } from PNG / JPEG / GIF / WebP bytes, else null. */
export function imageSize(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47)
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length >= 10 && buf.toString("ascii", 0, 3) === "GIF")
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (
    buf.length >= 30 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X")
      return {
        width: 1 + buf.readUIntLE(24, 3),
        height: 1 + buf.readUIntLE(27, 3),
      };
    if (chunk === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 ")
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
      };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (
        marker === 0xd8 ||
        marker === 0x01 ||
        (marker >= 0xd0 && marker <= 0xd7)
      ) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      )
        return {
          width: buf.readUInt16BE(i + 7),
          height: buf.readUInt16BE(i + 5),
        };
      i += 2 + len;
    }
  }
  return null;
}

/** { width, height, duration } from an MP4/MOV moov box (mvhd + first video tkhd). */
export function mp4Info(buf) {
  const out = { width: null, height: null, duration: null };
  const walk = (start, end, depth) => {
    let i = start;
    while (i + 8 <= end && depth < 6) {
      let size = buf.readUInt32BE(i);
      const type = buf.toString("ascii", i + 4, i + 8);
      let header = 8;
      if (size === 1 && i + 16 <= end) {
        size = Number(buf.readBigUInt64BE(i + 8));
        header = 16;
      } else if (size === 0) size = end - i;
      if (size < header || i + size > end) break;
      const body = i + header;
      if (type === "moov" || type === "trak" || type === "mdia")
        walk(body, i + size, depth + 1);
      else if (type === "mvhd" && out.duration === null) {
        const v = buf[body];
        const scale =
          v === 1 ? buf.readUInt32BE(body + 20) : buf.readUInt32BE(body + 12);
        const dur =
          v === 1
            ? Number(buf.readBigUInt64BE(body + 24))
            : buf.readUInt32BE(body + 16);
        if (scale > 0) out.duration = Math.round((dur / scale) * 1000) / 1000;
      } else if (type === "tkhd" && out.width === null) {
        const w = buf.readUInt32BE(i + size - 8) / 65536;
        const h = buf.readUInt32BE(i + size - 4) / 65536;
        if (w > 0 && h > 0) {
          out.width = Math.round(w);
          out.height = Math.round(h);
        }
      }
      i += size;
    }
  };
  try {
    walk(0, buf.length, 0);
  } catch {
    // truncated / not an ISO-BMFF file: keep what was read
  }
  return out;
}

/** Seconds of a WAV (fmt byte rate + data size) or MP4/M4A file, else null. */
export function audioSeconds(buf) {
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") {
    let i = 12;
    let byteRate = 0;
    while (i + 8 <= buf.length) {
      const id = buf.toString("ascii", i, i + 4);
      const size = buf.readUInt32LE(i + 4);
      if (id === "fmt " && i + 16 <= buf.length) byteRate = buf.readUInt32LE(i + 16);
      if (id === "data")
        return byteRate > 0 ? Math.round((Math.min(size, buf.length - i - 8) / byteRate) * 1000) / 1000 : null;
      i += 8 + size + (size % 2);
    }
    return null;
  }
  return mp4Info(buf).duration;
}

// --- HTTP client --------------------------------------------------------------

export function createAdriftClient({
  baseUrl = "http://127.0.0.1:3000",
  apiKey = "",
  fetchImpl = globalThis.fetch,
  timeoutMs = 120_000,
} = {}) {
  const base = new URL(baseUrl);
  const origin = base.origin;
  const headers = (extra = {}) => ({
    // Same-origin markers for Adrift's CSRF check (src/middleware.ts).
    Origin: origin,
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": `adrift-mcp/${SERVER_INFO.version}`,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...extra,
  });
  const abs = (p) => new URL(p, base).toString();

  async function request(method, p, body) {
    let res;
    try {
      res = await fetchImpl(abs(p), {
        method,
        headers: headers(
          body !== undefined ? { "Content-Type": "application/json" } : {},
        ),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new ToolError(
        `Adrift is not reachable at ${origin} (${e?.cause?.code ?? e?.message ?? e}). ` +
          "Start it with `npm run dev` or set ADRIFT_URL.",
      );
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok || data?.ok === false) {
      const msg =
        (data && typeof data.error === "string" && data.error) ||
        `${method} ${p} failed (HTTP ${res.status})`;
      const err = new ToolError(msg, {
        status: res.status,
        ...(data?.details?.code ? { code: data.details.code } : {}),
      });
      err.status = res.status;
      throw err;
    }
    return data ?? {};
  }

  async function getBytes(p) {
    let res;
    try {
      res = await fetchImpl(abs(p), {
        headers: headers(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new ToolError(`Could not fetch ${p}: ${e?.message ?? e}`);
    }
    if (!res.ok)
      throw new ToolError(`Could not fetch ${p} (HTTP ${res.status})`);
    return {
      buf: Buffer.from(await res.arrayBuffer()),
      mime: (res.headers.get("content-type") || "").split(";")[0].trim(),
    };
  }

  return {
    origin,
    abs,
    get: (p) => request("GET", p),
    post: (p, body) => request("POST", p, body ?? {}),
    getBytes,
  };
}

// --- input files --------------------------------------------------------------

function mimeFor(name, sniffed) {
  if (sniffed && sniffed !== "application/octet-stream") return sniffed;
  const ext = path.extname(name).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function sniffMime(buf) {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8)
    return "image/jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  if (buf.length >= 3 && buf.toString("ascii", 0, 3) === "GIF")
    return "image/gif";
  if (buf.length >= 12 && buf.toString("ascii", 8, 12) === "WAVE")
    return "audio/wav";
  if (buf.length >= 4 && buf.toString("ascii", 0, 4) === "fLaC")
    return "audio/flac";
  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp") {
    const brand = buf.toString("ascii", 8, 12);
    if (brand.startsWith("M4A")) return "audio/mp4";
    if (brand === "qt  ") return "video/quicktime";
    return "video/mp4";
  }
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3)
    return "video/webm";
  return null;
}

export function viewQuery(ref) {
  const m = REF_RE.exec(ref);
  if (!m) return null;
  const full = m[1];
  const slash = full.lastIndexOf("/");
  const q = new URLSearchParams({
    filename: slash >= 0 ? full.slice(slash + 1) : full,
    subfolder: slash >= 0 ? full.slice(0, slash) : "",
    type: m[2],
  });
  return `/api/comfy/image?${q}`;
}

/**
 * Bytes of a tool input: an Adrift/ComfyUI ref ("name.png [output]"), an
 * http(s) URL, or a local file path.
 */
export async function loadInput(client, value, label) {
  if (typeof value !== "string" || !value.trim())
    throw new ToolError(`${label} must be a file path, URL or ref`);
  const v = value.trim();
  const viewPath = viewQuery(v);
  if (viewPath) {
    const { buf, mime } = await client.getBytes(viewPath);
    return {
      buf,
      mime: mimeFor(v.replace(REF_RE, "$1"), sniffMime(buf) ?? mime),
      name: path.basename(v.replace(REF_RE, "$1")),
      ref: v,
    };
  }
  if (/^https?:\/\//i.test(v)) {
    const sameOrigin = new URL(v).origin === client.origin;
    let buf;
    let mime = "";
    if (sameOrigin)
      ({ buf, mime } = await client.getBytes(
        new URL(v).pathname + new URL(v).search,
      ));
    else {
      let res;
      try {
        res = await fetch(v, { signal: AbortSignal.timeout(120_000) });
      } catch (e) {
        throw new ToolError(
          `${label}: could not download ${v}: ${e?.message ?? e}`,
        );
      }
      if (!res.ok)
        throw new ToolError(`${label}: download failed (HTTP ${res.status})`);
      const len = Number(res.headers.get("content-length") || 0);
      if (len > MAX_UPLOAD_BYTES)
        throw new ToolError(`${label}: file is larger than 32 MB`);
      buf = Buffer.from(await res.arrayBuffer());
      mime = (res.headers.get("content-type") || "").split(";")[0].trim();
    }
    const name = path.basename(new URL(v).pathname) || "download";
    if (buf.length > MAX_UPLOAD_BYTES)
      throw new ToolError(`${label}: file is larger than 32 MB`);
    return { buf, mime: mimeFor(name, sniffMime(buf) ?? mime), name };
  }
  const p = v.startsWith("~/") ? path.join(os.homedir(), v.slice(2)) : v;
  if (!path.isAbsolute(p))
    throw new ToolError(
      `${label}: use an absolute file path, URL or ref (got "${v}")`,
    );
  let info;
  try {
    info = await stat(p);
  } catch {
    throw new ToolError(`${label}: file not found: ${p}`);
  }
  if (!info.isFile()) throw new ToolError(`${label}: not a file: ${p}`);
  if (info.size > MAX_UPLOAD_BYTES)
    throw new ToolError(`${label}: file is larger than 32 MB`);
  const buf = await readFile(p);
  return { buf, mime: mimeFor(p, sniffMime(buf)), name: path.basename(p) };
}

let uploadCounter = 0;
function uploadName(prefix, mime) {
  uploadCounter += 1;
  const ext = EXT_BY_MIME[mime] ?? "png";
  return `${prefix}_${Date.now().toString(36)}${uploadCounter}.${ext}`;
}

async function uploadFile(client, file, prefix) {
  const data = await client.post("/api/comfy/upload", {
    image: `data:${file.mime};base64,${file.buf.toString("base64")}`,
    filename: uploadName(prefix, file.mime),
  });
  if (typeof data.ref !== "string") throw new ToolError("Upload failed");
  return data.ref;
}

/** An input ref usable by ComfyUI LoadImage: [input] refs pass through. */
async function inputRef(client, value, label, prefix) {
  if (typeof value === "string" && /^.+ \[input\]$/.test(value.trim()))
    return { ref: value.trim(), file: null };
  const file = await loadInput(client, value, label);
  return { ref: await uploadFile(client, file, prefix), file };
}

// --- catalog ------------------------------------------------------------------

function toolCatalog(client) {
  let cache = null;
  return async function catalog(force = false) {
    if (!force && cache && Date.now() - cache.at < CATALOG_TTL_MS)
      return cache.tools;
    const data = await client.get("/api/tools/agent");
    if (!Array.isArray(data.tools))
      throw new ToolError("Adrift returned no tool list");
    cache = { at: Date.now(), tools: data.tools };
    return data.tools;
  };
}

function findTool(tools, id) {
  if (typeof id !== "string" || !id) return null;
  const exact = tools.find((t) => t.id === id);
  if (exact) return exact;
  return (
    tools.find((t) => t.id === `action:${id}`) ??
    tools.find((t) => t.id === `catalog:${id}`) ??
    null
  );
}

/** Top-level checks against the generated schema; Adrift validates the rest. */
export function checkInputs(schema, inputs) {
  const props = schema?.properties ?? {};
  const problems = [];
  for (const key of schema?.required ?? [])
    if (inputs[key] === undefined || inputs[key] === null || inputs[key] === "")
      problems.push(`missing required input "${key}"`);
  for (const key of Object.keys(inputs))
    if (!(key in props))
      problems.push(
        `unknown input "${key}" (expected: ${Object.keys(props).join(", ") || "none"})`,
      );
  for (const [key, val] of Object.entries(inputs)) {
    const s = props[key];
    if (!s || val === undefined) continue;
    if (s.type === "array") {
      if (!Array.isArray(val)) problems.push(`"${key}" must be an array`);
      else {
        if (typeof s.minItems === "number" && val.length < s.minItems)
          problems.push(`"${key}" needs at least ${s.minItems} item(s)`);
        if (typeof s.maxItems === "number" && val.length > s.maxItems)
          problems.push(`"${key}" takes at most ${s.maxItems} item(s)`);
      }
    } else if (s.type === "string" && typeof val !== "string")
      problems.push(`"${key}" must be a string`);
    else if (
      s.type === "object" &&
      (typeof val !== "object" || Array.isArray(val))
    )
      problems.push(`"${key}" must be an object`);
  }
  if (problems.length)
    throw new ToolError(`Invalid inputs: ${problems.join("; ")}`, { problems });
}

function jobIdsOf(run) {
  return (run?.jobs ?? [])
    .map((j) => j?.prompt_id)
    .filter((x) => typeof x === "string" && x);
}

function runSummary(run) {
  const job_ids = jobIdsOf(run);
  return {
    run_id: run?.run_id ?? null,
    job_id: job_ids[0] ?? null,
    job_ids,
    status: run?.status ?? null,
    ...(run?.jobs?.some((j) => j?.error)
      ? { errors: run.jobs.map((j) => j?.error).filter(Boolean) }
      : {}),
  };
}

// --- outputs ------------------------------------------------------------------

function annotatedRef(f) {
  return `${f.subfolder ? `${f.subfolder}/` : ""}${f.filename} [${f.type || "output"}]`;
}

function finalScore(f) {
  let s = 0;
  if (f.type === "output") s += 4;
  if (/^Save|Save/i.test(f.classType ?? "")) s += 2;
  if (!/^ComfyUI_temp_/i.test(f.filename)) s += 1;
  return s;
}

async function localDirs(client) {
  if (!isLoopbackUrl(client.origin)) return null;
  try {
    const d = await client.get("/api/settings/dirs");
    if (!d.comfyLocal || !Array.isArray(d.dirs)) return null;
    const expand = (p) =>
      typeof p === "string"
        ? p === "~"
          ? os.homedir()
          : p.startsWith("~/")
            ? path.join(os.homedir(), p.slice(2))
            : p
        : null;
    const by = Object.fromEntries(
      d.dirs.map((x) => [x.key, expand(x.display)]),
    );
    return {
      output: by.output ?? null,
      input: by.input ?? null,
      temp: by.comfyRoot ? path.join(by.comfyRoot, "temp") : null,
    };
  } catch {
    return null;
  }
}

async function localPathFor(dirs, f) {
  const root = dirs?.[f.type || "output"];
  if (!root) return null;
  const p = path.resolve(root, f.subfolder || "", f.filename);
  if (!p.startsWith(path.resolve(root) + path.sep)) return null;
  try {
    return (await stat(p)).isFile() ? p : null;
  } catch {
    return null;
  }
}

async function outputsFor(client, jobId) {
  let data;
  try {
    data = await client.get(`/api/comfy/history/${encodeURIComponent(jobId)}`);
  } catch (e) {
    if (e instanceof ToolError && e.status === 404)
      return { ready: false, files: [], texts: [] };
    throw e;
  }
  const dirs = await localDirs(client);
  const files = [];
  for (const kind of ["images", "videos", "audios", "meshes"]) {
    for (const f of data[kind] ?? []) {
      if (!f?.filename) continue;
      const local = await localPathFor(dirs, f);
      files.push({
        kind: kind.slice(0, -1),
        filename: f.filename,
        type: f.type || "output",
        ref: annotatedRef(f),
        url: client.abs(f.url ?? viewQuery(annotatedRef(f))),
        ...(local ? { local_path: local } : {}),
        node: f.nodeTitle || f.classType || f.nodeId || null,
        _score: finalScore(f),
      });
    }
  }
  const best = files.reduce(
    (a, f) => (!a || f._score > a._score ? f : a),
    null,
  );
  for (const f of files) {
    if (f === best) f.final = true;
    delete f._score;
  }
  const status = data.status ?? {};
  let error = null;
  for (const m of status.messages ?? []) {
    if (Array.isArray(m) && m[0] === "execution_error")
      error = m[1]?.exception_message ?? "Execution error";
  }
  return {
    ready: true,
    status: status.status_str ?? (status.completed ? "success" : null),
    ...(error ? { error } : {}),
    files,
    texts: (data.texts ?? []).map((t) => t.text).filter(Boolean),
  };
}

// --- tools --------------------------------------------------------------------

const JOB_ID = {
  type: "string",
  description: "job_id from run_tool / generate_image (a ComfyUI prompt id).",
};

export const MCP_TOOLS = [
  {
    name: "list_tools",
    title: "List Adrift tools",
    description:
      "List Adrift's image/video/audio tools: id, name, category, summary, inputs, VRAM tier, commercial-license badge and whether it is installed. Use describe_tool for an input schema, then run_tool.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Case-insensitive match on id, name, category or summary.",
        },
        category: {
          type: "string",
          description: 'Exact category, e.g. "Edit" or "Video".',
        },
        kind: { type: "string", enum: ["action", "catalog"] },
        available_only: {
          type: "boolean",
          default: false,
          description: "Only tools this server can run now.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "describe_tool",
    title: "Describe an Adrift tool",
    description:
      "Full description and JSON input schema (generated from Adrift's tool registry) for one tool id from list_tools.",
    inputSchema: {
      type: "object",
      properties: {
        tool_id: {
          type: "string",
          description: 'e.g. "action:upscale" or "catalog:qwen21-outpaint".',
        },
      },
      required: ["tool_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "run_tool",
    title: "Run an Adrift tool",
    description:
      "Queue a tool on the GPU. `inputs` must follow describe_tool's schema; file inputs accept a local path, http(s) URL, or a ref from get_outputs, and are uploaded for you. Returns job_id; then wait_for_job and get_outputs.",
    inputSchema: {
      type: "object",
      properties: {
        tool_id: { type: "string" },
        inputs: {
          type: "object",
          description: "Per describe_tool's input_schema.",
          additionalProperties: true,
        },
      },
      required: ["tool_id"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "generate_image",
    title: "Generate an image",
    description:
      "Text-to-image through Adrift's Create bar. The prompt takes Adrift's inline flags (--ar 16:9, --seed, --no, --sref, ...). Returns job_ids; then wait_for_job and get_outputs.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 4000 },
        batch_size: {
          type: "integer",
          minimum: 1,
          maximum: 8,
          description: "Images to queue (default: the server's).",
        },
        workflow_path: {
          type: "string",
          description: "Optional workflow/pack path as on the Create bar.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "job_status",
    title: "Job status",
    description:
      "State of one or more jobs: queued | running | done | error | cancelled | missing | unknown.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: JOB_ID,
        job_ids: { type: "array", items: { type: "string" }, maxItems: 50 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "wait_for_job",
    title: "Wait for a job",
    description:
      "Poll a job until it finishes or the timeout passes (default 60 s, max 300 s; call again to keep waiting). Includes outputs when done.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: JOB_ID,
        timeout_seconds: {
          type: "number",
          minimum: 1,
          maximum: 300,
          default: 60,
        },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_outputs",
    title: "Get job outputs",
    description:
      "Files a finished job produced: url, ref (reusable as a tool input), local_path when Adrift's ComfyUI is on this machine, and final=true on the main result. Also any text outputs.",
    inputSchema: {
      type: "object",
      properties: { job_id: JOB_ID },
      required: ["job_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "cancel_job",
    title: "Cancel a job",
    description: "Remove a queued job or interrupt it if running.",
    inputSchema: {
      type: "object",
      properties: { job_id: JOB_ID },
      required: ["job_id"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
  },
];

function str(args, key, required = true) {
  const v = args?.[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ToolError(`"${key}" is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolError(`"${key}" must be a string`);
  return v;
}

export function createToolHandlers(
  client,
  {
    clientId,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    pollMs = 2000,
  } = {},
) {
  const catalog = toolCatalog(client);
  const cid = clientId ?? `adrift-mcp-${randomBytes(6).toString("hex")}`;

  // job_id -> run_id for runs this session queued. Adrift records outputs,
  // job status and video QC when a run is polled through /api/jobs/recent
  // (the web UI does that); headless agent runs would otherwise stay
  // "pending" in the gallery and never get QC'd.
  const runOf = new Map();
  function remember(summary) {
    for (const j of summary.job_ids ?? [])
      if (summary.run_id) runOf.set(j, summary.run_id);
    return summary;
  }
  async function syncRun(jobId) {
    const runId = runOf.get(jobId);
    if (!runId) return;
    try {
      await client.get(`/api/jobs/recent?run_id=${encodeURIComponent(runId)}`);
    } catch {
      // Best effort: outputs still come from ComfyUI history.
    }
  }

  async function statuses(ids) {
    const data = await client.get(
      `/api/comfy/prompt-status?ids=${ids.map(encodeURIComponent).join(",")}`,
    );
    return data.statuses ?? {};
  }

  async function runCatalog(tool, inputs) {
    const images = [];
    for (const [i, v] of (inputs.images ?? []).entries())
      images.push((await inputRef(client, v, `images[${i}]`, "cj_tool")).ref);
    let mask;
    if (inputs.mask)
      mask = (await inputRef(client, inputs.mask, "mask", "cj_tool_mask")).ref;
    const data = await client.post("/api/jobs/tool", {
      toolId: tool.id.replace(/^catalog:/, ""),
      images,
      ...(mask ? { mask } : {}),
      ...(typeof inputs.prompt === "string" && inputs.prompt
        ? { prompt: inputs.prompt }
        : {}),
      ...(inputs.options ? { options: inputs.options } : {}),
      client_id: cid,
    });
    return data;
  }

  async function runAction(tool, inputs) {
    const second = inputs.second_image
      ? (await inputRef(client, inputs.second_image, "second_image", "cj_face"))
          .ref
      : undefined;
    const extras = [];
    for (const [i, v] of (inputs.extra_images ?? []).entries())
      extras.push(
        (await inputRef(client, v, `extra_images[${i}]`, `cj_ref${i + 3}`)).ref,
      );
    const masks = [];
    for (const [i, v] of (inputs.masks ?? []).entries())
      masks.push(
        (await inputRef(client, v, `masks[${i}]`, `cj_region_mask${i + 1}`))
          .ref,
      );
    let audio;
    if (inputs.audio) {
      const a = await inputRef(client, inputs.audio, "audio", "cj_audio");
      const seconds = a.file ? audioSeconds(a.file.buf) : null;
      audio = { ref: a.ref, ...(seconds ? { seconds } : {}) };
    }
    const compiled = await client.post("/api/tools/agent/compile", {
      toolId: tool.id,
      text: inputs.text,
      second_text: inputs.second_text,
      options: inputs.options,
      edit_lora: inputs.edit_lora,
      edit_family: inputs.edit_family,
      second_ref: second,
      extra_refs: extras,
      mask_refs: masks,
      audio_ref: audio?.ref,
      audio_seconds: audio?.seconds,
      focus: inputs.focus,
      focus_a: inputs.focus_a,
      focus_b: inputs.focus_b,
    });
    let seeded;
    if (tool.source === "none") {
      const p = compiled.params ?? {};
      const prompt =
        typeof p.prompt === "string"
          ? p.prompt
          : typeof p.script === "string"
            ? p.script
            : tool.name;
      seeded = await client.post("/api/jobs/seed-run", {
        text_only: true,
        prompt,
      });
    } else {
      const isVideo = tool.source === "video";
      const label = isVideo ? "video" : "image";
      const value = inputs[label];
      // seed-run reads [input] refs only; anything else is uploaded.
      const file = await loadInput(client, value, label);
      const ref =
        file.ref && file.ref.endsWith(" [input]")
          ? file.ref
          : await uploadFile(client, file, isVideo ? "cj_clip" : "cj_tool");
      const dims = isVideo ? mp4Info(file.buf) : imageSize(file.buf);
      seeded = await client.post("/api/jobs/seed-run", {
        ref,
        width: dims?.width || (isVideo ? 1280 : 1024),
        height: dims?.height || (isVideo ? 720 : 1024),
        prompt: tool.name,
        ...(isVideo && dims?.duration ? { duration: dims.duration } : {}),
        ...(audio ? { audio: audio.ref } : {}),
        ...(audio?.seconds ? { audio_duration: audio.seconds } : {}),
      });
    }
    const src = seeded.run;
    if (!src?.run_id) throw new ToolError("Could not prepare the source run");
    return client.post("/api/jobs/action", {
      run_id: src.run_id,
      job_index: src.jobs?.[0]?.index ?? 0,
      action: compiled.action,
      client_id: cid,
      tool_page_id: compiled.tool_page_id,
      params: compiled.params ?? {},
      ...(compiled.overrides && Object.keys(compiled.overrides).length
        ? { workflow_control_overrides: compiled.overrides }
        : {}),
    });
  }

  return {
    async list_tools(args = {}) {
      const tools = await catalog();
      const q = typeof args.query === "string" ? args.query.toLowerCase() : "";
      const rows = tools
        .filter((t) => !args.category || t.category === args.category)
        .filter((t) => !args.kind || t.kind === args.kind)
        .filter((t) => !args.available_only || t.available === true)
        .filter(
          (t) =>
            !q ||
            [t.id, t.name, t.category, t.summary].some((s) =>
              String(s ?? "")
                .toLowerCase()
                .includes(q),
            ),
        )
        .map((t) => ({
          id: t.id,
          name: t.name,
          category: t.category,
          summary: t.summary,
          inputs: t.inputs,
          vram: t.vram,
          commercial: t.commercial,
          available: t.available ?? null,
          ...(t.unavailableReason
            ? { unavailable_reason: t.unavailableReason }
            : {}),
        }));
      return { count: rows.length, tools: rows };
    },

    async describe_tool(args = {}) {
      const id = str(args, "tool_id");
      const tool = findTool(await catalog(), id);
      if (!tool)
        throw new ToolError(`Unknown tool "${id}". Call list_tools for ids.`);
      const { inputSchema, unavailableReason, ...rest } = tool;
      return {
        ...rest,
        ...(unavailableReason ? { unavailable_reason: unavailableReason } : {}),
        input_schema: inputSchema,
      };
    },

    async run_tool(args = {}) {
      const id = str(args, "tool_id");
      const inputs = args.inputs ?? {};
      if (typeof inputs !== "object" || Array.isArray(inputs))
        throw new ToolError('"inputs" must be an object');
      const tool = findTool(await catalog(), id);
      if (!tool)
        throw new ToolError(`Unknown tool "${id}". Call list_tools for ids.`);
      if (tool.available === false)
        throw new ToolError(
          `${tool.name} is not available on this server: ${tool.unavailableReason ?? "not installed"}`,
        );
      checkInputs(tool.inputSchema, inputs);
      const data =
        tool.kind === "catalog"
          ? await runCatalog(tool, inputs)
          : await runAction(tool, inputs);
      if (!data.run) throw new ToolError("Adrift returned no run");
      return {
        tool_id: tool.id,
        ...remember(runSummary(data.run)),
        ...(data.warnings ? { warnings: data.warnings } : {}),
      };
    },

    async generate_image(args = {}) {
      const prompt = str(args, "prompt");
      const data = await client.post("/api/jobs/imagine", {
        prompt,
        client_id: cid,
        ...(Number.isInteger(args.batch_size)
          ? { batch_size: args.batch_size }
          : {}),
        ...(typeof args.workflow_path === "string" && args.workflow_path
          ? { workflow_path: args.workflow_path }
          : {}),
      });
      const runs = (data.runs ?? []).map((r) => remember(runSummary(r)));
      return {
        runs,
        job_ids: runs.flatMap((r) => r.job_ids),
        ...(data.warnings ? { warnings: data.warnings } : {}),
      };
    },

    async job_status(args = {}) {
      const ids = [
        ...(typeof args.job_id === "string" && args.job_id
          ? [args.job_id]
          : []),
        ...(Array.isArray(args.job_ids)
          ? args.job_ids.filter((x) => typeof x === "string" && x)
          : []),
      ];
      if (!ids.length) throw new ToolError('Pass "job_id" or "job_ids"');
      if (ids.length > 50) throw new ToolError("At most 50 job ids");
      const st = await statuses(ids);
      return {
        jobs: ids.map((id) => ({
          job_id: id,
          state: st[id]?.state ?? "unknown",
          ...(st[id]?.error ? { error: st[id].error } : {}),
        })),
      };
    },

    async wait_for_job(args = {}) {
      const id = str(args, "job_id");
      const t = Number(args.timeout_seconds ?? 60);
      const timeout =
        Math.min(300, Math.max(1, Number.isFinite(t) ? t : 60)) * 1000;
      const start = Date.now();
      for (;;) {
        const s = (await statuses([id]))[id] ?? { state: "unknown" };
        if (["done", "error", "cancelled"].includes(s.state)) {
          const result = {
            job_id: id,
            state: s.state,
            ...(s.error ? { error: s.error } : {}),
          };
          if (s.state === "done") {
            result.outputs = await outputsFor(client, id);
            await syncRun(id);
          }
          return result;
        }
        if (s.state === "missing")
          return {
            job_id: id,
            state: s.state,
            error: "Adrift's ComfyUI does not know this job",
          };
        if (Date.now() - start + pollMs > timeout)
          return {
            job_id: id,
            state: s.state,
            timed_out: true,
            waited_seconds: Math.round((Date.now() - start) / 1000),
          };
        await sleep(pollMs);
      }
    },

    async get_outputs(args = {}) {
      const id = str(args, "job_id");
      const out = await outputsFor(client, id);
      if (out.ready) await syncRun(id);
      return {
        job_id: id,
        ...out,
        ...(out.ready
          ? {}
          : {
              note: "No history yet: the job is queued, running, or unknown.",
            }),
      };
    },

    async cancel_job(args = {}) {
      const id = str(args, "job_id");
      const data = await client.post("/api/jobs/cancel", { prompt_id: id });
      const { ok: _ok, request_id: _rid, ...rest } = data;
      return { job_id: id, ...rest };
    },
  };
}

// --- JSON-RPC -----------------------------------------------------------------

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function toolErrorResult(err) {
  const payload = {
    error: err.message,
    ...(err.details ? { details: err.details } : {}),
  };
  return {
    content: [{ type: "text", text: `Error: ${err.message}` }],
    structuredContent: payload,
    isError: true,
  };
}

export function createMcpServer({ handlers, log = () => {} }) {
  let initialized = false;

  async function dispatch(method, params) {
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        initialized = true;
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Drive Adrift (self-hosted ComfyUI studio). list_tools -> describe_tool -> run_tool (or generate_image) -> wait_for_job -> get_outputs. Output refs can be fed back as inputs.",
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: MCP_TOOLS };
      case "tools/call": {
        const name = params?.name;
        if (typeof name !== "string" || !MCP_TOOLS.some((t) => t.name === name))
          throw new RpcError(
            RPC.INVALID_PARAMS,
            `Unknown tool: ${String(name)}`,
          );
        const args = params?.arguments ?? {};
        if (typeof args !== "object" || Array.isArray(args))
          throw new RpcError(RPC.INVALID_PARAMS, "arguments must be an object");
        try {
          return toolResult(await handlers[name](args));
        } catch (e) {
          if (e instanceof ToolError) return toolErrorResult(e);
          log(`tool ${name} failed: ${e?.stack ?? e}`);
          return toolErrorResult(new ToolError(e?.message ?? String(e)));
        }
      }
      default:
        throw new RpcError(RPC.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  /** One parsed message -> a response object, or null for notifications. */
  async function handle(msg) {
    if (Array.isArray(msg)) {
      if (!msg.length)
        return {
          jsonrpc: "2.0",
          id: null,
          error: { code: RPC.INVALID_REQUEST, message: "Empty batch" },
        };
      const out = (await Promise.all(msg.map(handle))).filter(Boolean);
      return out.length ? out : null;
    }
    if (
      !msg ||
      typeof msg !== "object" ||
      msg.jsonrpc !== "2.0" ||
      typeof msg.method !== "string"
    ) {
      if (
        msg &&
        typeof msg === "object" &&
        msg.jsonrpc === "2.0" &&
        ("result" in msg || "error" in msg)
      )
        return null;
      return {
        jsonrpc: "2.0",
        id: msg && typeof msg === "object" && "id" in msg ? msg.id : null,
        error: { code: RPC.INVALID_REQUEST, message: "Invalid Request" },
      };
    }
    const isNotification = !("id" in msg);
    if (isNotification) {
      if (msg.method === "notifications/initialized") log("client initialized");
      return null;
    }
    try {
      if (!initialized && msg.method !== "initialize" && msg.method !== "ping")
        log(`${msg.method} before initialize`);
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: await dispatch(msg.method, msg.params),
      };
    } catch (e) {
      const code = e instanceof RpcError ? e.code : RPC.INTERNAL_ERROR;
      if (!(e instanceof RpcError)) log(`internal error: ${e?.stack ?? e}`);
      return {
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code,
          message: e?.message ?? "Internal error",
          ...(e?.data ? { data: e.data } : {}),
        },
      };
    }
  }

  /** Raw line from stdin -> serialized response line, or null. */
  async function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: RPC.PARSE_ERROR, message: "Parse error" },
      });
    }
    const res = await handle(msg);
    return res ? JSON.stringify(res) : null;
  }

  return { handle, handleLine };
}

/** Serve newline-delimited JSON-RPC on stdin/stdout; logs go to stderr. */
export function serveStdio({
  input = process.stdin,
  output = process.stdout,
  server,
}) {
  let buf = "";
  let pending = 0;
  let ended = false;
  const write = (line) => {
    if (line) output.write(`${line}\n`);
  };
  const finish = () => {
    if (ended && pending === 0) process.exit(0);
  };
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      pending += 1;
      server
        .handleLine(line)
        .then(write)
        .finally(() => {
          pending -= 1;
          finish();
        });
    }
  });
  input.on("end", () => {
    ended = true;
    if (buf.trim()) {
      pending += 1;
      server
        .handleLine(buf)
        .then(write)
        .finally(() => {
          pending -= 1;
          finish();
        });
      buf = "";
    }
    finish();
  });
}
