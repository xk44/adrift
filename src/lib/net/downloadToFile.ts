/**
 * Stream a remote file to disk with the guards model downloads need:
 *
 * - every redirect hop is followed by hand, must be https and must pass
 *   `allowHost` (so a redirect can't bounce us to an internal address);
 * - request headers are computed per hop, so an API key sent to the origin
 *   is never forwarded to a CDN;
 * - a byte ceiling (Content-Length up front, then a running count);
 * - an idle timeout that resets on every chunk instead of a fixed total
 *   timeout (a 20 GB file on a slow link is fine; a stalled one is not);
 * - an optional byte range that must come back as 206;
 * - writes to `dest` with the exclusive 'wx' flag and removes it on failure.
 *
 * Server-side only.
 */
import { createHash } from "crypto";
import { open, unlink } from "fs/promises";

export type DownloadErrorCode =
  | "auth"
  | "host"
  | "too_large"
  | "idle"
  | "http"
  | "range_ignored"
  | "aborted"
  | "redirects";

export class DownloadError extends Error {
  constructor(
    public readonly code: DownloadErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "DownloadError";
  }
}

export interface DownloadOptions {
  url: string;
  /** File to create. Must not exist yet (opened with 'wx'). */
  dest: string;
  allowHost: (hostname: string) => boolean;
  headersFor?: (url: URL) => Record<string, string>;
  maxBytes: number;
  /** Abort when no bytes arrive for this long. Default 60 s. */
  idleMs?: number;
  /** Inclusive byte range; the server must answer 206. */
  range?: { start: number; end: number };
  signal?: AbortSignal;
  /** Called with the number of new bytes after each chunk is written. */
  onBytes?: (delta: number) => void;
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
}

export interface DownloadResult {
  bytes: number;
  /** Uppercase hex SHA-256 of what was written. */
  sha256: string;
  /** Final URL after redirects. */
  finalUrl: string;
}

export const DEFAULT_IDLE_MS = 60_000;

/** host === domain, or a subdomain of it. */
export function hostMatches(
  hostname: string,
  domains: readonly string[],
): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

export async function downloadToFile(
  opts: DownloadOptions,
): Promise<DownloadResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const maxRedirects = opts.maxRedirects ?? 5;

  const controller = new AbortController();
  let idleFired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      idleFired = true;
      controller.abort();
    }, idleMs);
  };
  const onExternalAbort = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const fail = (err: unknown): never => {
    if (err instanceof DownloadError) throw err;
    if (idleFired) {
      throw new DownloadError(
        "idle",
        `No data received for ${Math.round(idleMs / 1000)} s`,
      );
    }
    if (controller.signal.aborted)
      throw new DownloadError("aborted", "Download cancelled");
    throw err;
  };

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let created = false;
  try {
    armIdle();
    let url = new URL(opts.url);
    let response: Response | null = null;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (url.protocol !== "https:") {
        throw new DownloadError(
          "host",
          `Refusing non-https URL (${url.protocol})`,
        );
      }
      if (!opts.allowHost(url.hostname)) {
        throw new DownloadError("host", `Host not allowed: ${url.hostname}`);
      }
      const headers: Record<string, string> = {
        ...(opts.headersFor?.(url) ?? {}),
      };
      if (opts.range)
        headers.Range = `bytes=${opts.range.start}-${opts.range.end}`;
      const res = await fetchImpl(url.toString(), {
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!location)
          throw new DownloadError(
            "http",
            `Redirect without location`,
            res.status,
          );
        url = new URL(location, url);
        continue;
      }
      response = res;
      break;
    }
    if (!response) throw new DownloadError("redirects", "Too many redirects");

    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      throw new DownloadError(
        "auth",
        "The server needs a login or API key",
        response.status,
      );
    }
    if (opts.range) {
      if (response.status !== 206) {
        await response.body?.cancel().catch(() => {});
        if (response.ok) {
          throw new DownloadError(
            "range_ignored",
            "Server ignored the byte range",
            response.status,
          );
        }
        throw new DownloadError(
          "http",
          `Download failed (${response.status})`,
          response.status,
        );
      }
    } else if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new DownloadError(
        "http",
        `Download failed (${response.status})`,
        response.status,
      );
    }
    if (!response.body)
      throw new DownloadError("http", "Empty response", response.status);

    const expected = opts.range ? opts.range.end - opts.range.start + 1 : null;
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      await response.body.cancel().catch(() => {});
      throw new DownloadError(
        "too_large",
        `File is larger than the ${opts.maxBytes} byte limit`,
      );
    }

    handle = await open(opts.dest, "wx");
    created = true;
    const hash = createHash("sha256");
    const reader = response.body.getReader();
    let bytes = 0;
    for (;;) {
      armIdle();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      bytes += value.byteLength;
      if (bytes > opts.maxBytes || (expected !== null && bytes > expected)) {
        await reader.cancel().catch(() => {});
        throw new DownloadError(
          "too_large",
          `File is larger than the ${opts.maxBytes} byte limit`,
        );
      }
      await handle.write(value);
      hash.update(value);
      opts.onBytes?.(value.byteLength);
    }
    if (expected !== null && bytes !== expected) {
      throw new DownloadError(
        "http",
        `Range returned ${bytes} bytes, expected ${expected}`,
      );
    }
    await handle.close();
    handle = null;
    return {
      bytes,
      sha256: hash.digest("hex").toUpperCase(),
      finalUrl: url.toString(),
    };
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    handle = null;
    if (created) await unlink(opts.dest).catch(() => {});
    return fail(err);
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }
}
