/**
 * Judge mode, Node side: token verification (node:crypto timingSafeEqual),
 * per-judge state (quota, owned files / runs / prompts, outputs), the single
 * GPU slot with a FIFO "queued" state, the pause switch, and withJudge(), the
 * wrapper the allowlisted API routes export. See lib/judge/judgePolicy.ts.
 *
 * Outside judge mode withJudge() calls the route handler unchanged.
 */
import { createHash, timingSafeEqual } from "crypto";
import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import {
  JUDGE_COOKIE,
  checkJudgeUpload,
  collectBodyRefs,
  cookieValue,
  fileKey,
  fileKeyFromRef,
  fileKeyFromViewUrl,
  isJudgeMode,
  judgeActionCost,
  judgeLeaseMs,
  judgeQuota,
  judgeRouteKind,
  judgeTokens,
  judgeToolCost,
  judgeUploadMaxBytes,
  type JudgeRouteKind,
} from "./judgePolicy";

// Tokens

function digest(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

/** Stable, non-reversible judge id (state file never holds tokens). */
export function judgeIdFor(token: string): string {
  return createHash("sha256")
    .update(`adrift-judge:${token}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * The judge id for a token, or null. timingSafeEqual over SHA-256 digests
 * (fixed length, so the token length never leaks), every token compared.
 */
export function verifyJudgeToken(candidate: string): string | null {
  if (!candidate || candidate.length > 256) return null;
  const want = digest(candidate);
  let match: string | null = null;
  for (const t of judgeTokens()) {
    if (timingSafeEqual(want, digest(t))) match = t;
  }
  return match ? judgeIdFor(match) : null;
}

/** The judge behind a request (its httpOnly cookie), or null. */
export function judgeFromRequest(req: Request): string | null {
  return verifyJudgeToken(cookieValue(req.headers.get("cookie"), JUDGE_COOKIE));
}

/**
 * requireAdmin() in judge mode: a valid judge cookie AND an allowlisted
 * route. The admin key and session cookies are not accepted here.
 */
export function judgeAuth(
  req: NextRequest,
): { ok: true } | { ok: false; response: NextResponse } {
  if (!judgeFromRequest(req)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          error: "This preview needs the link from the judging form.",
        },
        { status: 401 },
      ),
    };
  }
  if (!judgeRouteKind(req.nextUrl.pathname, req.method || "GET")) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "Not found" },
        { status: 404 },
      ),
    };
  }
  return { ok: true };
}

// State

export interface JudgeOutput {
  url: string;
  kind: "image" | "video" | "audio" | "mesh";
  promptId: string;
  at: number;
}

interface JudgeRecord {
  used: number;
  files: string[];
  runs: string[];
  prompts: string[];
  outputs: JudgeOutput[];
}

interface Lease {
  judgeId: string;
  promptIds: string[];
  startedAt: number;
}

interface Waiter {
  judgeId: string;
  lastSeen: number;
}

interface JudgeState {
  judges: Record<string, JudgeRecord>;
  lease: Lease | null;
  waiters: Waiter[];
  loadedFrom: string | null;
}

const MAX_LIST = 2000;
/** A waiter that stopped retrying for this long loses its place. */
const WAITER_STALE_MS = 45_000;
/** Client retry hint while queued. */
export const QUEUE_RETRY_S = 5;

const g = globalThis as { __adriftJudge?: JudgeState };

function statePath(): string | null {
  const raw = process.env.ADRIFT_JUDGE_STATE_FILE?.trim();
  if (raw === "off") return null;
  return raw || path.join(process.cwd(), "data", "judge_state.json");
}

function state(): JudgeState {
  const file = statePath();
  if (g.__adriftJudge && g.__adriftJudge.loadedFrom === file)
    return g.__adriftJudge;
  const s: JudgeState = {
    judges: {},
    lease: null,
    waiters: [],
    loadedFrom: file,
  };
  if (file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
        judges?: Record<string, JudgeRecord>;
      };
      for (const [id, r] of Object.entries(parsed.judges ?? {})) {
        s.judges[id] = {
          used: Number(r.used) || 0,
          files: Array.isArray(r.files) ? r.files : [],
          runs: Array.isArray(r.runs) ? r.runs : [],
          prompts: Array.isArray(r.prompts) ? r.prompts : [],
          outputs: Array.isArray(r.outputs) ? r.outputs : [],
        };
      }
    } catch {
      /* first run or unreadable: start empty */
    }
  }
  g.__adriftJudge = s;
  return s;
}

function save(): void {
  const s = state();
  if (!s.loadedFrom) return;
  try {
    fs.mkdirSync(path.dirname(s.loadedFrom), { recursive: true });
    const tmp = `${s.loadedFrom}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ judges: s.judges }), {
      mode: 0o600,
    });
    fs.renameSync(tmp, s.loadedFrom);
  } catch (e) {
    console.warn("[judge] could not save state:", e);
  }
}

