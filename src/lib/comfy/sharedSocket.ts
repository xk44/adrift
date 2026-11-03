/**
 * One ComfyUI WebSocket per URL per tab, shared by every caller.
 *
 * ComfyUI keeps a single socket per clientId: when a second socket connects
 * with the same id, progress/executed events for that client go to only one
 * of them. Two hook instances in one tab (StrictMode double mount, a remount
 * on navigation, a second consumer) must therefore never open two sockets.
 *
 * acquire() hands out a lease that looks like a WebSocket (onopen/onmessage/
 * onclose/onerror, readyState, send, close). Leases on the same URL share one
 * underlying socket, ref-counted. When the last lease is released the socket
 * closes, optionally after a short linger so a remount reuses it instead of
 * reconnecting.
 */

import { CLIENT_FEATURE_FLAGS_MESSAGE } from "@/lib/comfy/livePreview";

/** The subset of the WebSocket API the pool needs (fakes implement this). */
export interface SocketLike {
  readyState: number;
  binaryType?: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

export type SocketFactory = (url: string) => SocketLike;

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

type Handler<E = any> = ((event: E) => void) | null;

export interface ComfySocketLease {
  readonly url: string;
  readonly readyState: number;
  onopen: Handler;
  onmessage: Handler<MessageEvent>;
  onclose: Handler<CloseEvent>;
  onerror: Handler<Event>;
  send(data: string): void;
  /** Release now (same as release()); code/reason are ignored. */
  close(code?: number, reason?: string): void;
  /**
   * Drop this lease. Returns how many leases still hold the socket. With
   * `linger`, an idle socket stays open for the pool's linger window so a
   * quick re-acquire (remount) reuses it.
   */
  release(options?: { linger?: boolean }): number;
}

interface Entry {
  url: string;
  socket: SocketLike;
  leases: Set<Lease>;
  lingerTimer: ReturnType<typeof setTimeout> | null;
  dead: boolean;
}

class Lease implements ComfySocketLease {
  onopen: Handler = null;
  onmessage: Handler<MessageEvent> = null;
  onclose: Handler<CloseEvent> = null;
  onerror: Handler<Event> = null;
  released = false;

  constructor(
    private readonly entry: Entry,
    private readonly pool: ComfySocketPool,
  ) {}

  get url() {
    return this.entry.url;
  }

  get readyState() {
    return this.released ? CLOSED : this.entry.socket.readyState;
  }

  send(data: string) {
    if (!this.released && this.entry.socket.readyState === OPEN) {
      this.entry.socket.send(data);
    }
  }

  close() {
    this.release();
  }

  release(options?: { linger?: boolean }) {
    return this.pool.release(this.entry, this, options?.linger ?? false);
  }
}

export interface ComfySocketPoolOptions {
  factory?: SocketFactory;
  /** Sent once as the socket's first text message after it opens. */
  firstMessage?: string | null;
  /** How long an idle socket survives a lingering release (ms). */
  lingerMs?: number;
}

function defaultFactory(url: string): SocketLike {
  const ws = new WebSocket(url);
  // Previews arrive as binary frames; ArrayBuffer decodes synchronously.
  ws.binaryType = "arraybuffer";
  return ws as unknown as SocketLike;
}

export class ComfySocketPool {
  private readonly entries = new Map<string, Entry>();
  private readonly factory: SocketFactory;
  private readonly firstMessage: string | null;
  private readonly lingerMs: number;

  constructor(options: ComfySocketPoolOptions = {}) {
    this.factory = options.factory ?? defaultFactory;
    this.firstMessage =
      options.firstMessage === undefined ? null : options.firstMessage;
    this.lingerMs = options.lingerMs ?? 1500;
  }

