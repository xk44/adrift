/**
 * Download one Hugging Face file into a model folder with the same guards as
 * Civitai downloads: https + HF hosts only on every redirect hop (the LFS/Xet
 * CDNs live under huggingface.co / hf.co), a byte cap, a 60 s idle timeout
 * (not a total timeout), the request's abort signal, a hidden temp file, and
 * no silent overwrite.
 *
 * Server-side only.
 */
import path from "path";
import { unlink } from "fs/promises";
import { DownloadError, downloadToFile, hostMatches } from "./downloadToFile";
import { SafeDestError, finalizeTemp, tempPathFor } from "@/lib/fs/safeDest";

export const HF_DOWNLOAD_HOSTS = ["huggingface.co", "hf.co"] as const;

export function isHfDownloadHost(hostname: string): boolean {
  return hostMatches(hostname, HF_DOWNLOAD_HOSTS);
}

/** Single-file LoRA / upscaler ceiling. */
export const HF_MAX_BYTES = 4 * 2 ** 30;

export interface HfFileDownloadOptions {
  url: string;
  /** Real, already-contained folder (see resolveContainedDir). */
  dir: string;
  /** Validated leaf name. */
  name: string;
  maxBytes?: number;
  idleMs?: number;
  signal?: AbortSignal;
  onBytes?: (delta: number) => void;
  overwrite?: boolean;
  /** Uppercase or lowercase hex; checked after the download when given. */
  expectedSha256?: string;
  fetchImpl?: typeof fetch;
}

export async function downloadHfFile(
  opts: HfFileDownloadOptions,
): Promise<{ path: string; bytes: number; sha256: string }> {
  const finalPath = path.join(opts.dir, opts.name);
  const temp = tempPathFor(opts.dir, opts.name);
  try {
    const res = await downloadToFile({
      url: opts.url,
      dest: temp,
      allowHost: isHfDownloadHost,
      maxBytes: opts.maxBytes ?? HF_MAX_BYTES,
      idleMs: opts.idleMs,
      signal: opts.signal,
      onBytes: opts.onBytes,
      fetchImpl: opts.fetchImpl,
    });
    if (
      opts.expectedSha256 &&
      res.sha256 !== opts.expectedSha256.toUpperCase()
    ) {
      throw new DownloadError(
        "http",
        "The downloaded file doesn't match its published checksum",
      );
    }
    await finalizeTemp(temp, finalPath, { overwrite: opts.overwrite });
    return { path: finalPath, bytes: res.bytes, sha256: res.sha256 };
  } finally {
    // No-op after a successful finalize (temp already moved/unlinked).
    await unlink(temp).catch(() => {});
  }
}

/** HTTP status for a download/placement failure. */
export function downloadErrorStatus(err: unknown): number {
  if (err instanceof DownloadError) {
    switch (err.code) {
      case "too_large":
        return 413;
      case "idle":
        return 504;
      case "aborted":
        return 499;
      case "auth":
        return 403;
      default:
        return 502;
    }
  }
  if (err instanceof SafeDestError) return err.code === "exists" ? 409 : 400;
  return 502;
}

/** Display names for user-added entries: short, single line. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function validDisplayName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 80 &&
    !CONTROL_CHARS.test(value)
  );
}
