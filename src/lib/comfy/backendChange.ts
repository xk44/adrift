/**
 * Client-side "the ComfyUI backend changed" signal. Browser caches built from
 * the old backend (object_info specs, LoRA metadata, the GPU profile) register
 * a clearer here; OnboardingHost calls notifyComfyBackendChanged() when the
 * connection's address or token changes, and listeners can also watch the
 * `cj:comfy-backend-changed` window event to refetch.
 *
 * Client-safe, no imports.
 */

export const COMFY_BACKEND_CHANGED_EVENT = "cj:comfy-backend-changed";

const clearers = new Set<() => void>();

/** Run `clear` whenever the backend changes. Returns an unsubscribe. */
export function onComfyBackendChange(clear: () => void): () => void {
  clearers.add(clear);
  return () => {
    clearers.delete(clear);
  };
}

export function notifyComfyBackendChanged(): void {
  for (const clear of [...clearers]) {
    try {
      clear();
    } catch {
      // one broken clearer must not keep the others stale
    }
  }
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(COMFY_BACKEND_CHANGED_EVENT));
}

/**
 * The identity of a connection for change detection: its address plus
 * whether it carries a token (a token change can expose other models).
 */
export function backendKey(
  s: { httpUrl: string; hasToken: boolean } | null,
): string | null {
  return s ? `${s.httpUrl.replace(/\/+$/, "")}#${s.hasToken ? 1 : 0}` : null;
}
