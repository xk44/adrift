/**
 * Behavioural tests for the ComfyUI-side overlay bridge
 * (comfy_nodes/adrift_overlay/web/adrift_overlay.js).
 *
 * The bridge is a bundler-free ComfyUI web extension, so it is evaluated
 * here with its `app` import swapped for a stub. Every message it posts to
 * the overlay is run through the app's own parseCjMessage, so host/overlay
 * schema drift fails these tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCjMessage } from "@/lib/overlay/protocol";

const BRIDGE_PATH = join(
  process.cwd(),
  "comfy_nodes/adrift_overlay/web/adrift_overlay.js",
);

describe("bridge pack files", () => {
  it("manifest lists only the bridge", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(process.cwd(), "comfy_nodes/adrift_overlay/web/manifest.json"),
        "utf8",
      ),
    ) as { files: string[] };
    expect(manifest.files).toEqual(["adrift_overlay.js"]);
  });

  it("delegates clipboard read + write to the framed app", () => {
    const src = readFileSync(BRIDGE_PATH, "utf8");
    expect(src).toContain('iframe.allow = "clipboard-read; clipboard-write";');
  });
});

const EXPORTS = [
  "handleMessageFromOverlay",
  "getAdriftUrl",
  "loadPackConfig",
  "overlayState",
  "sendToOverlay",
  "sanitizeSyncedSettings",
  "setupExecutionForwarding",
  "setOverlayLayout",
  "restoreOverlayLayout",
  "clampPanelWidth",
  "detectComfyTheme",
  "sendThemeToOverlay",
  "parseCssColor",
];

interface Posted {
  message: { type: string; payload: Record<string, unknown>; nonce?: unknown };
  targetOrigin: string;
}

interface LoadOptions {
  search?: string;
  stored?: string | null;
  /** Per-key localStorage contents; overrides `stored`. */
  storedByKey?: Record<string, string>;
  protocol?: "http:" | "https:";
  host?: string;
  fetchImpl?: (url: string, init?: unknown) => Promise<unknown>;
  graph?: unknown;
  /** ComfyUI palette CSS variables on :root (enables theme detection) */
  cssVars?: Record<string, string>;
  innerWidth?: number;
  /** Another copy of the bridge already ran in this page */
  preloaded?: boolean;
}

