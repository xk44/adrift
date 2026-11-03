/**
 * ComfyUI double-socket mitigation: one shared socket per URL per tab
 * (ref-counted leases), a per-tab clientId, and the silent-prompt watchdog
 * that drives the history-poll fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComfySocketPool,
  type SocketLike,
} from "@/lib/comfy/sharedSocket";
import { createPromptWatchdog } from "@/lib/comfy/promptWatchdog";
import {
  TAB_CLIENT_ID_KEY,
  getTabClientId,
  guardTabClientId,
} from "@/lib/comfy/tabClientId";

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closes: Array<[number | undefined, string | undefined]> = [];
  private listeners = new Map<string, Array<(e: any) => void>>();
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  addEventListener(type: string, fn: (e: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string, event: any = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  open() {
    this.readyState = 1;
    this.fire("open", { type: "open" });
  }
  close(code?: number, reason?: string) {
    if (this.readyState === 3) return;
    if (this.readyState === 0) throw new Error("closed while CONNECTING");
    this.closes.push([code, reason]);
    this.readyState = 3;
    this.fire("close", { code, reason });
  }
  serverDrop() {
    this.readyState = 3;
    this.fire("close", { code: 1006, reason: "" });
  }
}

const URL_A = "ws://127.0.0.1:8188/ws?clientId=a";
const URL_B = "ws://127.0.0.1:8188/ws?clientId=b";

function makePool(lingerMs = 1000) {
  return new ComfySocketPool({
    factory: (url) => new FakeSocket(url),
    firstMessage: '{"type":"feature_flags"}',
    lingerMs,
  });
}

beforeEach(() => {
  FakeSocket.all = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ComfySocketPool", () => {
  it("shares one socket between leases on the same URL", () => {
    const pool = makePool();
    const a = pool.acquire(URL_A);
    const b = pool.acquire(URL_A);
    expect(FakeSocket.all).toHaveLength(1);
    expect(pool.refCount(URL_A)).toBe(2);
    pool.acquire(URL_B);
    expect(FakeSocket.all).toHaveLength(2);
    expect(a.url).toBe(URL_A);
    expect(b.readyState).toBe(0);
  });

  it("fans open/message/close out to every lease and sends the handshake once", () => {
    const pool = makePool();
    const a = pool.acquire(URL_A);
    const b = pool.acquire(URL_A);
    const seen: string[] = [];
    a.onopen = () => seen.push("a:open");
    b.onopen = () => seen.push("b:open");
    a.onmessage = (e) => seen.push(`a:${e.data}`);
    b.onmessage = (e) => seen.push(`b:${e.data}`);
    a.onclose = () => seen.push("a:close");
    b.onclose = () => seen.push("b:close");
    const sock = FakeSocket.all[0];
    sock.open();
    sock.fire("message", { data: "x" });
    sock.serverDrop();
    expect(seen).toEqual([
      "a:open",
      "b:open",
      "a:x",
      "b:x",
      "a:close",
      "b:close",
    ]);
    expect(sock.sent).toEqual(['{"type":"feature_flags"}']);
    expect(a.readyState).toBe(3);
    // A dead socket is replaced on the next acquire.
    pool.acquire(URL_A);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("replays open to a lease taken on an already-open socket", async () => {
    const pool = makePool();
    pool.acquire(URL_A);
    FakeSocket.all[0].open();
    const late = pool.acquire(URL_A);
    const onopen = vi.fn();
    late.onopen = onopen;
    await Promise.resolve();
    expect(onopen).toHaveBeenCalledTimes(1);
    expect(FakeSocket.all[0].sent).toHaveLength(1);
  });

  it("keeps the socket while any lease holds it; closes on the last release", () => {
    const pool = makePool();
    const a = pool.acquire(URL_A);
    const b = pool.acquire(URL_A);
    const sock = FakeSocket.all[0];
    sock.open();
    const bClose = vi.fn();
    b.onclose = bClose;
    expect(a.release()).toBe(1);
    expect(a.release()).toBe(1); // idempotent
    expect(a.readyState).toBe(3);
    expect(sock.readyState).toBe(1);
    expect(b.release()).toBe(0);
    expect(sock.closes).toEqual([[1000, "released"]]);
    // Released leases get no close callback.
    expect(bClose).not.toHaveBeenCalled();
    expect(pool.refCount(URL_A)).toBe(0);
  });

  it("survives a StrictMode / remount cycle within the linger window", () => {
    vi.useFakeTimers();
    const pool = makePool(1000);
    const first = pool.acquire(URL_A);
    FakeSocket.all[0].open();
    first.release({ linger: true });
    vi.advanceTimersByTime(500);
    const second = pool.acquire(URL_A);
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(second.readyState).toBe(1);
    expect(FakeSocket.all[0].closes).toEqual([]);
  });

  it("closes an idle lingering socket after the window", () => {
    vi.useFakeTimers();
    const pool = makePool(1000);
    pool.acquire(URL_A).release({ linger: true });
    FakeSocket.all[0].open(); // opened during linger: stays up until timeout
    expect(FakeSocket.all[0].readyState).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all[0].readyState).toBe(3);
    pool.acquire(URL_A);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("closes a socket released mid-handshake once it opens, without reusing it", () => {
    const pool = makePool();
    const lease = pool.acquire(URL_A);
    const onopen = vi.fn();
    lease.onopen = onopen;
    lease.close(); // CONNECTING: FakeSocket throws if closed now
    pool.acquire(URL_A);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[0].open();
    expect(FakeSocket.all[0].readyState).toBe(3);
    expect(FakeSocket.all[0].sent).toEqual([]);
    expect(onopen).not.toHaveBeenCalled();
  });

  it("send only reaches an open socket for a held lease", () => {
    const pool = makePool();
    const lease = pool.acquire(URL_A);
    lease.send("early");
    FakeSocket.all[0].open();
    lease.send("hi");
    lease.release();
    lease.send("late");
    expect(FakeSocket.all[0].sent).toEqual(['{"type":"feature_flags"}', "hi"]);
  });
});

describe("prompt watchdog (history-poll fallback)", () => {
  it("flags a pending prompt only after staleMs of WS silence", () => {
    let t = 0;
    const wd = createPromptWatchdog({ staleMs: 20_000, now: () => t });
    expect(wd.stale(["p1"])).toEqual([]); // clock starts
    t = 19_999;
    expect(wd.stale(["p1"])).toEqual([]);
    t = 20_000;
    expect(wd.stale(["p1"])).toEqual(["p1"]);
    // Still silent: keeps polling every tick until it leaves pending.
    t = 25_000;
    expect(wd.stale(["p1"])).toEqual(["p1"]);
  });

  it("resets the clock on any WS event for that prompt", () => {
    let t = 0;
    const wd = createPromptWatchdog({ staleMs: 10_000, now: () => t });
    wd.stale(["p1", "p2"]);
    t = 9_000;
    wd.noteEvent("p1");
    t = 12_000;
    expect(wd.stale(["p1", "p2"])).toEqual(["p2"]);
    t = 19_000;
    expect(wd.stale(["p1", "p2"])).toEqual(["p1", "p2"]);
  });

  it("forgets prompts that are no longer pending", () => {
    let t = 0;
    const wd = createPromptWatchdog({ staleMs: 10_000, now: () => t });
    wd.stale(["p1"]);
    t = 50_000;
    expect(wd.stale([])).toEqual([]);
    // Re-queued later: a fresh clock, not instantly stale.
    expect(wd.stale(["p1"])).toEqual([]);
  });
});

describe("per-tab clientId", () => {
  function memoryStorage() {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      m,
    };
  }

  it("creates the id once per tab storage and reuses it", () => {
    const tab1 = memoryStorage();
    const tab2 = memoryStorage();
    const id1 = getTabClientId(tab1);
    expect(getTabClientId(tab1)).toBe(id1);
    expect(tab1.m.get(TAB_CLIENT_ID_KEY)).toBe(id1);
    expect(getTabClientId(tab2)).not.toBe(id1);
  });

  it("falls back to a fresh id when storage is unavailable", () => {
    expect(getTabClientId(null)).toMatch(/[0-9a-f-]{36}/);
  });

  it("moves a duplicated tab (same id) to a new id, not the original", () => {
    // Minimal in-memory BroadcastChannel: delivers to every other member.
    const members: Array<{ onmessage: ((e: { data: unknown }) => void) | null }> = [];
    const createChannel = () => {
      const ch = {
        onmessage: null as ((e: { data: unknown }) => void) | null,
        postMessage(data: unknown) {
          for (const m of members) if (m !== ch) m.onmessage?.({ data });
        },
        close() {
          members.splice(members.indexOf(ch), 1);
        },
      };
      members.push(ch);
      return ch;
    };
    let original = "shared-id";
    let duplicate = "shared-id";
    const stopOriginal = guardTabClientId(
      () => original,
      () => {
        original = "original-new";
      },
      createChannel,
      "tab-original",
    );
    const stopDuplicate = guardTabClientId(
      () => duplicate,
      () => {
        duplicate = "duplicate-new";
      },
      createChannel,
      "tab-duplicate",
    );
    expect(original).toBe("shared-id");
    expect(duplicate).toBe("duplicate-new");
    stopOriginal();
    stopDuplicate();
    expect(members).toHaveLength(0);

    // Two guards in the SAME tab (shared nonce) never flag each other.
    const sameTab = vi.fn();
    const g1 = guardTabClientId(() => "same", sameTab, createChannel, "tab-x");
    const g2 = guardTabClientId(() => "same", sameTab, createChannel, "tab-x");
    expect(sameTab).not.toHaveBeenCalled();
    g1();
    g2();
  });

  it("is a no-op without BroadcastChannel", () => {
    const stop = guardTabClientId(() => "x", vi.fn(), () => null);
    expect(() => stop()).not.toThrow();
  });
});
