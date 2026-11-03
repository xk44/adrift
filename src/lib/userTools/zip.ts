/**
 * Tiny zip reader (central directory + stored/deflate entries) and writer.
 *
 * Civitai ships many workflows as .zip archives. This reads just enough of
 * the format to pull small files out of one, using Node's zlib.inflateRawSync
 * so no extra package is needed. ZIP64, encryption and other compression
 * methods are reported as unsupported per entry instead of crashing.
 *
 * writeZip builds the small archives Adrift exports (tool packs): deflate or
 * stored entries, real CRC-32s, no ZIP64.
 */

import { crc32, deflateRawSync, inflateRawSync } from "zlib";

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  encrypted: boolean;
  isDirectory: boolean;
  /** Offset of the local file header. */
  localOffset: number;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipLimits {
  /** Max number of central-directory entries read. */
  maxEntries?: number;
  /** Max uncompressed bytes for a single entry. */
  maxEntryBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_MAX_ENTRY_BYTES = 32 * 1024 * 1024;

export function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06)
  );
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function findEocd(buf: Buffer): number {
  const stop = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** List the entries of a zip archive from its central directory. */
export function listZipEntries(
  bytes: Uint8Array,
  limits: ZipLimits = {},
): ZipEntry[] {
  const buf = asBuffer(bytes);
  if (buf.length < EOCD_MIN)
    throw new ZipError("File is too small to be a zip");
  const eocd = findEocd(buf);
  if (eocd < 0)
    throw new ZipError("Not a zip file (no end-of-directory record)");

  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError("ZIP64 archives are not supported");
  }
  if (cdOffset + cdSize > buf.length)
    throw new ZipError("Zip directory is truncated");
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (total > maxEntries)
    throw new ZipError(`Zip has too many files (${total})`);

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      throw new ZipError("Zip directory is corrupt");
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const nameEnd = p + 46 + nameLen;
    if (nameEnd > buf.length) throw new ZipError("Zip directory is corrupt");
    const name = buf.toString("utf8", p + 46, nameEnd);
    entries.push({
      name,
      method,
      compressedSize,
      size,
      encrypted: (flags & 0x1) !== 0,
      isDirectory: name.endsWith("/"),
      localOffset,
    });
    p = nameEnd + extraLen + commentLen;
  }
  return entries;
}

/** Read one entry's uncompressed bytes. */
export function readZipEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  limits: ZipLimits = {},
): Buffer {
  const buf = asBuffer(bytes);
  const maxBytes = limits.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  if (entry.encrypted) throw new ZipError(`${entry.name} is encrypted`);
  if (entry.size > maxBytes) throw new ZipError(`${entry.name} is too large`);
  const p = entry.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOC_SIG) {
    throw new ZipError(`${entry.name}: bad local header`);
  }
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) throw new ZipError(`${entry.name} is truncated`);
  const data = buf.subarray(start, end);
  if (entry.method === 0) {
    if (data.length !== entry.size)
      throw new ZipError(`${entry.name}: size mismatch`);
    return Buffer.from(data);
  }
  if (entry.method === 8) {
    let out: Buffer;
    try {
      out = inflateRawSync(data, { maxOutputLength: Math.max(1, maxBytes) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ZipError(`${entry.name}: could not decompress (${msg})`);
    }
    if (out.length !== entry.size)
      throw new ZipError(`${entry.name}: size mismatch`);
    return out;
  }
  throw new ZipError(
    `${entry.name}: unsupported compression method ${entry.method}`,
  );
}

export interface ZipWriteFile {
  name: string;
  data: Uint8Array | string;
  /** Default: deflate for text-like data, stored when deflate does not help. */
  method?: 0 | 8;
}

/** Fixed DOS timestamp (1980-01-01 00:00) so exports are reproducible. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/** Build a zip archive from in-memory files. */
export function writeZip(files: ZipWriteFile[]): Buffer {
  if (files.length > 0xfffe) throw new ZipError("Too many files for a zip");
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (const f of files) {
    if (!f.name || f.name.startsWith("/") || f.name.split("/").includes("..")) {
      throw new ZipError(`Bad zip member name: ${f.name}`);
    }
    if (seen.has(f.name)) throw new ZipError(`Duplicate zip member: ${f.name}`);
    seen.add(f.name);
    const data =
      typeof f.data === "string" ? Buffer.from(f.data, "utf8") : asBuffer(f.data);
    let method: 0 | 8 = f.method ?? 8;
    let body = data;
    if (method === 8) {
      const packed = deflateRawSync(data);
      if (f.method === 8 || packed.length < data.length) body = packed;
      else method = 0;
    }
    if (offset > 0xfffffff0 || body.length > 0xfffffff0) {
      throw new ZipError("Zip would need ZIP64, which is not supported");
    }
    const crc = crc32(data) >>> 0;
    const name = Buffer.from(f.name, "utf8");
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(LOC_SIG, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(0x0800, 6); // UTF-8 names
    loc.writeUInt16LE(method, 8);
    loc.writeUInt16LE(DOS_TIME, 10);
    loc.writeUInt16LE(DOS_DATE, 12);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(body.length, 18);
    loc.writeUInt32LE(data.length, 22);
    loc.writeUInt16LE(name.length, 26);
    loc.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CEN_SIG, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(DOS_TIME, 12);
    cen.writeUInt16LE(DOS_DATE, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    locals.push(loc, name, body);
    centrals.push(cen, name);
    offset += loc.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(EOCD_MIN);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
