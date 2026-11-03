/**
 * Overlay Tools parity: bridge client helpers, hand-off store, dry-run
 * export and launcher helpers (no iframe, no network, no GPU).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createToolsBridgeListener,
  insertApiWorkflow,
  loadGraphToolImage,
  newRequestId,
  requestGraphImage,
} from "@/lib/overlay/toolsBridge";
import {
  OVERLAY_MSG,
  parseCjMessage,
  type GraphImagePayload,
} from "@/lib/overlay/protocol";
import { useOverlayToolsStore } from "@/store/overlayToolsStore";
import {
  exportCatalogToolWorkflow,
  imageRefFor,
  sourceRunFor,
  type FetchLike,
  type ToolImage,
} from "@/lib/tools/runTool";
import { defaultSettings, type CatalogTool } from "@/lib/tools/toolsPage";
import {
  describeGraphImage,
  filterLauncherTools,
} from "@/components/OverlayToolsLauncher";
import { runGraphImageHandoff } from "@/components/tools/OverlayGraphActions";

const GRAPH_IMAGE: GraphImagePayload = {
  nodeId: 9,
  nodeType: "SaveImage",
  nodeTitle: "Save Image",
  source: "selection",
  images: [{ filename: "out_00001_.png", subfolder: "cj", type: "output" }],
};

const WF = {
  "1": { class_type: "LoadImage", inputs: { image: "a.png [input]" } },
  "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
};

function catalogTool(over: Partial<CatalogTool> = {}): CatalogTool {
  return {
    id: "t1",
    label: "Tool One",
    category: "Camera",
    base: "qwen",
    baseLabel: "Qwen Edit",
    description: "d",
    loras: [],
    extras: { keepFraming: null },
    speed: { supported: false },
    defaults: { steps: 20, cfg: 4 },
    refCount: 1,
    refLabels: ["Photo"],
    needsMask: false,
    outpaint: null,
    promptMode: "none",
    promptTemplate: "",
    promptHint: "",
    options: [],
    requiresNodes: null,
    license: { name: "MIT", commercial: true, note: "" },
    sourceUrl: "",
    installed: true,
    packAvailable: true,
    available: true,
    ...over,
  } as CatalogTool;
}

const ok = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: async () => body });

describe("toolsBridge outgoing messages", () => {
  it("newRequestId is unique and schema-sized", () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(64);
  });

  it("requestGraphImage posts a valid envelope to the parent", () => {
    const postMessage = vi.fn();
    const id = requestGraphImage(4, {
      target: { postMessage },
      origin: "http://h",
    });
    expect(id).toBeTruthy();
    const [msg, origin] = postMessage.mock.calls[0];
    expect(origin).toBe("http://h");
    const parsed = parseCjMessage(msg);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.type).toBe(OVERLAY_MSG.REQUEST_GRAPH_IMAGE);
      expect(parsed.payload).toEqual({ requestId: id, nodeId: 4 });
    }
  });

  it("requestGraphImage is a no-op outside an iframe", () => {
    expect(requestGraphImage(undefined, null)).toBeNull();
  });

  it("insertApiWorkflow validates before posting", () => {
    const postMessage = vi.fn();
    const to = { target: { postMessage }, origin: "*" };
    const id = insertApiWorkflow({ workflow: WF, title: "T" }, to);
    const parsed = parseCjMessage(postMessage.mock.calls[0][0]);
    expect(
      parsed.ok && (parsed.payload as { requestId: string }).requestId,
    ).toBe(id);
    expect(() =>
      insertApiWorkflow(
        { workflow: { "1": { class_type: "X", inputs: { a: ["5", 0] } } } },
        to,
      ),
    ).toThrow();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(() => insertApiWorkflow({ workflow: WF }, null)).toThrow(/overlay/);
  });
});

describe("createToolsBridgeListener", () => {
  const parent = {};
  const ev = (data: unknown, source: unknown = parent) =>
    ({ data, source }) as unknown as MessageEvent;

  it("dispatches valid host replies from the parent only", () => {
    const onGraphImage = vi.fn();
    const onInserted = vi.fn();
    const h = createToolsBridgeListener({ parent, onGraphImage, onInserted });
    h(ev({ type: "cj:graph-image", version: 1, payload: GRAPH_IMAGE }));
    h(ev({ type: "cj:graph-image", version: 1, payload: GRAPH_IMAGE }, {}));
    h(
      ev({
        type: "cj:graph-inserted",
        version: 1,
        payload: { ok: true, mode: "insert", nodeIds: [1], warnings: [] },
      }),
    );
    expect(onGraphImage).toHaveBeenCalledTimes(1);
    expect(onInserted).toHaveBeenCalledTimes(1);
  });

  it("drops malformed and unrelated messages", () => {
    const onGraphImage = vi.fn();
    const h = createToolsBridgeListener({
      parent,
      onGraphImage,
      onInserted: vi.fn(),
    });
    h(ev(null));
    h(ev({ type: "cj:progress", payload: {} }));
    h(
      ev({
        type: "cj:graph-image",
        payload: {
          ...GRAPH_IMAGE,
          images: [{ filename: "../x", type: "output" }],
        },
      }),
    );
    expect(onGraphImage).not.toHaveBeenCalled();
  });

  it("ignores everything without a parent window", () => {
    const onGraphImage = vi.fn();
    const h = createToolsBridgeListener({
      parent: null,
      onGraphImage,
      onInserted: vi.fn(),
    });
    h(ev({ type: "cj:graph-image", payload: GRAPH_IMAGE }, null));
    expect(onGraphImage).not.toHaveBeenCalled();
  });
});

describe("loadGraphToolImage", () => {
  it("builds a runner image with a comfy ref via the proxy", async () => {
    const fetchImpl = vi.fn(async (_url: string) => ({
      ok: true,
      blob: async () => new Blob(["x"]),
    }));
    const img = await loadGraphToolImage(GRAPH_IMAGE, 0, {
      fetchImpl,
      toDataUrl: async () => "data:image/png;base64,AAAA",
      measure: async () => ({ width: 640, height: 480 }),
    });
    expect(fetchImpl.mock.calls[0][0]).toMatch(/^\/api\/comfy\/image\?/);
    expect(img).toMatchObject({
      source: "upload",
      comfyRef: "cj/out_00001_.png [output]",
      dataUrl: "data:image/png;base64,AAAA",
      width: 640,
      height: 480,
    });
  });

  it("fails cleanly without an image or on a bad fetch", async () => {
    const loaders = {
      fetchImpl: async () => ({ ok: false, blob: async () => new Blob() }),
      toDataUrl: async () => "",
      measure: async () => ({ width: 1, height: 1 }),
    };
    await expect(
      loadGraphToolImage({ ...GRAPH_IMAGE, images: [] }, 0, loaders),
    ).rejects.toThrow(/No image/);
    await expect(loadGraphToolImage(GRAPH_IMAGE, 0, loaders)).rejects.toThrow(
      /Could not load/,
    );
  });
});

describe("overlayToolsStore", () => {
  beforeEach(() =>
    useOverlayToolsStore.setState({
      graphImage: null,
      pendingToolKey: null,
      pendingUseGraphImage: false,
      inserts: {},
    }),
  );

  it("hands a tool + graph image to the Tools page once", () => {
    const s = useOverlayToolsStore.getState();
    s.openToolFromLauncher("catalog:t1", true);
    expect(useOverlayToolsStore.getState().pendingToolKey).toBe("catalog:t1");
    expect(useOverlayToolsStore.getState().consumeGraphImageRequest()).toBe(
      true,
    );
    expect(useOverlayToolsStore.getState().consumeGraphImageRequest()).toBe(
      false,
    );
    s.consumePendingTool();
    expect(useOverlayToolsStore.getState().pendingToolKey).toBeNull();
  });

  it("tracks insert requests and ignores unknown replies", () => {
    const s = useOverlayToolsStore.getState();
    s.markInsertPending("r1", "Restore");
    s.markInsertResult({
      requestId: "zz",
      ok: true,
      mode: "insert",
      nodeIds: [],
      warnings: [],
    });
    expect(Object.keys(useOverlayToolsStore.getState().inserts)).toEqual([
      "r1",
    ]);
    s.markInsertResult({
      requestId: "r1",
      ok: true,
      mode: "insert",
      nodeIds: [5, 6],
      warnings: [],
    });
    expect(useOverlayToolsStore.getState().inserts.r1).toMatchObject({
      state: "done",
      ok: true,
      title: "Restore",
      nodeIds: [5, 6],
    });
  });

  it("bounds the tracked inserts", () => {
    const s = useOverlayToolsStore.getState();
    for (let i = 0; i < 30; i++) s.markInsertPending(`r${i}`, "t");
    const keys = Object.keys(useOverlayToolsStore.getState().inserts);
    expect(keys).toHaveLength(20);
    expect(keys.at(-1)).toBe("r29");
  });
});

describe("runTool graph images + dry run", () => {
  const graphImg: ToolImage = {
    id: "g",
    source: "upload",
    previewUrl: "/api/comfy/image?x",
    label: "g",
    width: 10,
    height: 10,
    dataUrl: "data:image/png;base64,AAAA",
    comfyRef: "cj/out.png [output]",
  };

  it("imageRefFor uses the comfy ref without uploading", async () => {
    const f: FetchLike = vi.fn();
    expect(await imageRefFor(f, graphImg)).toBe("cj/out.png [output]");
    expect(f).not.toHaveBeenCalled();
  });

  it("sourceRunFor uploads output refs (seed-run takes inputs only)", async () => {
    const calls: string[] = [];
    const f: FetchLike = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "/api/comfy/upload")
        return ok({ ok: true, ref: "up.png [input]" });
      return ok({ ok: true, run: { run_id: "seeded", jobs: [{ index: 0 }] } });
    });
    const r = await sourceRunFor(f, graphImg, "t");
    expect(r.runId).toBe("seeded");
    expect(calls).toEqual(["/api/comfy/upload", "/api/jobs/seed-run"]);
  });

  it("exportCatalogToolWorkflow posts dry_run and returns the workflow", async () => {
    const f: FetchLike = vi.fn(async () =>
      ok({ ok: true, workflow: WF, seed: 3 }),
    );
    const out = await exportCatalogToolWorkflow({
      fetchImpl: f,
      tool: catalogTool(),
      settings: defaultSettings(),
      images: [graphImg],
      mask: null,
      clientId: "c",
    });
    expect(out).toEqual({ workflow: WF, seed: 3 });
    const [url, init] = (f as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/jobs/tool");
    const body = JSON.parse(String(init.body));
    expect(body.dry_run).toBe(true);
    expect(body.images).toEqual(["cj/out.png [output]"]);
  });

  it("exportCatalogToolWorkflow rejects a reply without a workflow", async () => {
    const f: FetchLike = vi.fn(async () => ok({ ok: true, run: {} }));
    await expect(
      exportCatalogToolWorkflow({
        fetchImpl: f,
        tool: catalogTool(),
        settings: defaultSettings(),
        images: [graphImg],
        mask: null,
        clientId: "c",
      }),
    ).rejects.toThrow(/no workflow/);
  });

  it("exportCatalogToolWorkflow validates before any request", async () => {
    const f: FetchLike = vi.fn();
    await expect(
      exportCatalogToolWorkflow({
        fetchImpl: f,
        tool: catalogTool(),
        settings: defaultSettings(),
        images: [null],
        mask: null,
        clientId: "c",
      }),
    ).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("launcher helpers", () => {
  it("filters by label/category/base and lists ready tools first", () => {
    const tools = [
      catalogTool({
        id: "a",
        label: "Zoom",
        category: "Camera",
        available: false,
      }),
      catalogTool({ id: "b", label: "Restore", category: "Fix" }),
      catalogTool({ id: "c", label: "Angle", category: "Camera" }),
    ];
    expect(filterLauncherTools(tools, "").map((t) => t.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
    expect(filterLauncherTools(tools, "camera").map((t) => t.id)).toEqual([
      "c",
      "a",
    ]);
    expect(filterLauncherTools(tools, "qwen")).toHaveLength(3);
  });

  it("describes the graph pick", () => {
    expect(describeGraphImage(null)).toMatch(/Waiting/);
    expect(
      describeGraphImage({ ...GRAPH_IMAGE, source: "none", images: [] }),
    ).toMatch(/Select/);
    expect(describeGraphImage(GRAPH_IMAGE)).toBe("Save Image: out_00001_.png");
  });
});

describe("launcher graph-image hand-off", () => {
  const IMG = { id: "graph-9" } as unknown as ToolImage;

  beforeEach(() => {
    useOverlayToolsStore.setState({
      graphImage: GRAPH_IMAGE,
      pendingToolKey: null,
      pendingUseGraphImage: false,
      inserts: {},
    });
    useOverlayToolsStore.getState().openToolFromLauncher("catalog:x", true);
  });

  /** Replays ToolRunner's effect commits with the live store flag. */
  function commit(
    overlayReady: boolean,
    accepts: boolean,
    deps: { load: ReturnType<typeof vi.fn>; onImage: ReturnType<typeof vi.fn> },
    alive = () => true,
  ) {
    const s = useOverlayToolsStore.getState();
    return runGraphImageHandoff(
      {
        wanted: s.pendingUseGraphImage,
        overlayReady,
        accepts,
        graphImage: s.graphImage,
      },
      {
        consume: s.consumeGraphImageRequest,
        load: deps.load as (p: GraphImagePayload) => Promise<ToolImage>,
        onImage: deps.onImage as (img: ToolImage) => void,
        onError: () => {},
        alive,
      },
    );
  }

  it("waits for overlay detection on mount, then loads the image once", async () => {
    const load = vi.fn().mockResolvedValue(IMG);
    const onImage = vi.fn();
    // Mount commit: useIsOverlay() still false.
    expect(commit(false, false, { load, onImage })).toBeNull();
    expect(useOverlayToolsStore.getState().pendingUseGraphImage).toBe(true);
    // Detection settled: consume + load.
    const p = commit(true, true, { load, onImage });
    expect(p).not.toBeNull();
    expect(useOverlayToolsStore.getState().pendingUseGraphImage).toBe(false);
    // Re-render from the consumed flag must not cancel or repeat the load.
    expect(commit(true, true, { load, onImage })).toBeNull();
    await p;
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(GRAPH_IMAGE);
    expect(onImage).toHaveBeenCalledWith(IMG);
  });

  it("drops the request when the tool has no image input", () => {
    const load = vi.fn();
    expect(commit(true, false, { load, onImage: vi.fn() })).toBeNull();
    expect(useOverlayToolsStore.getState().pendingUseGraphImage).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it("does not deliver after unmount", async () => {
    const load = vi.fn().mockResolvedValue(IMG);
    const onImage = vi.fn();
    await commit(true, true, { load, onImage }, () => false);
    expect(onImage).not.toHaveBeenCalled();
  });
});
