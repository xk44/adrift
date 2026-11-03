import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUIStore } from "@/store";
import {
  NavQueryMemory,
  applyInitialUrl,
  navQueryMemory,
  navTransitionHref,
  navigateTo,
  navigateToPath,
  persistentSearch,
  startNavUrlSync,
} from "@/lib/navUrlSync";

/** Minimal window: location + a real back/forward stack + popstate. */
function fakeWindow(start: string) {
  const location = { pathname: "/", search: "", hash: "" };
  const go = (href: string) => {
    const url = new URL(href, `http://adrift.test${location.pathname}`);
    location.pathname = url.pathname;
    location.search = url.search;
    location.hash = url.hash;
  };
  go(start);
  const stack = [start];
  let index = 0;
  const listeners = new Set<() => void>();
  const history = {
    pushState: vi.fn((_s: unknown, _t: string, href: string) => {
      go(href);
      stack.splice(index + 1, Infinity, location.pathname + location.search);
      index = stack.length - 1;
    }),
    replaceState: vi.fn((_s: unknown, _t: string, href: string) => {
      go(href);
      stack[index] = location.pathname + location.search;
    }),
    back: () => {
      index -= 1;
      go(stack[index]);
      listeners.forEach((fn) => fn());
    },
  };
  return {
    location,
    history,
    addEventListener: (type: string, fn: () => void) => {
      if (type === "popstate") listeners.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      if (type === "popstate") listeners.delete(fn);
    },
  };
}

let win: ReturnType<typeof fakeWindow>;
let stop: () => void = () => {};
const href = () => win.location.pathname + win.location.search;

function boot(start: string) {
  win = fakeWindow(start);
  vi.stubGlobal("window", win);
  applyInitialUrl();
  stop = startNavUrlSync();
}

beforeEach(() => {
  navQueryMemory.clear();
  useUIStore.setState({ activeNav: "create", navParams: {} });
});

afterEach(() => {
  stop();
  vi.unstubAllGlobals();
});

describe("persistentSearch / NavQueryMemory", () => {
  it("drops the lightbox's transient ?image=", () => {
    expect(persistentSearch("?view=videos&image=abc")).toBe("?view=videos");
    expect(persistentSearch("?image=abc")).toBe("");
    expect(persistentSearch("")).toBe("");
  });

  it("remembers per pathname and forgets on a bare leave", () => {
    const m = new NavQueryMemory();
    m.remember("/explore/", "?view=videos");
    expect(m.recall("/explore")).toBe("?view=videos");
    m.remember("/explore", "");
    expect(m.recall("/explore")).toBe("");
  });

  it("navTransitionHref restores the target's query, null when staying", () => {
    const m = new NavQueryMemory();
    m.remember("/explore", "?src=civitai");
    expect(
      navTransitionHref(
        m,
        { pathname: "/tools", search: "?tool=upscale" },
        "/explore",
      ),
    ).toBe("/explore?src=civitai");
    expect(m.recall("/tools")).toBe("?tool=upscale");
    expect(
      navTransitionHref(
        m,
        { pathname: "/explore", search: "?q=x" },
        "/explore",
      ),
    ).toBeNull();
  });
});

describe("nav URL sync", () => {
  it("keeps the query of the URL the app was opened on", () => {
    boot("/explore?view=videos&src=civitai");
    expect(useUIStore.getState().activeNav).toBe("explore");
    expect(href()).toBe("/explore?view=videos&src=civitai");
    expect(win.history.pushState).not.toHaveBeenCalled();
  });

  it("restores a page's filters when the sidebar navigates back to it", () => {
    boot("/explore?view=videos&src=civitai");
    useUIStore.getState().setActiveNav("create");
    expect(href()).toBe("/create");
    useUIStore.getState().setActiveNav("explore");
    expect(href()).toBe("/explore?view=videos&src=civitai");
  });

  it("has the target URL in place before the page reacts to the store", () => {
    boot("/explore?tab=top&period=month");
    useUIStore.getState().setActiveNav("create");
    let seenOnSwitch = "";
    const unsub = useUIStore.subscribe((s, prev) => {
      if (s.activeNav !== prev.activeNav) seenOnSwitch = href();
    });
    useUIStore.getState().setActiveNav("explore");
    unsub();
    expect(seenOnSwitch).toBe("/explore?tab=top&period=month");
  });

  it("navigateTo restores remembered filters and leaves the current page's query alone", () => {
    boot("/tools?tool=upscale");
    navigateTo("setup");
    expect(href()).toBe("/setup");
    navigateTo("tools");
    expect(href()).toBe("/tools?tool=upscale");
    const pushes = win.history.pushState.mock.calls.length;
    navigateTo("tools");
    expect(href()).toBe("/tools?tool=upscale");
    expect(win.history.pushState.mock.calls.length).toBe(pushes);
  });

  it("does not carry an open lightbox into the remembered query", () => {
    boot("/explore?view=videos&image=img-1");
    navigateTo("create");
    navigateTo("explore");
    expect(href()).toBe("/explore?view=videos");
  });

  it("follows back/forward without pushing", () => {
    boot("/explore?view=videos");
    navigateTo("create");
    const pushes = win.history.pushState.mock.calls.length;
    win.history.back();
    expect(useUIStore.getState().activeNav).toBe("explore");
    expect(href()).toBe("/explore?view=videos");
    expect(win.history.pushState.mock.calls.length).toBe(pushes);
  });

  it("navigateToPath keeps an explicit query, else uses the remembered one", () => {
    boot("/explore?view=videos");
    navigateToPath("/setup?tab=models&section=download");
    expect(href()).toBe("/setup?tab=models&section=download");
    expect(useUIStore.getState().activeNav).toBe("setup");
    navigateToPath("/explore");
    expect(href()).toBe("/explore?view=videos");
    navigateToPath("/setup");
    expect(href()).toBe("/setup?tab=models&section=download");
  });

  it("sends old Workflows / Pipelines / Manager links to Setup", () => {
    boot("/explore");
    navigateToPath("/workflows?tab=civitai&q=flux");
    expect(href()).toBe("/setup?tab=models&section=download&q=flux");
    expect(useUIStore.getState().activeNav).toBe("setup");
    navigateToPath("/pipelines");
    expect(href()).toBe("/setup?tab=routing");
    navigateToPath("/manager");
    expect(href()).toBe("/setup?tab=nodes");
  });

  it("rewrites an old Pipelines URL on first load", () => {
    boot("/pipelines");
    expect(useUIStore.getState().activeNav).toBe("setup");
    expect(href()).toBe("/setup?tab=routing");
  });

  it("canonicalises an alias path and keeps its query", () => {
    boot("/feed?view=videos");
    expect(useUIStore.getState().activeNav).toBe("explore");
    expect(href()).toBe("/explore?view=videos");
  });
});
