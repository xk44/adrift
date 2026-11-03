/**
 * Browser-side login gate plumbing.
 *
 * installAuthFetch() wraps window.fetch once: any same-origin /api/* request
 * (except /api/auth/*) that comes back 401 waits for the user to log in
 * (AuthGate shows the key prompt), then is retried. The key is exchanged for
 * an httpOnly cookie by POST /api/auth/login, so it is never kept in JS
 * storage and <img src="/api/..."> loads authenticate via the cookie.
 */

type Listener = (open: boolean) => void;

let installed = false;
let pending: Promise<void> | null = null;
let resolvePending: (() => void) | null = null;
const listeners = new Set<Listener>();

export function subscribeAuthGate(fn: Listener): () => void {
  listeners.add(fn);
  fn(pending !== null);
  return () => {
    listeners.delete(fn);
  };
}

function emit() {
  for (const fn of listeners) fn(pending !== null);
}

function requestLogin(): Promise<void> {
  if (!pending) {
    pending = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    emit();
  }
  return pending;
}

/** Called by AuthGate after a successful POST /api/auth/login. */
export function completeLogin(): void {
  const done = resolvePending;
  pending = null;
  resolvePending = null;
  emit();
  retryBrokenImages();
  done?.();
}

/** <img> tags cannot retry themselves; re-request any that failed with 401. */
function retryBrokenImages() {
  if (typeof document === "undefined") return;
  for (const img of Array.from(document.images)) {
    if (img.complete && img.naturalWidth === 0 && img.src.includes("/api/")) {
      const src = img.src;
      img.src = "";
      img.src = src;
    }
  }
}

export async function submitLogin(
  apiKey: string,
  rawFetch: typeof fetch = fetch,
): Promise<boolean> {
  const res = await rawFetch("/api/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify({ api_key: apiKey }),
  });
  return res.ok;
}

function gatedUrl(input: RequestInfo | URL): boolean {
  try {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const u = new URL(raw, window.location.href);
    return (
      u.origin === window.location.origin &&
      u.pathname.startsWith("/api/") &&
      !u.pathname.startsWith("/api/auth/")
    );
  } catch {
    return false;
  }
}

export function installAuthFetch(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    if (!gatedUrl(input)) return orig(input, init);
    const retryInput =
      typeof Request !== "undefined" && input instanceof Request
        ? input.clone()
        : input;
    const res = await orig(input, init);
    if (res.status !== 401) return res;
    await requestLogin();
    return orig(retryInput, init);
  };
}