function record(judgeId: string): JudgeRecord {
  const s = state();
  return (s.judges[judgeId] ??= {
    used: 0,
    files: [],
    runs: [],
    prompts: [],
    outputs: [],
  });
}

function pushCapped<T>(list: T[], value: T): void {
  if (list.includes(value)) return;
  list.push(value);
  if (list.length > MAX_LIST) list.splice(0, list.length - MAX_LIST);
}

/** Test hook: forget everything (and re-read the state file next call). */
export function resetJudgeState(): void {
  delete g.__adriftJudge;
}

export function judgeUsage(judgeId: string): { used: number; quota: number } {
  return { used: record(judgeId).used, quota: judgeQuota() };
}

export function ownsFile(judgeId: string, key: string): boolean {
  return record(judgeId).files.includes(key);
}

export function ownsRun(judgeId: string, runId: string): boolean {
  return record(judgeId).runs.includes(runId);
}

export function ownsPrompt(judgeId: string, promptId: string): boolean {
  return record(judgeId).prompts.includes(promptId);
}

export function judgeOutputs(judgeId: string): JudgeOutput[] {
  return [...record(judgeId).outputs].reverse();
}

// GPU slot (global concurrency 1, FIFO)

export type SlotResult =
  { ok: true } | { ok: false; position: number; retryAfterS: number };

/** Optional probe: true once ComfyUI has finished (or forgotten) a prompt. */
type DoneProbe = (promptIds: string[]) => Promise<boolean>;
let doneProbe: DoneProbe | null = defaultDoneProbe;

async function defaultDoneProbe(promptIds: string[]): Promise<boolean> {
  try {
    const { fetchHistory } = await import("@/lib/comfy/http");
    const { fetchHistoryAnyBackend } = await import("@/lib/comfy/warmBackend");
    for (const id of promptIds) {
      if (!(await fetchHistoryAnyBackend(fetchHistory, id))) return false;
    }
    return promptIds.length > 0;
  } catch {
    return false;
  }
}

/** Test hook: replace (or disable with null) the completion probe. */
export function setJudgeDoneProbe(probe: DoneProbe | null): void {
  doneProbe = probe;
}

/** Ask for the GPU slot; queued judges keep their place while retrying. */
export async function acquireSlot(
  judgeId: string,
  now = Date.now(),
): Promise<SlotResult> {
  const s = state();
  if (s.lease && now - s.lease.startedAt > judgeLeaseMs()) s.lease = null;
  if (s.lease && s.lease.promptIds.length > 0 && doneProbe) {
    if (await doneProbe(s.lease.promptIds)) s.lease = null;
  }
  s.waiters = s.waiters.filter(
    (w) => w.judgeId === judgeId || now - w.lastSeen <= WAITER_STALE_MS,
  );
  const idx = s.waiters.findIndex((w) => w.judgeId === judgeId);
  if (!s.lease && (s.waiters.length === 0 || idx === 0)) {
    if (idx === 0) s.waiters.shift();
    s.lease = { judgeId, promptIds: [], startedAt: now };
    return { ok: true };
  }
  if (idx < 0) s.waiters.push({ judgeId, lastSeen: now });
  else s.waiters[idx].lastSeen = now;
  const position = s.waiters.findIndex((w) => w.judgeId === judgeId) + 1;
  return { ok: false, position, retryAfterS: QUEUE_RETRY_S };
}

