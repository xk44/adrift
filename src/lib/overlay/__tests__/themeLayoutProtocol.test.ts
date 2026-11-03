import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_KNOWN_MESSAGE_TYPES,
  HOST_MSG,
  OVERLAY_MSG,
  buildCjMessage,
  messageDirection,
  parseCjMessage,
} from "../protocol";
import { createOverlayInboundGuard, setActiveHostSession } from "../session";
import { requestHostLayout } from "@/hooks/useOverlayMode";
import { useUIStore, selectEffectiveTheme } from "@/store";
import { useOverlayStore } from "@/store/overlayStore";

const HOST = "http://127.0.0.1:8188";
const NONCE = "cj_sn_aaaaaaaaaaaaaaaaaaaaaaaa";
const parent = { name: "parent-window" };

const config = (nonce: string) =>
  buildCjMessage(
    HOST_MSG.CONFIG,
    {
      comfyUrl: HOST,
      wsUrl: "ws://127.0.0.1:8188",
      clientId: "cj_overlay_x",
      mode: "overlay",
      nonce,
    },
    nonce,
  );

describe("theme + layout message types", () => {
  it("are known and point the right way", () => {
    expect(HOST_MSG.THEME).toBe("cj:theme");
    expect(HOST_MSG.LAYOUT).toBe("cj:layout");
    expect(OVERLAY_MSG.SET_LAYOUT).toBe("cj:set-layout");
    for (const t of [HOST_MSG.THEME, HOST_MSG.LAYOUT, OVERLAY_MSG.SET_LAYOUT]) {
      expect(ALL_KNOWN_MESSAGE_TYPES.has(t)).toBe(true);
    }
    expect(messageDirection(HOST_MSG.THEME)).toBe("host→overlay");
    expect(messageDirection(HOST_MSG.LAYOUT)).toBe("host→overlay");
    expect(messageDirection(OVERLAY_MSG.SET_LAYOUT)).toBe("overlay→host");
  });

  it("cj:theme accepts only light/dark", () => {
    const ok = parseCjMessage(
      buildCjMessage(HOST_MSG.THEME, { mode: "light" }, NONCE),
    );
    expect(ok).toMatchObject({
      ok: true,
      type: "cj:theme",
      payload: { mode: "light" },
      nonce: NONCE,
    });
    for (const payload of [{ mode: "solarized" }, {}, { mode: 1 }]) {
      expect(parseCjMessage({ type: "cj:theme", payload }).ok).toBe(false);
    }
    expect(() => buildCjMessage(HOST_MSG.THEME, { mode: "sepia" })).toThrow();
  });

  it("cj:layout and cj:set-layout validate the layout", () => {
    expect(
      parseCjMessage({
        type: "cj:layout",
        payload: { layout: "panel", panelWidth: 480 },
      }).ok,
    ).toBe(true);
    expect(
      parseCjMessage({ type: "cj:layout", payload: { layout: "full" } }).ok,
    ).toBe(true);
    expect(
      parseCjMessage({
        type: "cj:layout",
        payload: { layout: "panel", panelWidth: -5 },
      }).ok,
    ).toBe(false);
    expect(
      parseCjMessage({ type: "cj:set-layout", payload: { layout: "panel" } })
        .ok,
    ).toBe(true);
    expect(
      parseCjMessage({ type: "cj:set-layout", payload: { layout: "left" } }).ok,
    ).toBe(false);
  });
});

