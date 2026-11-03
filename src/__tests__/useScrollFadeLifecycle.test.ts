import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * No DOM test environment here, so React's useState/useEffect are swapped for
 * a tiny single-component hook runtime. It follows React's rules that matter
 * for this bug: state setters re-render, effects re-run (cleanup first) only
 * when their deps change, state set during an effect commit is batched, and
 * a callback ref is called with the node on mount
 * and with null on unmount.
 */
const runtime = vi.hoisted(() => {
  type Effect = { deps?: unknown[]; cleanup?: void | (() => void) };
  const state: unknown[] = [];
  const effects: Effect[] = [];
  const pending: Array<() => void> = [];
  let cursor = 0;
  let effectCursor = 0;
  let rerender: (() => void) | null = null;
  // Like React, state set while effects commit is batched into one re-render.
  let flushing = false;
  let dirty = false;
  const same = (a?: unknown[], b?: unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  return {
    state,
    effects,
    begin(render: () => void) {
      rerender = render;
      cursor = 0;
      effectCursor = 0;
    },
    flush() {
      flushing = true;
      while (pending.length) {
        while (pending.length) pending.shift()!();
        if (dirty) {
          dirty = false;
          rerender?.();
        }
      }
      flushing = false;
    },
    reset() {
      effects.forEach((e) => typeof e.cleanup === "function" && e.cleanup());
      state.length = 0;
      effects.length = 0;
      pending.length = 0;
      rerender = null;
    },
    useState<S>(init: S | (() => S)) {
      const i = cursor++;
      if (!(i in state)) {
        state[i] = typeof init === "function" ? (init as () => S)() : init;
      }
      const set = (v: S | ((p: S) => S)) => {
        const next =
          typeof v === "function" ? (v as (p: S) => S)(state[i] as S) : v;
        if (Object.is(next, state[i])) return;
        state[i] = next;
        if (flushing) dirty = true;
        else rerender?.();
      };
      return [state[i] as S, set] as const;
    },
    useEffect(fn: () => void | (() => void), deps?: unknown[]) {
      const i = effectCursor++;
      const prev = effects[i];
      if (prev && same(prev.deps, deps)) return;
      pending.push(() => {
        if (prev && typeof prev.cleanup === "function") prev.cleanup();
        effects[i] = { deps, cleanup: fn() };
      });
    },
  };
});

vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  useState: runtime.useState,
  useEffect: runtime.useEffect,
}));

import {
  attachScrollFade,
  useScrollFade,
} from "@/components/tools/useScrollFade";

class FakeScroller {
  scrollLeft = 0;
  scrollWidth = 600;
  clientWidth = 300;
  children: unknown[] = [];
  listeners = new Set<() => void>();
  addEventListener(_t: "scroll", fn: () => void) {
    this.listeners.add(fn);
  }
  removeEventListener(_t: "scroll", fn: () => void) {
    this.listeners.delete(fn);
  }
  scrollTo(x: number) {
    this.scrollLeft = x;
    this.listeners.forEach((fn) => fn());
  }
}

type Hook = ReturnType<typeof useScrollFade<HTMLElement>>;

function mountHook() {
  let out!: Hook;
  const render = () => {
    runtime.begin(render);
    out = useScrollFade<HTMLElement>();
  };
  render();
  runtime.flush();
  return {
    get current() {
      return out;
    },
    /** React calls the callback ref, then commits effects. */
    setNode(node: FakeScroller | null) {
      out.ref(node as unknown as HTMLElement | null);
      runtime.flush();
    },
  };
}

const maskOf = (h: Hook) =>
  (h.style as { maskImage?: string }).maskImage ?? "none";

describe("useScrollFade lifecycle", () => {
  beforeEach(() => runtime.reset());
  afterEach(() => runtime.reset());

  it("attaches when the scroller mounts after the hook (deep link to runner)", () => {
    const hook = mountHook();
    expect(maskOf(hook.current)).toBe("none");
    const el = new FakeScroller();
    hook.setNode(el);
    expect(el.listeners.size).toBe(1);
    expect(maskOf(hook.current)).toContain("transparent 100%");
  });

  it("follows the scroller across unmount and remount", () => {
    const hook = mountHook();
    const first = new FakeScroller();
    hook.setNode(first);
    first.scrollTo(150);
    expect(maskOf(hook.current)).toMatch(/^linear-gradient\(to right, transparent 0/);

    // Runner opens: hub (and its scroller) unmounts.
    hook.setNode(null);
    expect(first.listeners.size).toBe(0);
    expect(maskOf(hook.current)).toBe("none");

    // Back to the hub: a brand-new scroller node at scrollLeft 0.
    const second = new FakeScroller();
    hook.setNode(second);
    expect(second.listeners.size).toBe(1);
    expect(maskOf(hook.current)).toMatch(/^linear-gradient\(to right, #000 0/);

    // The new node drives the fade; the old one is inert.
    second.scrollTo(300);
    expect(maskOf(hook.current)).toBe(
      "linear-gradient(to right, transparent 0, #000 24px, #000 100%)",
    );
    first.scrollTo(0);
    expect(first.listeners.size).toBe(0);
    expect(maskOf(hook.current)).toBe(
      "linear-gradient(to right, transparent 0, #000 24px, #000 100%)",
    );
  });

  it("clears the fade when remounted content fits", () => {
    const hook = mountHook();
    hook.setNode(new FakeScroller());
    hook.setNode(null);
    const fits = new FakeScroller();
    fits.scrollWidth = 300;
    hook.setNode(fits);
    expect(maskOf(hook.current)).toBe("none");
  });
});

describe("attachScrollFade", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("observes chips that mount after attach, and tears down fully", () => {
    const observed = new Set<unknown>();
    let ros = 0;
    let mutate: (() => void) | null = null;
    let moOff = false;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor() {
          ros++;
        }
        observe(t: unknown) {
          observed.add(t);
        }
        disconnect() {
          observed.clear();
        }
      },
    );
    vi.stubGlobal(
      "MutationObserver",
      class {
        constructor(cb: () => void) {
          mutate = cb;
        }
        observe() {}
        disconnect() {
          moOff = true;
        }
      },
    );
    const el = new FakeScroller();
    const chipA = { id: "a" };
    el.children = [chipA];
    const update = vi.fn();
    const off = attachScrollFade(el, update);
    expect(ros).toBe(1);
    expect(observed.has(el) && observed.has(chipA)).toBe(true);

    const chipB = { id: "b" };
    el.children = [chipA, chipB];
    mutate!();
    expect(observed.has(chipB)).toBe(true);
    expect(update).toHaveBeenCalledTimes(2);

    off();
    expect(el.listeners.size).toBe(0);
    expect(observed.size).toBe(0);
    expect(moOff).toBe(true);
  });
});