function loadBridge(opts: LoadOptions = {}) {
  const src = readFileSync(BRIDGE_PATH, "utf8");
  const importLine = /^import \{ app \} from "\.\.\/\.\.\/scripts\/app\.js";$/m;
  expect(src).toMatch(importLine);
  const body =
    src.replace(importLine, "") + `\nreturn { ${EXPORTS.join(", ")} };`;

  const protocol = opts.protocol ?? "http:";
  const host = opts.host ?? "127.0.0.1:8188";
  const hostname = host.replace(/:\d+$/, "");
  const location = {
    search: opts.search ?? "",
    protocol,
    host,
    hostname,
    port: host.includes(":") ? host.split(":").pop() : "",
    origin: `${protocol}//${host}`,
  };
  const cssVars = opts.cssVars;
  const win = {
    location,
    innerWidth: opts.innerWidth ?? 1600,
    addEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    ...(opts.preloaded ? { __adriftOverlayLoaded: true } : {}),
    ...(cssVars
      ? {
          getComputedStyle: () => ({
            getPropertyValue: (name: string) => cssVars[name] ?? "",
          }),
        }
      : {}),
  };
  const doc = cssVars ? { documentElement: {} } : {};
  const storage = {
    getItem: vi.fn((key: string) =>
      opts.storedByKey
        ? (opts.storedByKey[key] ?? null)
        : (opts.stored ?? null),
    ),
    setItem: vi.fn(),
  };
  const apiHandlers: Record<string, (event: unknown) => void> = {};
  const app = {
    registerExtension: vi.fn(),
    graph: opts.graph ?? { serialize: () => ({ nodes: [], links: [] }) },
    api: {
      addEventListener: (name: string, fn: (event: unknown) => void) => {
        apiHandlers[name] = fn;
      },
    },
    loadGraphData: vi.fn(),
  };
  const fetchMock = vi.fn(
    opts.fetchImpl ??
      (async () => ({ ok: true, status: 200, json: async () => ({}) })),
  );

  const factory = new Function(
    "app",
    "window",
    "localStorage",
    "fetch",
    "document",
    body,
  );
  const bridge = factory(app, win, storage, fetchMock, doc) as Record<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  >;

  const posted: Posted[] = [];
  const frameWindow = {
    postMessage: vi.fn((message: Posted["message"], targetOrigin: string) => {
      posted.push({ message, targetOrigin });
    }),
  };
  bridge.overlayState.overlayFrame = { contentWindow: frameWindow };

  const fromFrame = (data: unknown, origin = "http://localhost:3000") =>
    bridge.handleMessageFromOverlay({ data, origin, source: frameWindow });

  return {
    bridge,
    app,
    win,
    storage,
    posted,
    frameWindow,
    fromFrame,
    fetchMock,
    apiHandlers,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("overlay host bridge: message source + origin", () => {
  it("ignores messages from any window other than its own iframe", () => {
    const { bridge, posted, fetchMock } = loadBridge();
    const otherFrame = { postMessage: vi.fn() };
    // Same origin as ComfyUI (allowlisted) but a different window.
    bridge.handleMessageFromOverlay({
      data: { type: "cj:queue", payload: { prompt: { "1": {} } } },
      origin: "http://127.0.0.1:8188",
      source: otherFrame,
    });
    bridge.handleMessageFromOverlay({
      data: { type: "cj:hello", payload: { name: "adrift", version: 1 } },
      origin: "http://localhost:3000",
      source: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);
  });

  it("still rejects its own iframe when the origin is not allowlisted", () => {
    const { posted, fromFrame } = loadBridge();
    fromFrame(
      { type: "cj:hello", payload: { name: "adrift", version: 1 } },
      "https://evil.example",
    );
    expect(posted).toHaveLength(0);
  });
});

describe("overlay host bridge: handshake", () => {
  it("answers hello with a schema-valid config carrying a session nonce", () => {
    const { bridge, posted, fromFrame } = loadBridge();
    fromFrame({
      type: "cj:hello",
      payload: { name: "adrift", version: 1 },
    });
    // Config first, then the session's current layout (no palette to read).
    expect(posted.map((p) => p.message.type)).toEqual([
      "cj:config",
      "cj:layout",
    ]);
    expect(parseCjMessage(posted[1].message).ok).toBe(true);
    expect(posted[1].message.payload).toEqual({ layout: "full" });
    expect(posted[1].message.nonce).toBe(bridge.overlayState.sessionNonce);
    const { message, targetOrigin } = posted[0];
    expect(targetOrigin).toBe("http://localhost:3000");
    const parsed = parseCjMessage(message);
    expect(parsed.ok).toBe(true);
    expect(message.type).toBe("cj:config");
    expect(message.payload.comfyUrl).toBe("http://127.0.0.1:8188");
    expect(message.payload.wsUrl).toBe("ws://127.0.0.1:8188");
    expect(message.nonce).toBe(bridge.overlayState.sessionNonce);
    expect(message.payload.nonce).toBe(bridge.overlayState.sessionNonce);
  });

  it("uses wss and the page's own port for an https ComfyUI", () => {
    const { posted, fromFrame } = loadBridge({
      protocol: "https:",
      host: "comfy.lan",
      search: "?cj_url=https://comfy.lan:3443",
    });
    fromFrame(
      { type: "cj:hello", payload: { name: "adrift", version: 1 } },
      "https://comfy.lan:3443",
    );
    const cfg = posted[0].message.payload;
    expect(cfg.comfyUrl).toBe("https://comfy.lan");
    expect(cfg.wsUrl).toBe("wss://comfy.lan");
  });

  it("re-arms readiness on every hello so a reloaded overlay gets the workflow again", () => {
    const { bridge, posted, fromFrame } = loadBridge();
    fromFrame({
      type: "cj:hello",
      payload: { name: "adrift", version: 1 },
    });
    fromFrame({ type: "cj:ready", payload: { timestamp: 1 } });
    expect(bridge.overlayState.overlayReady).toBe(true);
    const firstNonce = bridge.overlayState.sessionNonce;

    // Overlay reloads: new hello must drop readiness until its ready.
    fromFrame({
      type: "cj:hello",
      payload: { name: "adrift", version: 1 },
    });
    expect(bridge.overlayState.overlayReady).toBe(false);
    expect(bridge.overlayState.sessionNonce).not.toBe(firstNonce);
    fromFrame({ type: "cj:ready", payload: { timestamp: 2 } });

    const workflows = posted.filter((p) => p.message.type === "cj:workflow");
    expect(workflows).toHaveLength(2);
    for (const wf of workflows) {
      expect(parseCjMessage(wf.message).ok).toBe(true);
      expect(typeof wf.message.payload.revision).toBe("number");
    }
    expect(workflows[1].message.nonce).toBe(bridge.overlayState.sessionNonce);
    expect(bridge.overlayState.lastWorkflowHash).not.toBeNull();
  });

  it("omits a null nonce instead of sending one the schema rejects", () => {
    const { bridge, posted } = loadBridge();
    expect(bridge.overlayState.sessionNonce).toBeNull();
    bridge.sendToOverlay({
      type: "cj:visibility",
      payload: { visible: true },
      version: 1,
      nonce: bridge.overlayState.sessionNonce,
    });
    expect("nonce" in posted[0].message).toBe(false);
    expect(parseCjMessage(posted[0].message).ok).toBe(true);
  });

  it("swallows postMessage clone errors instead of throwing into ComfyUI callbacks", () => {
    const { bridge, frameWindow } = loadBridge();
    frameWindow.postMessage.mockImplementationOnce(() => {
      throw new Error("DataCloneError");
    });
    expect(() =>
      bridge.sendToOverlay({ type: "cj:pong", payload: { timestamp: 1 } }),
    ).not.toThrow();
  });
});

describe("overlay host bridge: cj_url handling", () => {
  it("never frames a javascript: or data: URL", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "not a url",
    ]) {
      const { bridge } = loadBridge({
        search: `?cj_url=${encodeURIComponent(bad)}`,
        stored: bad,
      });
      expect(bridge.getAdriftUrl()).toBe("http://localhost:3000");
    }
  });

  it("only honors ?cj_url= for loopback or the ComfyUI host", () => {
    expect(
      loadBridge({
        search: "?cj_url=https://evil.example",
      }).bridge.getAdriftUrl(),
    ).toBe("http://localhost:3000");
    expect(
      loadBridge({
        search: "?cj_url=http://127.0.0.1:3001",
      }).bridge.getAdriftUrl(),
    ).toBe("http://127.0.0.1:3001/");
  });

  it("still accepts an explicit http(s) URL saved in localStorage", () => {
    const { bridge } = loadBridge({ stored: "http://203.0.113.20:3000" });
    expect(bridge.getAdriftUrl()).toBe("http://203.0.113.20:3000/");
  });

  it("falls back to the URL saved under the pre-rename key", () => {
    const legacy = loadBridge({
      storedByKey: { comfyjourney_overlay_url: "http://203.0.113.21:3000" }, // legacy-name
    });
    expect(legacy.bridge.getAdriftUrl()).toBe("http://203.0.113.21:3000/");
    const both = loadBridge({
      storedByKey: {
        adrift_overlay_url: "http://203.0.113.22:3000",
        comfyjourney_overlay_url: "http://203.0.113.21:3000", // legacy-name
      },
    });
    expect(both.bridge.getAdriftUrl()).toBe("http://203.0.113.22:3000/");
  });
});

