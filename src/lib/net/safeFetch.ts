/**
 * SSRF-safe GET for user-supplied URLs (moodboard images, style refs, ...).
 *
 * - http(s) only; no credentials in the URL
 * - the hostname is checked before connecting, and every address DNS returns
 *   is checked again at connect time (the socket's `lookup` hook), so
 *   nip.io-style names and DNS rebinding cannot reach loopback, private,
 *   link-local or cloud-metadata addresses
 * - redirects are followed manually (max 3) and each hop is re-checked
 * - the body is read with a hard byte cap, plus total and idle timeouts
 *
 * `allowHosts` lists base URLs whose exact host:port skips the address check
 * (the configured ComfyUI / StyleVault). Nothing else is trusted.
 */
import dns from "dns";
import http from "http";
import https from "https";
import type { LookupFunction } from "net";
import {
  isBlockedAddress,
  isBlockedHostname,
  isIpLiteral,
} from "@/lib/net/addressPolicy";

export const SAFE_FETCH_DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

export type SafeFetchErrorCode =
  | "bad_url"
  | "blocked"
  | "too_many_redirects"
  | "too_large"
  | "timeout"
  | "http_error"
  | "network";

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export type DnsResolver = (
  hostname: string,
) => Promise<{ address: string; family: number }[]>;

export interface SafeFetchOptions {
  /** Hard cap on body bytes (default 20 MB). */
  maxBytes?: number;
  /** Whole-request budget incl. redirects (default 30 s). */
  timeoutMs?: number;
  /** Max time without receiving data (default 15 s). */
  idleTimeoutMs?: number;
  /** Redirect hops to follow (default 3). */
  maxRedirects?: number;
  /** Base URLs whose exact host:port may be private (configured backends). */
  allowHosts?: string[];
  headers?: Record<string, string>;
  /** Test hook: replaces dns.lookup. */
  resolve?: DnsResolver;
}

export interface SafeFetchResult {
  bytes: Buffer;
  contentType: string;
  status: number;
  /** Final URL after redirects. */
  url: string;
}

const defaultResolve: DnsResolver = (hostname) =>
  new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true }, (err, addrs) =>
      err ? reject(err) : resolve(addrs),
    );
  });

function trustedHosts(allowHosts: string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const base of allowHosts ?? []) {
    try {
      out.add(new URL(base).host.toLowerCase());
    } catch {
      /* ignore malformed base */
    }
  }
  return out;
}

/** True when `url` is on the exact host:port of one of `bases`. */
export function isConfiguredBackendUrl(url: string | URL, bases: string[]): boolean {
  try {
    return trustedHosts(bases).has(new URL(String(url)).host.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Validate a URL for an outbound fetch without touching the network.
 * Throws SafeFetchError("bad_url" | "blocked").
 */
export function checkFetchUrl(raw: string | URL, allowHosts?: string[]): URL {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new SafeFetchError("bad_url", "Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError("bad_url", "Only http(s) URLs can be fetched");
  }
  if (url.username || url.password) {
    throw new SafeFetchError(
      "bad_url",
      "URLs with credentials are not allowed",
    );
  }
  if (trustedHosts(allowHosts).has(url.host.toLowerCase())) return url;
  if (isBlockedHostname(url.hostname)) {
    throw new SafeFetchError(
      "blocked",
      "That address is private or local and can't be fetched",
    );
  }
  return url;
}

/** socket `lookup` that refuses blocked addresses (runs on every connect). */
function guardedLookup(resolve: DnsResolver): LookupFunction {
  return ((
    hostname: string,
    options: dns.LookupOptions,
    callback: (...args: unknown[]) => void,
  ) => {
    resolve(hostname).then(
      (addrs) => {
        if (!addrs.length) {
          callback(
            Object.assign(new Error(`No address for ${hostname}`), {
              code: "ENOTFOUND",
            }),
          );
          return;
        }
        if (addrs.some((a) => isBlockedAddress(a.address))) {
          callback(
            new SafeFetchError(
              "blocked",
              "That address is private or local and can't be fetched",
            ),
          );
          return;
        }
        const wanted = options?.family
          ? addrs.filter((a) => a.family === options.family)
          : addrs;
        const list = wanted.length ? wanted : addrs;
        if (options?.all) callback(null, list);
        else callback(null, list[0].address, list[0].family);
      },
      (err) => callback(err),
    );
  }) as LookupFunction;
}

interface Hop {
  status: number;
  headers: http.IncomingHttpHeaders;
  res: http.IncomingMessage;
}

function requestOnce(
  url: URL,
  opts: SafeFetchOptions,
  trusted: boolean,
  signal: AbortSignal,
): Promise<Hop> {
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: "GET",
        headers: {
          "user-agent": "Adrift",
          accept: "*/*",
          "accept-encoding": "identity",
          ...(opts.headers ?? {}),
        },
        // IP literals skip lookup; checkFetchUrl already vetted them.
        ...(trusted || isIpLiteral(url.hostname)
          ? {}
          : { lookup: guardedLookup(opts.resolve ?? defaultResolve) }),
        signal,
      },
      (res) =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, res }),
    );
    req.on("error", reject);
    req.end();
  });
}

