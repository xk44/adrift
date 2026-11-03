/**
 * Host-side Tools bridge (adrift_overlay.js) against a stubbed
 * ComfyUI app + LiteGraph. The block between the "Tools bridge" marker and
 * the extension registration is evaluated in isolation, so these tests pin
 * the exact code ComfyUI loads.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  GraphImagePayloadSchema,
  GraphInsertedPayloadSchema,
} from "../protocol";

const SRC = readFileSync(
  join(
    __dirname,
    "../../../../comfy_nodes/adrift_overlay/web/adrift_overlay.js",
  ),
  "utf8",
);
const START = SRC.indexOf("// ── Tools bridge: graph images");
const END = SRC.indexOf("// ── ComfyUI Extension Registration");
const BLOCK = SRC.slice(START, END);

interface Widget {
  name: string;
  value: unknown;
  callback?: (v: unknown) => void;
}

class FakeNode {
  id = 0;
  title: string;
  pos: number[] = [0, 0];
  size: number[] = [200, 100];
  inputs: { name: string; link?: number }[] = [];
  widgets: Widget[] = [];
  links: { slot: number; target: FakeNode; targetSlot: number }[] = [];
  images?: unknown[];
  constructor(public type: string) {
    this.title = type;
  }
  connect(slot: number, target: FakeNode, targetSlot: number) {
    this.links.push({ slot, target, targetSlot });
  }
  convertWidgetToInput(w: Widget) {
    this.inputs.push({ name: w.name });
    this.widgets = this.widgets.filter((x) => x !== w);
  }
}

const NODE_DEFS: Record<
  string,
  { inputs?: string[]; widgets?: Record<string, unknown> }
> = {
  LoadImage: { widgets: { image: "", upload: "image" } },
  SaveImage: { inputs: ["images"], widgets: { filename_prefix: "ComfyUI" } },
  ImageScale: {
    inputs: ["image"],
    widgets: { width: 512, height: 512 },
  },
};

function setup(opts: { loadApiJson?: boolean } = {}) {
  const sent: { type: string; payload: unknown }[] = [];
  const graphNodes: FakeNode[] = [];
  let nextId = 100;
  const graph = {
    _nodes: graphNodes,
    add: vi.fn((n: FakeNode) => {
      if (n instanceof FakeNode) {
        n.id = nextId++;
        graphNodes.push(n);
      }
    }),
    getNodeById: (id: number) => graphNodes.find((n) => n.id === id) ?? null,
    beforeChange: vi.fn(),
    afterChange: vi.fn(),
    setDirtyCanvas: vi.fn(),
  };
  const LiteGraph = {
    createNode: (type: string) => {
      const def = NODE_DEFS[type];
      if (!def) return null;
      const n = new FakeNode(type);
      n.inputs = (def.inputs ?? []).map((name) => ({ name }));
      n.widgets = Object.entries(def.widgets ?? {}).map(([name, value]) => ({
        name,
        value,
      }));
      return n;
    },
  };
  const canvas = {
    selected_nodes: {} as Record<string, FakeNode>,
    selectNodes: vi.fn(),
    centerOnNode: vi.fn(),
  };
  const app: Record<string, unknown> = {
    graph,
    canvas,
    nodeOutputs: {} as Record<string, unknown>,
  };
  if (opts.loadApiJson) {
    app.loadApiJson = vi.fn(async () => {
      graphNodes.splice(0, graphNodes.length);
      const n = new FakeNode("SaveImage");
      n.id = 1;
      graphNodes.push(n);
    });
  }
  const setOverlayVisible = vi.fn();
  const fns = new Function(
    "app",
    "window",
    "overlayState",
    "sendToOverlay",
    "log",
    "setOverlayVisible",
    "CJ_MSG_GRAPH_IMAGE",
    "CJ_MSG_GRAPH_INSERTED",
    "CJ_PROTOCOL_VERSION",
    `${BLOCK}
return { parseImageWidgetValue, nodeGraphImages, findGraphImage,
  sendGraphImage, handleInsertApiWorkflow, validateApiWorkflow };`,
  )(
    app,
    { LiteGraph },
    { overlayReady: true, sessionNonce: undefined },
    (m: { type: string; payload: unknown }) => sent.push(m),
    () => {},
    setOverlayVisible,
    "cj:graph-image",
    "cj:graph-inserted",
    1,
  );
  const addNode = (type: string) => {
    const n = LiteGraph.createNode(type) as FakeNode;
    graph.add(n);
    return n;
  };
  return { fns, app, graph, canvas, sent, setOverlayVisible, addNode };
}

describe("host tools bridge block", () => {
  it("is present in the overlay script", () => {
    expect(START).toBeGreaterThan(0);
    expect(END).toBeGreaterThan(START);
  });

  it("parses widget values like the protocol helper", () => {
    const { fns } = setup();
    expect(fns.parseImageWidgetValue("a/b.png [output]")).toEqual({
      filename: "b.png",
      subfolder: "a",
      type: "output",
    });
    expect(fns.parseImageWidgetValue("../x.png")).toBeNull();
  });

  it("prefers execution outputs, then LoadImage widget", () => {
    const { fns, app, addNode } = setup();
    const save = addNode("SaveImage");
    (app.nodeOutputs as Record<string, unknown>)[String(save.id)] = {
      images: [
        { filename: "out.png", subfolder: "", type: "output" },
        { filename: "../evil.png", subfolder: "", type: "output" },
      ],
    };
    expect(fns.nodeGraphImages(save)).toEqual([
      { filename: "out.png", subfolder: "", type: "output" },
    ]);
    const load = addNode("LoadImage");
    load.widgets[0].value = "pics/cat.png";
    expect(fns.nodeGraphImages(load)).toEqual([
      { filename: "cat.png", subfolder: "pics", type: "input" },
    ]);
  });

  it("finds selection first, then the latest output node", () => {
    const { fns, app, canvas, addNode } = setup();
    const a = addNode("SaveImage");
    const b = addNode("SaveImage");
    const outs = app.nodeOutputs as Record<string, unknown>;
    outs[String(a.id)] = { images: [{ filename: "a.png", type: "output" }] };
    outs[String(b.id)] = { images: [{ filename: "b.png", type: "output" }] };
    expect(fns.findGraphImage(undefined).node).toBe(b);
    expect(fns.findGraphImage(undefined).source).toBe("latest");
    canvas.selected_nodes = { [a.id]: a };
    const sel = fns.findGraphImage(undefined);
    expect(sel.node).toBe(a);
    expect(sel.source).toBe("selection");
    expect(fns.findGraphImage(b.id).source).toBe("node");
  });

  it("sends schema-valid graph-image messages", () => {
    const { fns, sent, addNode } = setup();
    const load = addNode("LoadImage");
    load.widgets[0].value = "x.png";
    fns.sendGraphImage(load, "selection", fns.nodeGraphImages(load), "r1");
    fns.sendGraphImage(null, "none", [], "r2");
    expect(sent).toHaveLength(2);
    for (const m of sent) {
      expect(m.type).toBe("cj:graph-image");
      expect(GraphImagePayloadSchema.safeParse(m.payload).success).toBe(true);
    }
    expect((sent[1].payload as { nodeId: number }).nodeId).toBe(-1);
  });

  it("inserts nodes, links and widget values without replacing the graph", async () => {
    const { fns, graph, sent, setOverlayVisible, addNode, canvas } = setup();
    const existing = addNode("LoadImage");
    await fns.handleInsertApiWorkflow({
      requestId: "q",
      mode: "insert",
      title: "Upscale",
      workflow: {
        "1": {
          class_type: "LoadImage",
          inputs: { image: "in.png" },
          _meta: { title: "Src" },
        },
        "2": {
          class_type: "ImageScale",
          inputs: { image: ["1", 0], width: ["3", 0], height: 1024 },
        },
        "3": { class_type: "LoadImage", inputs: { image: "w.png" } },
        "4": { class_type: "MysteryNode", inputs: {} },
      },
    });
    expect(graph._nodes).toContain(existing);
    const msg = sent.at(-1)!;
    expect(msg.type).toBe("cj:graph-inserted");
    const p = GraphInsertedPayloadSchema.parse(msg.payload);
    expect(p.ok).toBe(true);
    expect(p.requestId).toBe("q");
    expect(p.nodeIds).toHaveLength(3);
    expect(p.warnings.join(" ")).toContain("MysteryNode");
    const src = graph._nodes.find((n) => n.title === "Src")!;
    const scale = graph._nodes.find((n) => n.type === "ImageScale")!;
    expect(src.widgets[0].value).toBe("in.png");
    expect(src.links[0]).toMatchObject({
      slot: 0,
      target: scale,
      targetSlot: 0,
    });
    // width widget converted to an input socket for the link
    expect(scale.inputs.map((i) => i.name)).toEqual(["image", "width"]);
    expect(scale.widgets.find((w) => w.name === "height")?.value).toBe(1024);
    // placed to the right of the existing graph
    expect(src.pos[0]).toBeGreaterThan(existing.pos[0] + existing.size[0]);
    expect(scale.pos[0]).toBeGreaterThan(src.pos[0]);
    expect(graph.beforeChange).toHaveBeenCalled();
    expect(graph.afterChange).toHaveBeenCalled();
    expect(canvas.selectNodes).toHaveBeenCalled();
    expect(setOverlayVisible).toHaveBeenCalledWith(false);
  });

  it("keeps the overlay open when reveal is false", async () => {
    const { fns, setOverlayVisible } = setup();
    await fns.handleInsertApiWorkflow({
      reveal: false,
      workflow: { "1": { class_type: "LoadImage", inputs: {} } },
    });
    expect(setOverlayVisible).not.toHaveBeenCalled();
  });

  it("rejects invalid workflows without touching the graph", async () => {
    const { fns, graph, sent } = setup();
    await fns.handleInsertApiWorkflow({
      workflow: {
        "1": { class_type: "SaveImage", inputs: { images: ["9", 0] } },
      },
    });
    expect(graph.add).not.toHaveBeenCalled();
    const p = GraphInsertedPayloadSchema.parse(sent.at(-1)!.payload);
    expect(p.ok).toBe(false);
    expect(p.error).toContain("missing node");
  });

  it("reports failure when nothing could be created", async () => {
    const { fns, sent } = setup();
    await fns.handleInsertApiWorkflow({
      workflow: { "1": { class_type: "MysteryNode", inputs: {} } },
    });
    const p = GraphInsertedPayloadSchema.parse(sent.at(-1)!.payload);
    expect(p.ok).toBe(false);
  });

  it("replace mode uses app.loadApiJson when present", async () => {
    const { fns, app, sent } = setup({ loadApiJson: true });
    await fns.handleInsertApiWorkflow({
      mode: "replace",
      workflow: { "1": { class_type: "SaveImage", inputs: {} } },
    });
    expect(app.loadApiJson).toHaveBeenCalled();
    const p = GraphInsertedPayloadSchema.parse(sent.at(-1)!.payload);
    expect(p).toMatchObject({ ok: true, mode: "replace", nodeIds: [1] });
  });

  it("replace mode errors cleanly without app.loadApiJson", async () => {
    const { fns, sent } = setup();
    await fns.handleInsertApiWorkflow({
      mode: "replace",
      workflow: { "1": { class_type: "SaveImage", inputs: {} } },
    });
    const p = GraphInsertedPayloadSchema.parse(sent.at(-1)!.payload);
    expect(p.ok).toBe(false);
    expect(p.error).toContain("loadApiJson");
  });
});