describe("overlay host bridge: queue", () => {
  it("acks an accepted prompt with a promptId the overlay schema keeps", async () => {
    const { posted, fromFrame } = loadBridge({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ prompt_id: "abc-123", number: 4 }),
      }),
    });
    fromFrame({
      type: "cj:queue",
      payload: { prompt: { "1": { class_type: "X" } } },
    });
    await flush();
    expect(posted).toHaveLength(1);
    const parsed = parseCjMessage(posted[0].message);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.type).toBe("cj:ack");
    expect((parsed.payload as { promptId?: string }).promptId).toBe("abc-123");
  });

  it("reports a ComfyUI 400 validation failure as QUEUE_FAILED, not an ack", async () => {
    const { posted, fromFrame } = loadBridge({
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            type: "prompt_outputs_failed_validation",
            message: "Prompt outputs failed validation",
          },
          node_errors: {},
        }),
      }),
    });
    fromFrame({ type: "cj:queue", payload: { prompt: { "1": {} } } });
    await flush();
    expect(posted).toHaveLength(1);
    expect(posted[0].message.type).toBe("cj:error");
    expect(posted[0].message.payload.code).toBe("QUEUE_FAILED");
    expect(String(posted[0].message.payload.message)).toContain(
      "failed validation",
    );
    expect(parseCjMessage(posted[0].message).ok).toBe(true);
  });

  it("rejects a non-object prompt without calling /prompt", async () => {
    const { posted, fromFrame, fetchMock } = loadBridge();
    fromFrame({ type: "cj:queue", payload: { prompt: "rm -rf" } });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(posted[0].message.type).toBe("cj:error");
  });
});