function readCapped(
  res: http.IncomingMessage,
  maxBytes: number,
  idleMs: number,
): Promise<Buffer> {
  const declared = Number(res.headers["content-length"] ?? 0);
  if (declared > maxBytes) {
    res.destroy();
    return Promise.reject(
      new SafeFetchError("too_large", "The file is too large"),
    );
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let idle: NodeJS.Timeout | undefined;
    const arm = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        res.destroy();
        reject(
          new SafeFetchError("timeout", "The server stopped sending data"),
        );
      }, idleMs);
    };
    arm();
    res.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        if (idle) clearTimeout(idle);
        res.destroy();
        reject(new SafeFetchError("too_large", "The file is too large"));
        return;
      }
      chunks.push(chunk);
      arm();
    });
    res.on("end", () => {
      if (idle) clearTimeout(idle);
      resolve(Buffer.concat(chunks, total));
    });
    res.on("error", (err) => {
      if (idle) clearTimeout(idle);
      reject(err);
    });
  });
}

/** GET a user-supplied URL with SSRF protection. Throws SafeFetchError. */
export async function safeFetchBytes(
  raw: string | URL,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxRedirects = opts.maxRedirects ?? 3;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  const trustedSet = trustedHosts(opts.allowHosts);
  try {
    let url = checkFetchUrl(raw, opts.allowHosts);
    for (let hop = 0; ; hop++) {
      let r: Hop;
      try {
        r = await requestOnce(
          url,
          opts,
          trustedSet.has(url.host.toLowerCase()),
          controller.signal,
        );
      } catch (err) {
        if (err instanceof SafeFetchError) throw err;
        if (controller.signal.aborted)
          throw new SafeFetchError("timeout", "The request timed out");
        throw new SafeFetchError(
          "network",
          err instanceof Error ? err.message : "Network error",
        );
      }
      if (r.status >= 300 && r.status < 400 && r.headers.location) {
        r.res.resume();
        if (hop >= maxRedirects)
          throw new SafeFetchError("too_many_redirects", "Too many redirects");
        url = checkFetchUrl(new URL(r.headers.location, url), opts.allowHosts);
        continue;
      }
      if (r.status < 200 || r.status >= 300) {
        r.res.resume();
        throw new SafeFetchError("http_error", `HTTP ${r.status}`, r.status);
      }
      try {
        const bytes = await readCapped(
          r.res,
          opts.maxBytes ?? SAFE_FETCH_DEFAULT_MAX_BYTES,
          opts.idleTimeoutMs ?? 15_000,
        );
        return {
          bytes,
          contentType: String(r.headers["content-type"] ?? ""),
          status: r.status,
          url: url.toString(),
        };
      } catch (err) {
        if (err instanceof SafeFetchError) throw err;
        if (controller.signal.aborted)
          throw new SafeFetchError("timeout", "The request timed out");
        throw new SafeFetchError(
          "network",
          err instanceof Error ? err.message : "Network error",
        );
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