  acquire(url: string): ComfySocketLease {
    let entry = this.entries.get(url);
    if (
      !entry ||
      entry.dead ||
      (entry.socket.readyState !== CONNECTING &&
        entry.socket.readyState !== OPEN)
    ) {
      entry = this.open(url);
    }
    if (entry.lingerTimer) {
      clearTimeout(entry.lingerTimer);
      entry.lingerTimer = null;
    }
    const lease = new Lease(entry, this);
    entry.leases.add(lease);
    if (entry.socket.readyState === OPEN) {
      // Already open: the socket's own open event is gone, so replay it once
      // the caller has had a chance to attach handlers.
      const opened = entry;
      queueMicrotask(() => {
        if (!lease.released && !opened.dead) lease.onopen?.({ type: "open" });
      });
    }
    return lease;
  }

  /** Leases currently holding the socket for `url` (0 when none). */
  refCount(url: string): number {
    const entry = this.entries.get(url);
    return entry && !entry.dead ? entry.leases.size : 0;
  }

  /** Close every socket and forget them (tests). */
  reset() {
    for (const entry of this.entries.values()) {
      // Detach holders first so the close reaches no handler.
      for (const lease of entry.leases) lease.released = true;
      entry.leases.clear();
      this.shutdown(entry);
    }
    this.entries.clear();
  }

  release(entry: Entry, lease: Lease, linger: boolean): number {
    if (lease.released) return entry.dead ? 0 : entry.leases.size;
    lease.released = true;
    entry.leases.delete(lease);
    const remaining = entry.leases.size;
    if (remaining === 0 && !entry.dead) {
      if (linger && this.lingerMs > 0) {
        if (entry.lingerTimer) clearTimeout(entry.lingerTimer);
        entry.lingerTimer = setTimeout(() => {
          entry.lingerTimer = null;
          if (entry.leases.size === 0) this.shutdown(entry);
        }, this.lingerMs);
      } else {
        this.shutdown(entry);
      }
    }
    return remaining;
  }

  private open(url: string): Entry {
    const socket = this.factory(url);
    const entry: Entry = {
      url,
      socket,
      leases: new Set(),
      lingerTimer: null,
      dead: false,
    };
    this.entries.set(url, entry);

    socket.addEventListener("open", (event) => {
      if (entry.dead) {
        // Released while still connecting: close now that it can be closed
        // cleanly (closing a CONNECTING socket logs a browser warning).
        try {
          socket.close(1000, "released");
        } catch {
          // ignore
        }
        return;
      }
      if (this.firstMessage) {
        // Must be the socket's FIRST text message (ComfyUI server.py only
        // reads feature_flags from the first one).
        try {
          socket.send(this.firstMessage);
        } catch {
          // Older servers ignore it.
        }
      }
      for (const lease of [...entry.leases]) lease.onopen?.(event);
    });
    socket.addEventListener("message", (event) => {
      for (const lease of [...entry.leases]) lease.onmessage?.(event);
    });
    socket.addEventListener("error", (event) => {
      for (const lease of [...entry.leases]) lease.onerror?.(event);
    });
    socket.addEventListener("close", (event) => {
      entry.dead = true;
      if (entry.lingerTimer) {
        clearTimeout(entry.lingerTimer);
        entry.lingerTimer = null;
      }
      if (this.entries.get(url) === entry) this.entries.delete(url);
      const leases = [...entry.leases];
      entry.leases.clear();
      for (const lease of leases) lease.onclose?.(event);
    });
    return entry;
  }

  private shutdown(entry: Entry) {
    if (entry.lingerTimer) {
      clearTimeout(entry.lingerTimer);
      entry.lingerTimer = null;
    }
    const wasDead = entry.dead;
    entry.dead = true;
    if (this.entries.get(entry.url) === entry) this.entries.delete(entry.url);
    if (wasDead) return;
    // CONNECTING sockets close from their open listener (entry.dead).
    if (entry.socket.readyState === OPEN) {
      try {
        entry.socket.close(1000, "released");
      } catch {
        // ignore
      }
    }
  }
}

/** The tab-wide pool used by useComfyWS. */
export const comfySocketPool = new ComfySocketPool({
  firstMessage: CLIENT_FEATURE_FLAGS_MESSAGE,
});

export function acquireComfySocket(url: string): ComfySocketLease {
  return comfySocketPool.acquire(url);
}
