/** Binary glTF container helpers. Browser-safe (no Node imports). */

export function pad4(n: number): number {
  return (n + 3) & ~3;
}

/** GLB container: JSON chunk + one BIN chunk holding `chunks` at their offsets. */
export function packGlb(
  gltf: unknown,
  chunks: ReadonlyArray<{ data: Uint8Array; byteOffset: number }>,
  binLength: number,
): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonLength = pad4(jsonBytes.length);
  const total = 12 + 8 + jsonLength + 8 + binLength;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLength, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength);
  let p = 20 + jsonLength;
  dv.setUint32(p, binLength, true);
  dv.setUint32(p + 4, 0x004e4942, true); // "BIN\0"
  p += 8;
  for (const c of chunks) out.set(c.data, p + c.byteOffset);
  return out;
}
