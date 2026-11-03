/**
 * Overlay-side inbound guard for the ComfyUI host bridge.
 *
 * Pure (no window access of its own) so it is unit-testable. The overlay
 * hook feeds every `message` event through `accept()`; only messages that
 * pass every check reach the store.
 *
 * Checks, in order:
 *   1. Source — event.source must be the parent window that embeds us.
 *      Origin alone is not enough: sibling iframes on the ComfyUI page can
 *      post to us too.
 *   2. Namespace — data must be an object with a `cj:` type.
 *   3. Origin — must equal the parent origin (from ancestorOrigins /
 *      referrer when known, otherwise locked to the first accepted message).
 *   4. Schema — full Zod validation via parseCjMessage.
 *   5. Direction — only host→overlay types (plus the host's cj:ack).
 *   6. Session nonce — once cj:config has delivered a nonce, every later
 *      message must carry it. Stale messages from an earlier handshake are
 *      dropped.
 */

import {
  HOST_MSG,
  OVERLAY_MSG,
  messageRole,
  parseCjMessage,
  type ConfigPayload,
  type ParseResult,
} from "./protocol";

export type InboundRejectReason =
  "source" | "not-cj" | "origin" | "malformed" | "direction" | "nonce";

export type InboundDecision =
  | { ok: true; message: ParseResult; newSession: boolean }
  | { ok: false; reason: InboundRejectReason };

export interface InboundEventLike {
  data: unknown;
  origin: string;
  source: unknown;
}

export interface OverlayInboundGuard {
  accept(event: InboundEventLike): InboundDecision;
  /** Parent origin once known ("" until then) — use as postMessage target */
  readonly origin: string;
  /** Nonce from the latest cj:config, or null before the handshake */
  readonly sessionNonce: string | null;
}

/**
 * Current host session (nonce + parent origin) for outbound requests made
 * outside the overlay hook (e.g. "Edit in ComfyUI" on the Workflows page).
 * Set by useOverlayMode on cj:config, cleared when the bridge unmounts.
 */
export interface ActiveHostSession {
  nonce: string;
  origin: string;
}

let activeHostSession: ActiveHostSession | null = null;

export function setActiveHostSession(session: ActiveHostSession | null): void {
  activeHostSession = session;
}

export function getActiveHostSession(): ActiveHostSession | null {
  return activeHostSession;
}

/** Normalize a URL-ish string to its origin, or "" if unusable. */
function toOrigin(value: string | null | undefined): string {
  if (!value) return "";
  try {
    const origin = new URL(value).origin;
    return origin && origin !== "null" ? origin : "";
  } catch {
    return "";
  }
}

/**
 * Best-effort origin of the embedding parent without touching
 * `parent.location` (which throws cross-origin, the normal overlay case).
 */
export function resolveParentOrigin(win: {
  parent?: { location?: { origin?: string } } | null;
  location?: { ancestorOrigins?: ArrayLike<string> } | null;
  document?: { referrer?: string } | null;
}): string {
  try {
    const sameOrigin = win.parent?.location?.origin;
    if (sameOrigin && sameOrigin !== "null") return sameOrigin;
  } catch {
    /* cross-origin parent */
  }
  try {
    const ancestors = win.location?.ancestorOrigins;
    if (ancestors && ancestors.length > 0) {
      const origin = toOrigin(ancestors[0]);
      if (origin) return origin;
    }
  } catch {
    /* ignore */
  }
  try {
    return toOrigin(win.document?.referrer);
  } catch {
    return "";
  }
}

const INBOUND_TYPES = new Set<string>([OVERLAY_MSG.ACK]);

export function createOverlayInboundGuard(options: {
  expectedSource: unknown;
  parentOrigin?: string;
}): OverlayInboundGuard {
  let origin = options.parentOrigin ?? "";
  let sessionNonce: string | null = null;

  return {
    get origin() {
      return origin;
    },
    get sessionNonce() {
      return sessionNonce;
    },
    accept(event) {
      if (event.source == null || event.source !== options.expectedSource) {
        return { ok: false, reason: "source" };
      }
      const data = event.data;
      if (!data || typeof data !== "object") {
        return { ok: false, reason: "not-cj" };
      }
      const rawType = (data as { type?: unknown }).type;
      if (typeof rawType !== "string" || !rawType.startsWith("cj:")) {
        return { ok: false, reason: "not-cj" };
      }
      if (origin && event.origin !== origin) {
        return { ok: false, reason: "origin" };
      }

      const parsed = parseCjMessage(data);
      if (!parsed.ok) return { ok: false, reason: "malformed" };
      if (
        messageRole(parsed.type) !== "host" &&
        !INBOUND_TYPES.has(parsed.type)
      ) {
        return { ok: false, reason: "direction" };
      }

      let newSession = false;
      if (parsed.type === HOST_MSG.CONFIG) {
        const nonce =
          (parsed.payload as ConfigPayload).nonce ?? parsed.nonce ?? null;
        newSession = nonce !== sessionNonce;
        sessionNonce = nonce;
      } else if (sessionNonce !== null && parsed.nonce !== sessionNonce) {
        return { ok: false, reason: "nonce" };
      }

      if (!origin) origin = event.origin;
      return { ok: true, message: parsed, newSession };
    },
  };
}
