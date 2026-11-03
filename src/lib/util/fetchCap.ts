/**
 * Read a fetch Response body with a hard byte cap enforced while streaming
 * (a lying/absent Content-Length cannot make us buffer an oversized body).
 */
export async function readBodyCapped(
  resp: Response,
  maxBytes: number,
  label = "body",
): Promise<Buffer> {
  const declared = Number(resp.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    await resp.body?.cancel().catch(() => {});
    throw new Error(`${label} too large`);
  }
  if (!resp.body) {
    const ab = await resp.arrayBuffer();
    if (ab.byteLength > maxBytes) throw new Error(`${label} too large`);
    return Buffer.from(ab);
  }
  const reader = resp.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`${label} too large`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}
