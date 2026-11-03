/**
 * Test a ComfyUI address for the first-run wizard: GET /system_stats and
 * /object_info, report version, GPU, memory and node count.
 *
 * Deliberately a plain fetch, NOT src/lib/net/safeFetch.ts: safeFetch blocks
 * loopback / private addresses (it guards user-supplied URLs such as image
 * imports), but the ComfyUI address is a trusted admin setting that is
 * usually exactly such an address. Only the settings routes (loopback or
 * ADMIN_API_KEY) can reach this, only these two read-only GETs are sent,
 * redirects are not followed (a redirect could carry the token elsewhere) and
 * only parsed fields are returned, never the raw bodies.
 *
 * Server-side only (it may send the bearer token).
 */
import {
  profileFromSystemStats,
  type BackendProfile,
} from "@/lib/models/compat";

export interface ProbeOk {
  ok: true;
  url: string;
  comfyuiVersion: string | null;
  gpuName: string;
  deviceType: string;
  memoryGb: number;
  unified: boolean;
  nodeCount: number | null;
  profile: BackendProfile | null;
}

export interface ProbeFail {
  ok: false;
  url: string;
  /** Plain-language reason for the wizard. */
  error: string;
  code: "unreachable" | "timeout" | "auth" | "not_comfy" | "redirect" | "http";
}

export type ProbeResult = ProbeOk | ProbeFail;

const STATS_TIMEOUT_MS = 4000;
const OBJECT_INFO_TIMEOUT_MS = 10_000;

function fail(url: string, code: ProbeFail["code"], error: string): ProbeFail {
  return { ok: false, url, code, error };
}

function describeError(url: string, e: unknown): ProbeFail {
  const name = (e as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError")
    return fail(
      url,
      "timeout",
      "No answer within a few seconds. Check the address and that ComfyUI is running.",
    );
  const hint = networkHint(e);
  return fail(
    url,
    "unreachable",
    hint ??
      "Nothing answered at that address. Is ComfyUI running, and (for another computer) started with --listen?",
  );
}

/** Node's fetch wraps the socket error in `cause`; its code says what went wrong. */
function errorCode(e: unknown): string {
  const cause = (e as { cause?: { code?: unknown; cause?: { code?: unknown } } })
    ?.cause;
  const code = cause?.code ?? cause?.cause?.code;
  return typeof code === "string" ? code : "";
}

/** One plain, actionable sentence per common network failure. */
function networkHint(e: unknown): string | null {
  const code = errorCode(e);
  if (!code) return null;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return "That computer name wasn't found. Check the spelling, or use its IP address instead.";
  if (code === "ECONNREFUSED")
    return "The computer is there, but nothing is listening on that port. Start ComfyUI (with --listen if it's another computer) and check the port number.";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH")
    return "Can't reach that computer. Make sure it's on and on the same network, or check the address.";
  if (/CERT|SELF_SIGNED|TLS|SSL/i.test(code))
    return "The secure (https) certificate isn't trusted. Use a valid certificate, or http:// on your own network.";
  if (code === "ECONNRESET" || code === "EPROTO")
    return "The connection was cut off. If the address starts with https://, try http:// instead.";
  return null;
}

/**
 * Shown when neither local port answered: ComfyUI isn't running here, or uses
 * a different port.
 */
export function localProbeFailure(last: ProbeResult): ProbeResult {
  if (last.ok || (last.code !== "unreachable" && last.code !== "timeout"))
    return last;
  return {
    ...last,
    error:
      "ComfyUI isn't answering on this computer (tried ports 8188 and 8000). If yours uses another port, enter it under \"I know what I'm doing\".",
  };
}

export async function probeComfy(
  url: string,
  token?: string | null,
  fetchImpl: typeof fetch = fetch,
  opts: { nodes?: boolean } = {},
): Promise<ProbeResult> {
  const base = url.replace(/\/+$/, "");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const get = (p: string, ms: number) =>
    fetchImpl(`${base}${p}`, {
      headers,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(ms),
    });

  let stats: unknown;
  try {
    const res = await get("/system_stats", STATS_TIMEOUT_MS);
    if (res.status >= 300 && res.status < 400)
      return fail(
        base,
        "redirect",
        "That address redirects somewhere else. Enter the final address instead.",
      );
    if (res.status === 401 || res.status === 403)
      return fail(
        base,
        "auth",
        token
          ? "ComfyUI (or the proxy in front of it) refused the token."
          : "It needs a login. Add the access token, or open it up for this computer.",
      );
    if (!res.ok)
      return fail(
        base,
        "http",
        `It answered with an error (HTTP ${res.status}).`,
      );
    stats = await res.json();
  } catch (e) {
    if (e instanceof SyntaxError)
      return fail(
        base,
        "not_comfy",
        "Something answered, but it isn't ComfyUI.",
      );
    return describeError(base, e);
  }
  const profile = profileFromSystemStats(stats);
  const sys = ((stats as Record<string, unknown>)?.system ?? null) as Record<
    string,
    unknown
  > | null;
  if (!sys || typeof sys !== "object")
    return fail(base, "not_comfy", "Something answered, but it isn't ComfyUI.");

  let nodeCount: number | null = null;
  if (opts.nodes !== false) {
    try {
      const res = await get("/object_info", OBJECT_INFO_TIMEOUT_MS);
      if (res.ok) {
        const info = (await res.json()) as unknown;
        if (info && typeof info === "object")
          nodeCount = Object.keys(info).length;
      }
    } catch {
      nodeCount = null; // stats answered; a slow object_info is not fatal
    }
  }

  return {
    ok: true,
    url: base,
    comfyuiVersion:
      typeof sys.comfyui_version === "string" ? sys.comfyui_version : null,
    gpuName: profile?.displayName ?? "Unknown device",
    deviceType: profile?.device ?? "unknown",
    memoryGb: profile ? Math.round(profile.memoryTotalBytes / 1024 ** 3) : 0,
    unified: profile?.unified ?? false,
    nodeCount,
    profile,
  };
}

/**
 * "This computer": probe each local candidate in order; the first that
 * answers wins. When none does, report the failure that says the most: one
 * where something answered (wrong program, login, HTTP error) beats "nothing
 * answered", and otherwise the first candidate (ComfyUI's usual :8188), so
 * the wizard does not talk about :8000 to someone who never ran Desktop.
 */
export async function probeLocalCandidates(
  urls: readonly string[],
  probe: (url: string) => Promise<ProbeResult> = (u) => probeComfy(u, null),
): Promise<ProbeResult | null> {
  const fails: ProbeFail[] = [];
  for (const url of urls) {
    const r = await probe(url);
    if (r.ok) return r;
    fails.push(r);
  }
  const silent = (f: ProbeFail) =>
    f.code === "unreachable" || f.code === "timeout";
  return fails.find((f) => !silent(f)) ?? fails[0] ?? null;
}
