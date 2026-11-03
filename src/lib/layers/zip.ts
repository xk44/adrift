/**
 * Browser-safe zip writer (store only, real CRC-32s, no ZIP64) for exports
 * built in the client. PNGs are already compressed, so storing costs little.
 * The Node writer in src/lib/userTools/zip.ts needs Buffer and zlib.
 */

export interface ZipBytesFile {
  name: string;
  data: Uint8Array | string;
}

export class ZipWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipWriteError";
  }
}

let table: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

export function crc32Bytes(data: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export function writeZipBytes(files: readonly ZipBytesFile[]): Uint8Array {
  if (files.length > 0xfffe)
    throw new ZipWriteError("Too many files for a zip");
  const enc = new TextEncoder();
  const seen = new Set<string>();
  const items = files.map((f) => {
    if (
      !f.name ||
      f.name.startsWith("/") ||
      f.name.includes("\\") ||
      f.name.split("/").includes("..")
    )
      throw new ZipWriteError(`Bad zip member name: ${f.name}`);
    if (seen.has(f.name))
      throw new ZipWriteError(`Duplicate zip member: ${f.name}`);
    seen.add(f.name);
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    return { name: enc.encode(f.name), data, crc: crc32Bytes(data) };
  });
  let localSize = 0;
  let cdSize = 0;
  for (const it of items) {
    localSize += 30 + it.name.length + it.data.length;
    cdSize += 46 + it.name.length;
  }
  if (localSize + cdSize > 0xfffffff0)
    throw new ZipWriteError("Zip would need ZIP64, which is not supported");
  const out = new Uint8Array(localSize + cdSize + 22);
  const v = new DataView(out.buffer);
  let p = 0;
  const offsets: number[] = [];
  for (const it of items) {
    offsets.push(p);
    v.setUint32(p, 0x04034b50, true);
    v.setUint16(p + 4, 20, true);
    v.setUint16(p + 6, 0x0800, true);
    v.setUint16(p + 8, 0, true);
    v.setUint16(p + 10, 0, true);
    v.setUint16(p + 12, DOS_DATE, true);
    v.setUint32(p + 14, it.crc, true);
    v.setUint32(p + 18, it.data.length, true);
    v.setUint32(p + 22, it.data.length, true);
    v.setUint16(p + 26, it.name.length, true);
    v.setUint16(p + 28, 0, true);
    out.set(it.name, p + 30);
    out.set(it.data, p + 30 + it.name.length);
    p += 30 + it.name.length + it.data.length;
  }
  const cdStart = p;
  items.forEach((it, i) => {
    v.setUint32(p, 0x02014b50, true);
    v.setUint16(p + 4, 20, true);
    v.setUint16(p + 6, 20, true);
    v.setUint16(p + 8, 0x0800, true);
    v.setUint16(p + 10, 0, true);
    v.setUint16(p + 12, 0, true);
    v.setUint16(p + 14, DOS_DATE, true);
    v.setUint32(p + 16, it.crc, true);
    v.setUint32(p + 20, it.data.length, true);
    v.setUint32(p + 24, it.data.length, true);
    v.setUint16(p + 28, it.name.length, true);
    v.setUint32(p + 42, offsets[i], true);
    out.set(it.name, p + 46);
    p += 46 + it.name.length;
  });
  v.setUint32(p, 0x06054b50, true);
  v.setUint16(p + 8, items.length, true);
  v.setUint16(p + 10, items.length, true);
  v.setUint32(p + 12, p - cdStart, true);
  v.setUint32(p + 16, cdStart, true);
  return out;
}
