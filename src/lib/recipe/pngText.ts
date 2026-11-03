/**
 * Write / strip PNG tEXt chunks (Latin-1 keyword + text). Pairs with
 * readPngTextChunks in lib/pngMeta. No dependencies.
 */

import { isPng } from "@/lib/pngMeta";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0xff) throw new Error("tEXt text must be Latin-1");
    out[i] = code;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(latin1Bytes(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

interface ChunkSpan {
  type: string;
  start: number;
  end: number;
  keyword?: string;
}

function chunks(bytes: Uint8Array): ChunkSpan[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: ChunkSpan[] = [];
  let pos = 8;
  while (pos + 12 <= bytes.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const end = pos + 12 + len;
    if (end > bytes.length) break;
    let keyword: string | undefined;
    if (type === "tEXt" || type === "iTXt" || type === "zTXt") {
      const data = bytes.subarray(pos + 8, pos + 8 + len);
      const nul = data.indexOf(0);
      if (nul > 0) keyword = String.fromCharCode(...data.subarray(0, nul));
    }
    out.push({ type, start: pos, end, keyword });
    pos = end;
    if (type === "IEND") break;
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Remove text chunks whose keyword is in `keys` (all text chunks when omitted). */
export function stripPngTextChunks(
  bytes: Uint8Array,
  keys?: string[],
): Uint8Array {
  if (!isPng(bytes)) return bytes;
  const drop = keys ? new Set(keys) : null;
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  for (const c of chunks(bytes)) {
    if (c.keyword !== undefined && (!drop || drop.has(c.keyword))) continue;
    parts.push(bytes.subarray(c.start, c.end));
  }
  return concat(parts);
}

/**
 * Set a tEXt chunk (replacing any text chunk with the same keyword), placed
 * before IEND. Non-Latin-1 characters are written as \uXXXX, which JSON
 * readers decode back.
 */
export function writePngTextChunk(
  bytes: Uint8Array,
  key: string,
  text: string,
): Uint8Array {
  if (!isPng(bytes)) throw new Error("Not a PNG");
  if (!/^[\x20-\x7e]{1,79}$/.test(key)) throw new Error("Bad tEXt keyword");
  const safe = text.replace(
    /[Ā-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const data = concat([
    latin1Bytes(key),
    new Uint8Array([0]),
    latin1Bytes(safe),
  ]);
  const kept = stripPngTextChunks(bytes, [key]);
  const iend = chunks(kept).find((c) => c.type === "IEND");
  if (!iend) throw new Error("PNG has no IEND");
  return concat([
    kept.subarray(0, iend.start),
    chunk("tEXt", data),
    kept.subarray(iend.start),
  ]);
}