describe("overlay host bridge: execution forwarding stays schema-valid", () => {
  it("drops non-integer subgraph node ids instead of the whole progress event", () => {
    const { bridge, posted, apiHandlers } = loadBridge();
    bridge.setupExecutionForwarding();
    apiHandlers.progress({
      detail: { prompt_id: "p1", value: 3, max: 20, node: "12:5" },
    });
    apiHandlers.progress({
      detail: { prompt_id: "p1", value: 4, max: 20, node: "7" },
    });
    expect(posted).toHaveLength(2);
    expect(parseCjMessage(posted[0].message).ok).toBe(true);
    expect("nodeId" in posted[0].message.payload).toBe(false);
    expect(posted[1].message.payload.nodeId).toBe(7);
  });

  it("filters malformed image entries so the rest of the batch arrives", () => {
    const { bridge, posted, apiHandlers } = loadBridge();
    bridge.setupExecutionForwarding();
    apiHandlers.executed({
      detail: {
        prompt_id: "p2",
        output: {
          images: [
            { filename: "", type: "output" },
            { filename: "ok.png", subfolder: "a", type: "output" },
            { filename: "odd.png", type: "weird" },
          ],
        },
      },
    });
    expect(posted).toHaveLength(1);
    const parsed = parseCjMessage(posted[0].message);
    expect(parsed.ok).toBe(true);
    expect(posted[0].message.payload.images).toEqual([
      { filename: "ok.png", subfolder: "a", type: "output" },
      { filename: "odd.png", subfolder: "", type: "output" },
    ]);
  });

  it("keeps only schema-valid synced settings", () => {
    const { bridge } = loadBridge();
    expect(
      bridge.sanitizeSyncedSettings({
        seed: 42,
        steps: "20",
        cfg: 0,
        sampler: "euler",
        scheduler: null,
        denoise: 1.5,
        width: 1024,
        height: 1024.5,
        positivePrompt: "a cat",
      }),
    ).toEqual({
      seed: 42,
      sampler: "euler",
      width: 1024,
      positivePrompt: "a cat",
    });
  });
});

