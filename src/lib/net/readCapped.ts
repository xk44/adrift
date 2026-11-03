/**
 * Byte-capped request body readers.
 *
 * A Content-Length check alone is bypassed by chunked transfer encoding (no
 * header) and by a lying header; `req.json()` / `req.formData()` then buffer
 * the whole body. These helpers count bytes as they stream and abort once the
 * cap is crossed, so memory use is bounded by `max` regardless of headers.
 */

export class BodyTooLargeError extends Error {
  readonly status = 413;
  constructor(readonly max: number) {
    super(`Request body exceeds ${max} bytes`);
    this.name = "BodyTooLargeError";
  }
}

export class InvalidJsonBodyError extends Error {
  readonly status = 400;
  constructor() {
    super("Invalid JSON body");
    this.name = "InvalidJsonBodyError";
  }
}

/** Declared Content-Length exceeds `max` (cheap early reject). */
export function declaredTooLarge(req: Request, max: number): boolean {
  const raw = req.headers.get("content-length");
  if (!raw) return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > max;
}

/**
 * Read the whole body into memory, throwing BodyTooLargeError as soon as more
 * than `max` bytes arrive. A null body yields an empty array.
 */
export async function readBodyCapped(
  req: Request,
  max: number,
): Promise<Uint8Array> {
  if (declaredTooLarge(req, max)) throw new BodyTooLargeError(max);
  const body = req.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new BodyTooLargeError(max);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Parse a JSON body under a byte cap. Throws BodyTooLargeError (413) or
 * InvalidJsonBodyError (400). An empty body returns `emptyValue` when given,
 * otherwise it is invalid JSON.
 */
export async function readJsonCapped<T = unknown>(
  req: Request,
  max: number,
  opts: { emptyValue?: T } = {},
): Promise<T> {
  const bytes = await readBodyCapped(req, max);
  if (bytes.byteLength === 0 && "emptyValue" in opts) {
    return opts.emptyValue as T;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new InvalidJsonBodyError();
  }
}

/**
 * Re-wrap a capped body as a Request so `formData()` can parse it without
 * buffering more than `max` bytes.
 */
export async function cappedRequest(
  req: Request,
  max: number,
): Promise<Request> {
  const bytes = await readBodyCapped(req, max);
  const headers = new Headers(req.headers);
  headers.delete("content-length");
  return new Request(req.url, {
    method: req.method,
    headers,
    body: bytes.byteLength ? (bytes.buffer as ArrayBuffer) : null,
  });
}

/** Sniff the real image type from magic bytes; null when not a known raster. */
export function sniffImageType(
  b: Uint8Array,
): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif" | null {
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  )
    return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return "image/jpeg";
  if (
    b.length >= 6 &&
    b[0] === 0x47 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x38 &&
    (b[4] === 0x37 || b[4] === 0x39) &&
    b[5] === 0x61
  )
    return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return "image/webp";
  // ISO-BMFF: [size]"ftyp" then a major brand of avif/avis.
  if (
    b.length >= 12 &&
    b[4] === 0x66 &&
    b[5] === 0x74 &&
    b[6] === 0x79 &&
    b[7] === 0x70 &&
    b[8] === 0x61 &&
    b[9] === 0x76 &&
    b[10] === 0x69 &&
    (b[11] === 0x66 || b[11] === 0x73)
  )
    return "image/avif";
  return null;
}