describe("overlay inbound guard: theme + layout", () => {
  const connectedGuard = () => {
    const guard = createOverlayInboundGuard({
      expectedSource: parent,
      parentOrigin: HOST,
    });
    expect(
      guard.accept({ data: config(NONCE), origin: HOST, source: parent }).ok,
    ).toBe(true);
    return guard;
  };

  it("accepts cj:theme from the parent with the session nonce", () => {
    const guard = connectedGuard();
    const d = guard.accept({
      data: buildCjMessage(HOST_MSG.THEME, { mode: "dark" }, NONCE),
      origin: HOST,
      source: parent,
    });
    expect(d.ok && d.message.payload).toEqual({ mode: "dark" });
  });

  it("drops cj:theme / cj:layout with a stale nonce, wrong origin or wrong source", () => {
    const guard = connectedGuard();
    const theme = buildCjMessage(
      HOST_MSG.THEME,
      { mode: "light" },
      "cj_sn_old",
    );
    expect(guard.accept({ data: theme, origin: HOST, source: parent })).toEqual(
      {
        ok: false,
        reason: "nonce",
      },
    );
    const layout = buildCjMessage(HOST_MSG.LAYOUT, { layout: "panel" }, NONCE);
    expect(
      guard.accept({
        data: layout,
        origin: "https://evil.example",
        source: parent,
      }),
    ).toEqual({ ok: false, reason: "origin" });
    expect(
      guard.accept({ data: layout, origin: HOST, source: { other: 1 } }),
    ).toEqual({ ok: false, reason: "source" });
  });

  it("never accepts the overlay's own cj:set-layout as inbound", () => {
    const guard = connectedGuard();
    const d = guard.accept({
      data: buildCjMessage(OVERLAY_MSG.SET_LAYOUT, { layout: "panel" }, NONCE),
      origin: HOST,
      source: parent,
    });
    expect(d).toEqual({ ok: false, reason: "direction" });
  });
});

describe("requestHostLayout", () => {
  afterEach(() => setActiveHostSession(null));

  it("sends nothing before the host session exists", () => {
    const postMessage = vi.fn();
    setActiveHostSession(null);
    expect(
      requestHostLayout("panel", { parent: { postMessage } } as never),
    ).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("posts a nonce'd cj:set-layout to the host origin only", () => {
    const postMessage = vi.fn();
    setActiveHostSession({ nonce: NONCE, origin: HOST });
    expect(
      requestHostLayout("panel", { parent: { postMessage } } as never),
    ).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [msg, target] = postMessage.mock.calls[0];
    expect(target).toBe(HOST);
    expect(parseCjMessage(msg)).toMatchObject({
      ok: true,
      type: "cj:set-layout",
      payload: { layout: "panel" },
      nonce: NONCE,
    });
  });
});

describe("host theme in the UI store", () => {
  beforeEach(() => {
    useUIStore.setState({
      theme: "dark",
      followSystem: false,
      hostTheme: null,
    });
  });

  it("host mode wins without touching the user's own theme", () => {
    useUIStore.getState().setHostTheme("light");
    const s = useUIStore.getState();
    expect(s.theme).toBe("dark");
    expect(selectEffectiveTheme(s)).toBe("light");
    useUIStore.getState().setHostTheme(null);
    expect(selectEffectiveTheme(useUIStore.getState())).toBe("dark");
  });

  it("is never persisted", () => {
    useUIStore.getState().setHostTheme("light");
    const persistOpts = (
      useUIStore as unknown as {
        persist: { getOptions: () => { partialize: (s: unknown) => object } };
      }
    ).persist.getOptions();
    expect("hostTheme" in persistOpts.partialize(useUIStore.getState())).toBe(
      false,
    );
  });

  it("an explicit pick in Adrift clears the host override", () => {
    useUIStore.getState().setHostTheme("light");
    // Toggling flips what is shown (light), not the stored dark.
    useUIStore.getState().toggleTheme();
    expect(useUIStore.getState()).toMatchObject({
      theme: "dark",
      hostTheme: null,
    });
    useUIStore.getState().setHostTheme("light");
    useUIStore.getState().setTheme("dark");
    expect(useUIStore.getState().hostTheme).toBeNull();
  });
});

describe("host layout in the overlay store", () => {
  it("is set by the host and cleared with the session", () => {
    useOverlayStore.getState().setHostLayout("panel");
    expect(useOverlayStore.getState().hostLayout).toBe("panel");
    useOverlayStore.getState().resetSession();
    expect(useOverlayStore.getState().hostLayout).toBeNull();
  });
});