describe("overlay host bridge: edit in ComfyUI (load-workflow + show-graph)", () => {
  const UI_WF = { nodes: [{ id: 1, type: "KSampler" }], links: [] };

  function connected(opts: LoadOptions = {}) {
    const h = loadBridge(opts);
    h.fromFrame({ type: "cj:hello", payload: { name: "adrift", version: 1 } });
    h.bridge.overlayState.overlayContainer = { style: {} };
    h.bridge.overlayState.toggleBtn = { style: {}, innerHTML: "" };
    h.bridge.overlayState.visible = true;
    h.posted.length = 0;
    return { ...h, nonce: h.bridge.overlayState.sessionNonce as string };
  }

  it("drops load-workflow and show-graph without the session nonce", () => {
    const { bridge, app, fromFrame } = connected();
    fromFrame({ type: "cj:load-workflow", payload: { workflow: UI_WF } });
    fromFrame({ type: "cj:load-workflow", payload: { workflow: UI_WF }, nonce: "stale" });
    fromFrame({ type: "cj:show-graph", payload: {} });
    expect(app.loadGraphData).not.toHaveBeenCalled();
    expect(bridge.overlayState.visible).toBe(true);
  });

  it("opens a named saved workflow via loadGraphData and acks", () => {
    const { app, posted, fromFrame, nonce } = connected();
    (app as Record<string, unknown>).extensionManager = { workflow: {} };
    fromFrame({
      type: "cj:load-workflow",
      payload: { workflow: UI_WF, name: "sub/foo.json" },
      nonce,
    });
    expect(app.loadGraphData).toHaveBeenCalledWith(UI_WF, true, true, "sub/foo.json");
    expect(posted.at(-1)?.message.type).toBe("cj:ack");
    expect(parseCjMessage(posted.at(-1)!.message).ok).toBe(true);
  });

  it("ignores a traversal name and loads unnamed", () => {
    const { app, fromFrame, nonce } = connected();
    fromFrame({
      type: "cj:load-workflow",
      payload: { workflow: UI_WF, name: "../../secrets.json" },
      nonce,
    });
    expect(app.loadGraphData).toHaveBeenCalledWith(UI_WF);
  });

  it("uses loadApiJson for an API-format file", () => {
    const { app, fromFrame, nonce } = connected();
    const loadApiJson = vi.fn();
    (app as Record<string, unknown>).loadApiJson = loadApiJson;
    const api = { "1": { class_type: "KSampler", inputs: {} } };
    fromFrame({ type: "cj:load-workflow", payload: { workflow: api, name: "a.json" }, nonce });
    expect(loadApiJson).toHaveBeenCalledWith(api, "a.json");
    expect(app.loadGraphData).not.toHaveBeenCalled();
  });

  it("asks before replacing a non-empty graph on the legacy single-graph UI", () => {
    const { app, win, posted, fromFrame, nonce } = connected({
      graph: { _nodes: [{}], serialize: () => ({ nodes: [], links: [] }) },
    });
    (win as Record<string, unknown>).confirm = vi.fn(() => false);
    fromFrame({ type: "cj:load-workflow", payload: { workflow: UI_WF, name: "a.json" }, nonce });
    expect(app.loadGraphData).not.toHaveBeenCalled();
    expect(posted.at(-1)?.message.payload).toMatchObject({ accepted: false });
  });

  it("show-graph with the nonce hides the overlay", () => {
    const { bridge, fromFrame, nonce } = connected();
    fromFrame({ type: "cj:show-graph", payload: {}, nonce });
    expect(bridge.overlayState.visible).toBe(false);
    expect(bridge.overlayState.overlayContainer.style.display).toBe("none");
  });
});

