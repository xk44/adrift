/**
 * Proxied upstream bodies (ComfyUI /view, StyleVault) are served from the
 * app origin. A Content-Type of text/html or image/svg+xml there would run
 * script with the app's cookies, so only inert types pass through; anything
 * else is downloaded as an opaque attachment inside a CSP sandbox.
 */
const SAFE_TYPE_RE =
  /^(?:application\/json|text\/plain|text\/event-stream|image\/(?:png|jpeg|webp|gif|avif|bmp)|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|model\/gltf-binary|application\/octet-stream)$/;

export function isSafeProxiedType(contentType: string | null | undefined): boolean {
  const base = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return SAFE_TYPE_RE.test(base);
}

/** Headers to serve an upstream body with; never echoes an unsafe type. */
export function safeProxiedTypeHeaders(
  upstreamType: string | null | undefined,
  fallback = "application/json",
): Record<string, string> {
  const type = (upstreamType || fallback).trim();
  if (isSafeProxiedType(type)) {
    return { "Content-Type": type, "X-Content-Type-Options": "nosniff" };
  }
  return {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": "attachment",
    "Content-Security-Policy": "sandbox",
    "X-Content-Type-Options": "nosniff",
  };
}

/** TransformStream that errors once more than `max` bytes have passed. */
export function capBytes(
  max: number,
  state: { exceeded: boolean },
): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, ctrl) {
      seen += chunk.byteLength;
      if (seen > max) {
        state.exceeded = true;
        ctrl.error(new Error("Payload too large"));
        return;
      }
      ctrl.enqueue(chunk);
    },
  });
}