/** Give the slot back (failed submit, finished run). */
export function releaseSlot(judgeId: string): void {
  const s = state();
  if (s.lease?.judgeId === judgeId) s.lease = null;
}

function attachPrompts(judgeId: string, promptIds: string[]): void {
  const s = state();
  if (s.lease?.judgeId !== judgeId) return;
  if (promptIds.length === 0) s.lease = null;
  else s.lease.promptIds = promptIds;
}

/** A prompt finished (its history arrived): free the slot if it held it. */
function promptFinished(promptId: string): void {
  const s = state();
  if (s.lease?.promptIds.includes(promptId)) s.lease = null;
}

export function queueSnapshot(judgeId: string): {
  busy: boolean;
  mine: boolean;
  position: number;
} {
  const s = state();
  const idx = s.waiters.findIndex((w) => w.judgeId === judgeId);
  return {
    busy: Boolean(s.lease),
    mine: s.lease?.judgeId === judgeId,
    position: idx < 0 ? 0 : idx + 1,
  };
}

// Pause switch (the owner takes the GPU back without stopping the tunnel)

export function judgePauseFile(): string {
  return (
    process.env.ADRIFT_JUDGE_PAUSE_FILE?.trim() ||
    path.join(process.cwd(), "data", "judge_paused")
  );
}

export function judgePaused(): boolean {
  try {
    return fs.existsSync(judgePauseFile());
  } catch {
    return false;
  }
}

// withJudge

type Handler<C> = (req: NextRequest, ctx: C) => Promise<Response> | Response;

function deny(
  error: string,
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
): NextResponse {
  return NextResponse.json(
    { ok: false, error, details: { code, ...extra } },
    {
      status,
      headers:
        typeof extra.retry_after_s === "number"
          ? { "Retry-After": String(extra.retry_after_s) }
          : undefined,
    },
  );
}

const NOT_FOUND = () => deny("Not found", 404, "judge_not_found");

async function readJsonClone(req: NextRequest): Promise<unknown> {
  try {
    return await req.clone().json();
  } catch {
    return undefined;
  }
}