describe("overlay host bridge: docked panel layout", () => {
  function connected(opts: LoadOptions = {}) {
    const h = loadBridge(opts);
    h.fromFrame({ type: "cj:hello", payload: { name: "adrift", version: 1 } });
    h.bridge.overlayState.overlayContainer = { style: {} };
    h.bridge.overlayState.resizeHandle = { style: {} };
    h.posted.length = 0;
    return { ...h, nonce: h.bridge.overlayState.sessionNonce as string };
  }

  it("docks as a right panel on a nonce'd set-layout and reports it back", () => {
    const { bridge, storage, posted, fromFrame, nonce } = connected();
    fromFrame({ type: "cj:set-layout", payload: { layout: "panel" }, nonce });
    const style = bridge.overlayState.overlayContainer.style;
    expect(bridge.overlayState.layout).toBe("panel");
    expect(style.width).toBe("480px");
    expect(style.right).toBe("0");
    expect(style.left).toBe("auto");
    expect(bridge.overlayState.resizeHandle.style.display).toBe("block");
    expect(storage.setItem).toHaveBeenCalledWith("adrift_overlay_layout", "panel");
    expect(storage.setItem).toHaveBeenCalledWith("adrift_overlay_panel_width", "480");
    const msg = posted.at(-1)!.message;
    expect(parseCjMessage(msg).ok).toBe(true);
    expect(msg).toMatchObject({
      type: "cj:layout",
      payload: { layout: "panel", panelWidth: 480 },
      nonce,
    });

    fromFrame({ type: "cj:set-layout", payload: { layout: "full" }, nonce });
    expect(style.width).toBe("100vw");
    expect(bridge.overlayState.resizeHandle.style.display).toBe("none");
    expect(posted.at(-1)!.message.payload).toEqual({ layout: "full" });
  });

  it("drops set-layout without the session nonce, from a foreign origin, or with a bad layout", () => {
    const { bridge, posted, fromFrame, nonce } = connected();
    fromFrame({ type: "cj:set-layout", payload: { layout: "panel" } });
    fromFrame({ type: "cj:set-layout", payload: { layout: "panel" }, nonce: "stale" });
    fromFrame(
      { type: "cj:set-layout", payload: { layout: "panel" }, nonce },
      "https://evil.example",
    );
    fromFrame({ type: "cj:set-layout", payload: { layout: "sideways" }, nonce });
    expect(bridge.overlayState.layout).toBe("full");
    expect(posted).toHaveLength(0);
  });

  it("restores a saved layout and clamps a stale width to the viewport", () => {
    const { bridge } = loadBridge({
      innerWidth: 900,
      storedByKey: {
        adrift_overlay_layout: "panel",
        adrift_overlay_panel_width: "5000",
      },
    });
    bridge.restoreOverlayLayout();
    expect(bridge.overlayState.layout).toBe("panel");
    bridge.overlayState.overlayContainer = { style: {} };
    bridge.setOverlayLayout("panel");
    // 900 viewport - 160 canvas gutter
    expect(bridge.overlayState.overlayContainer.style.width).toBe("740px");
  });

  it("ignores garbage in storage", () => {
    const { bridge } = loadBridge({
      storedByKey: {
        adrift_overlay_layout: "<script>",
        adrift_overlay_panel_width: "wide",
      },
    });
    bridge.restoreOverlayLayout();
    expect(bridge.overlayState.layout).toBe("full");
    expect(bridge.overlayState.panelWidth).toBe(480);
  });

  it("clamps panel width between the minimum and the canvas gutter", () => {
    const { bridge } = loadBridge();
    expect(bridge.clampPanelWidth(100, 1600)).toBe(360);
    expect(bridge.clampPanelWidth(700, 1600)).toBe(700);
    expect(bridge.clampPanelWidth(1590, 1600)).toBe(1440);
    expect(bridge.clampPanelWidth(Number.NaN, 1600)).toBe(480);
  });
});