async function responseJson(
  res: Response,
): Promise<Record<string, unknown> | null> {
  if (!res.ok) return null;
  try {
    const data = (await res.clone().json()) as Record<string, unknown>;
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/** Refs in a body that this judge does not own (first one), or null. */
function foreignRef(judgeId: string, body: unknown): string | null {
  const refs = collectBodyRefs(body);
  for (const f of refs.files) if (!ownsFile(judgeId, f)) return f;
  for (const r of refs.runIds) if (!ownsRun(judgeId, r)) return `run ${r}`;
  for (const p of refs.promptIds)
    if (!ownsPrompt(judgeId, p)) return `prompt ${p}`;
  return null;
}

/**
 * Job-body fields a judge may not set: custom workflow files / control
 * overrides / graph export, and any pack id that isn't a plain shipped-pack
 * id (packs are the repo's own public/workflows/packs graphs).
 */
export function forbiddenField(body: Record<string, unknown>): string | null {
  const params =
    body.params && typeof body.params === "object"
      ? (body.params as Record<string, unknown>)
      : {};
  for (const k of ["workflow_path", "workflow_control_overrides"]) {
    if (body[k] !== undefined || params[k] !== undefined) return k;
  }
  if (body.dry_run !== undefined && body.dry_run !== false) return "dry_run";
  for (const [k, v] of [
    ["pack_id", body.pack_id],
    ["pack_id", params.pack_id],
    ["packId", params.packId],
  ] as const) {
    if (v === undefined || v === "") continue;
    if (typeof v !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(v))
      return k;
  }
  return null;
}

interface RunLike {
  run_id?: unknown;
  jobs?: { prompt_id?: unknown }[];
}

function recordRun(judgeId: string, run: RunLike | undefined): string[] {
  const r = record(judgeId);
  if (typeof run?.run_id === "string") pushCapped(r.runs, run.run_id);
  const prompts: string[] = [];
  for (const j of run?.jobs ?? []) {
    if (typeof j?.prompt_id === "string" && j.prompt_id) {
      pushCapped(r.prompts, j.prompt_id);
      prompts.push(j.prompt_id);
    }
  }
  return prompts;
}

const OUTPUT_GROUPS = [
  ["images", "image"],
  ["videos", "video"],
  ["audios", "audio"],
  ["meshes", "mesh"],
] as const;

function recordHistory(
  judgeId: string,
  promptId: string,
  data: Record<string, unknown>,
): void {
  const r = record(judgeId);
  const now = Date.now();
  for (const [group, kind] of OUTPUT_GROUPS) {
    const list = data[group];
    if (!Array.isArray(list)) continue;
    for (const f of list as Record<string, unknown>[]) {
      if (typeof f?.filename !== "string") continue;
      pushCapped(
        r.files,
        fileKey(
          typeof f.type === "string" ? f.type : "output",
          typeof f.subfolder === "string" ? f.subfolder : "",
          f.filename,
        ),
      );
      if (
        typeof f.url === "string" &&
        !r.outputs.some((o) => o.url === f.url)
      ) {
        r.outputs.push({ url: f.url, kind, promptId, at: now });
        if (r.outputs.length > MAX_LIST) r.outputs.shift();
      }
    }
  }
  // Generic list too (meshes without a group url, etc.).
  if (Array.isArray(data.outputs)) {
    for (const o of data.outputs as Record<string, unknown>[]) {
      if (typeof o?.url !== "string") continue;
      const key = fileKeyFromViewUrl(o.url);
      if (key) pushCapped(r.files, key);
    }
  }
}

/** Submit gate shared by action/tool: pause, quota, GPU slot. */
async function submitGate(
  judgeId: string,
  cost: number,
): Promise<NextResponse | null> {
  if (judgePaused())
    return deny(
      "The preview is paused for a moment. Please try again in a few minutes.",
      503,
      "judge_paused",
      { retry_after_s: 60 },
    );
  const { used, quota } = judgeUsage(judgeId);
  if (used + cost > quota)
    return deny(
      `You've used all ${quota} runs for this preview. Thank you for judging!`,
      429,
      "judge_quota",
      { used, quota },
    );
  const slot = await acquireSlot(judgeId);
  if (!slot.ok)
    return deny(
      `Queued: another run is rendering. You're number ${slot.position} in line; it starts automatically.`,
      429,
      "judge_queued",
      { position: slot.position, retry_after_s: slot.retryAfterS },
    );
  return null;
}

/**
 * Wrap a route handler with the judge-mode checks for its kind. A no-op
 * outside judge mode, so routes can export `withJudge("action", POST)`.
 */
export function withJudge<C>(kind: JudgeRouteKind, handler: Handler<C>) {
  return async (req: NextRequest, ctxArg?: C): Promise<Response> => {
    const ctx = ctxArg as C;
    if (!isJudgeMode()) return handler(req, ctx);

    const judgeId = judgeFromRequest(req);
    if (!judgeId)
      return deny(
        "This preview needs the link from the judging form.",
        401,
        "judge_token",
      );
    if (judgeRouteKind(req.nextUrl.pathname, req.method || "GET") !== kind)
      return NOT_FOUND();

    switch (kind) {
      case "open":
      case "status":
        return handler(req, ctx);

      case "image": {
        const sp = req.nextUrl.searchParams;
        const filename = sp.get("filename") ?? "";
        const key = fileKey(
          sp.get("type") || "output",
          sp.get("subfolder") || "",
          filename,
        );
        // 404, not 403: don't confirm that someone else's file exists.
        if (!filename || !ownsFile(judgeId, key)) return NOT_FOUND();
        return handler(req, ctx);
      }

      case "history": {
        const promptId = decodeURIComponent(
          req.nextUrl.pathname.split("/").pop() ?? "",
        );
        if (!ownsPrompt(judgeId, promptId)) return NOT_FOUND();
        const res = await handler(req, ctx);
        const data = await responseJson(res);
        if (data) {
          recordHistory(judgeId, promptId, data);
          promptFinished(promptId);
          save();
        }
        return res;
      }

      case "upload": {
        const len = Number(req.headers.get("content-length") || "0");
        const max = judgeUploadMaxBytes();
        if (len > Math.ceil(max * 1.4) + 4096)
          return deny(
            `Uploads are limited to ${Math.round(max / (1024 * 1024))} MB in this preview.`,
            413,
            "judge_upload_size",
          );
        const body = (await readJsonClone(req)) as
          { image?: unknown; subfolder?: unknown } | undefined;
        if (!body) return deny("Invalid JSON body", 400, "judge_bad_body");
        if (body.subfolder !== undefined && body.subfolder !== "")
          return deny("subfolder not allowed", 400, "judge_upload_subfolder");
        const check = checkJudgeUpload(body.image, max);
        if (!check.ok)
          return deny(check.error, check.status, "judge_upload_type");
        const res = await handler(req, ctx);
        const data = await responseJson(res);
        const key =
          typeof data?.ref === "string" ? fileKeyFromRef(data.ref) : null;
        if (key) {
          pushCapped(record(judgeId).files, key);
          save();
        }
        return res;
      }

      case "seed": {
        const body = await readJsonClone(req);
        if (body === undefined)
          return deny("Invalid JSON body", 400, "judge_bad_body");
        const foreign = foreignRef(judgeId, body);
        if (foreign)
          return deny("That file isn't available.", 403, "judge_not_owned");
        const res = await handler(req, ctx);
        const data = await responseJson(res);
        if (data?.run) {
          recordRun(judgeId, data.run as RunLike);
          save();
        }
        return res;
      }

      case "cancel": {
        const body = (await readJsonClone(req)) as
          Record<string, unknown> | undefined;
        const refs = collectBodyRefs(body ?? {});
        if (
          refs.promptIds.length === 0 ||
          refs.promptIds.some((p) => !ownsPrompt(judgeId, p))
        )
          return NOT_FOUND();
        return handler(req, ctx);
      }

      case "action":
      case "tool": {
        const body = (await readJsonClone(req)) as
          Record<string, unknown> | undefined;
        if (!body || typeof body !== "object")
          return deny("Invalid JSON body", 400, "judge_bad_body");
        const cost =
          kind === "action"
            ? judgeActionCost(body.action)
            : judgeToolCost(body.toolId);
        if (cost === null)
          return deny(
            "That tool isn't part of this preview.",
            403,
            "judge_tool",
          );
        const bad = forbiddenField(body);
        if (bad)
          return deny(
            `${bad} isn't available in this preview.`,
            403,
            "judge_field",
          );
        const foreign = foreignRef(judgeId, body);
        if (foreign)
          return deny("That file isn't available.", 403, "judge_not_owned");

        const gate = await submitGate(judgeId, cost);
        if (gate) return gate;
        let res: Response;
        try {
          res = await handler(req, ctx);
        } catch (e) {
          releaseSlot(judgeId);
          throw e;
        }
        const data = await responseJson(res);
        const run = data?.run as RunLike | undefined;
        if (!data || !run) {
          releaseSlot(judgeId);
          return res;
        }
        const prompts = recordRun(judgeId, run);
        record(judgeId).used += cost;
        attachPrompts(judgeId, prompts);
        save();
        return res;
      }
    }
  };
}