describe("overlay host bridge: theme sync", () => {
  it("reads light/dark from the ComfyUI palette background", () => {
    expect(
      loadBridge({ cssVars: { "--comfy-menu-bg": "#353535" } }).bridge.detectComfyTheme(),
    ).toBe("dark");
    expect(
      loadBridge({ cssVars: { "--comfy-menu-bg": " #ffffff" } }).bridge.detectComfyTheme(),
    ).toBe("light");
    expect(
      loadBridge({ cssVars: { "--bg-color": "rgb(240, 240, 240)" } }).bridge.detectComfyTheme(),
    ).toBe("light");
    expect(loadBridge().bridge.detectComfyTheme()).toBeNull();
  });

  it("falls back to the palette setting when no colors are readable", () => {
    const h = loadBridge();
    (h.app as Record<string, unknown>).extensionManager = {
      setting: { get: (id: string) => (id === "Comfy.ColorPalette" ? "light" : null) },
    };
    expect(h.bridge.detectComfyTheme()).toBe("light");
  });

  it("parses css colors", () => {
    const { bridge } = loadBridge();
    expect(bridge.parseCssColor("#fff")).toEqual([255, 255, 255]);
    expect(bridge.parseCssColor("#202020ff")).toEqual([32, 32, 32]);
    expect(bridge.parseCssColor("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3]);
    expect(bridge.parseCssColor("var(--x)")).toBeNull();
  });

  it("posts a nonce'd, schema-valid cj:theme after the handshake, then only on change", () => {
    const vars: Record<string, string> = { "--comfy-menu-bg": "#ffffff" };
    const { bridge, posted, fromFrame } = loadBridge({ cssVars: vars });
    // No session yet: nothing to send.
    bridge.sendThemeToOverlay(true);
    expect(posted).toHaveLength(0);

    fromFrame({ type: "cj:hello", payload: { name: "adrift", version: 1 } });
    const theme = posted.filter((p) => p.message.type === "cj:theme");
    expect(theme).toHaveLength(1);
    expect(parseCjMessage(theme[0].message).ok).toBe(true);
    expect(theme[0].message.payload).toEqual({ mode: "light" });
    expect(theme[0].message.nonce).toBe(bridge.overlayState.sessionNonce);
    expect(theme[0].targetOrigin).toBe("http://localhost:3000");

    posted.length = 0;
    bridge.sendThemeToOverlay(false);
    expect(posted).toHaveLength(0);
    vars["--comfy-menu-bg"] = "#1e1e1e";
    bridge.sendThemeToOverlay(false);
    expect(posted.map((p) => p.message.payload)).toEqual([{ mode: "dark" }]);
  });
});

describe("overlay host bridge: pack config + single registration", () => {
  it("uses web/adrift_config.json when nothing is saved locally", async () => {
    const { bridge, fetchMock } = loadBridge({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ adriftUrl: "http://203.0.113.30:3100" }),
      }),
    });
    expect(bridge.getAdriftUrl()).toBe("http://localhost:3000");
    await bridge.loadPackConfig();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/extensions/adrift_overlay/adrift_config.json",
    );
    expect(bridge.getAdriftUrl()).toBe("http://203.0.113.30:3100/");
  });

  it("a URL saved in localStorage beats the pack config", async () => {
    const { bridge } = loadBridge({
      stored: "http://203.0.113.20:3000",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ adriftUrl: "http://203.0.113.30:3100" }),
      }),
    });
    await bridge.loadPackConfig();
    expect(bridge.getAdriftUrl()).toBe("http://203.0.113.20:3000/");
  });

  it("ignores a missing or non-http pack config", async () => {
    const missing = loadBridge({
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    });
    await missing.bridge.loadPackConfig();
    expect(missing.bridge.getAdriftUrl()).toBe("http://localhost:3000");
    const bad = loadBridge({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ adriftUrl: "javascript:alert(1)" }),
      }),
    });
    await bad.bridge.loadPackConfig();
    expect(bad.bridge.getAdriftUrl()).toBe("http://localhost:3000");
  });

  it("registers the extension once even if the script runs twice", () => {
    const { app, win } = loadBridge();
    expect(app.registerExtension).toHaveBeenCalledTimes(1);
    expect((win as Record<string, unknown>).__adriftOverlayLoaded).toBe(true);
    const second = loadBridge({ preloaded: true });
    expect(second.app.registerExtension).not.toHaveBeenCalled();
  });
});

