/**
 * WorkflowControlPanel re-render scope, measured on the real component tree.
 *
 * The suite runs in a plain node environment (no jsdom), so a tiny fake DOM
 * is installed before react-dom loads; it implements only what react-dom's
 * client renderer touches. Render counts come from spies on leaf pieces that
 * each section renders exactly once:
 *   - ControlHelpText: once per scalar control editor (keyed by control.key)
 *   - the group header chevron: once per ControlGroupSection render
 *   - SlidersHorizontal: once per PanelSummaryHeader render
 *   - CheckCircle2: once per PanelInfoHeader render
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import oi from "./fixtures/objectInfo.inputOptions.json";

const fakeDom = vi.hoisted(() => {
  class FakeNode {
    childNodes: FakeNode[] = [];
    parentNode: FakeNode | null = null;
    ownerDocument: unknown = null;
    nodeType = 1;
    nodeValue: string | null = null;
    get firstChild() {
      return this.childNodes[0] ?? null;
    }
    get lastChild() {
      return this.childNodes[this.childNodes.length - 1] ?? null;
    }
    get nextSibling(): FakeNode | null {
      const p = this.parentNode;
      if (!p) return null;
      return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null;
    }
    appendChild(c: FakeNode) {
      c.parentNode?.removeChild(c);
      this.childNodes.push(c);
      c.parentNode = this;
      return c;
    }
    insertBefore(c: FakeNode, ref: FakeNode | null) {
      if (!ref) return this.appendChild(c);
      c.parentNode?.removeChild(c);
      this.childNodes.splice(this.childNodes.indexOf(ref), 0, c);
      c.parentNode = this;
      return c;
    }
    removeChild(c: FakeNode) {
      const i = this.childNodes.indexOf(c);
      if (i >= 0) this.childNodes.splice(i, 1);
      c.parentNode = null;
      return c;
    }
    contains(n: FakeNode | null): boolean {
      for (let x = n; x; x = x.parentNode) if (x === this) return true;
      return false;
    }
    get textContent(): string {
      if (this.nodeType === 3) return this.nodeValue ?? "";
      return this.childNodes.map((c) => c.textContent).join("");
    }
    set textContent(v: string) {
      if (this.nodeType === 3) {
        this.nodeValue = v;
        return;
      }
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes = [];
      if (v) this.appendChild(makeText(v, this.ownerDocument));
    }
    addEventListener() {}
    removeEventListener() {}
  }

  class FakeElement extends FakeNode {
    attributes = new Map<string, string>();
    style: Record<string, unknown> = {
      setProperty(k: string, v: unknown) {
        (this as Record<string, unknown>)[k] = v;
      },
      removeProperty() {},
    };
    constructor(
      public tagName: string,
      public namespaceURI: string,
    ) {
      super();
    }
    get nodeName() {
      return this.tagName;
    }
    setAttribute(k: string, v: unknown) {
      this.attributes.set(k, String(v));
    }
    setAttributeNS(_ns: string, k: string, v: unknown) {
      this.attributes.set(k, String(v));
    }
    getAttribute(k: string) {
      return this.attributes.get(k) ?? null;
    }
    hasAttribute(k: string) {
      return this.attributes.has(k);
    }
    removeAttribute(k: string) {
      this.attributes.delete(k);
    }
    removeAttributeNS(_ns: string, k: string) {
      this.attributes.delete(k);
    }
    get options(): FakeElement[] {
      const out: FakeElement[] = [];
      const walk = (n: FakeNode) => {
        for (const c of n.childNodes) {
          if (c instanceof FakeElement && c.tagName === "OPTION") out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    focus() {}
    blur() {}
  }

  function makeText(v: string, doc: unknown) {
    const t = new FakeNode();
    t.nodeType = 3;
    t.nodeValue = v;
    t.ownerDocument = doc;
    return t;
  }

  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const doc = new FakeNode() as FakeNode & Record<string, unknown>;
  doc.nodeType = 9;
  const mk = (tag: string, ns: string) => {
    const el = new FakeElement(ns === HTML_NS ? tag.toUpperCase() : tag, ns);
    el.ownerDocument = doc;
    return el;
  };
  const body = mk("body", HTML_NS);
  Object.assign(doc, {
    createElement: (tag: string) => mk(tag, HTML_NS),
    createElementNS: (ns: string, tag: string) => mk(tag, ns),
    createTextNode: (v: string) => makeText(v, doc),
    body,
    documentElement: mk("html", HTML_NS),
    activeElement: body,
  });
  doc.appendChild(doc.documentElement as FakeNode);

  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document };
  const win = {
    document: doc,
    HTMLIFrameElement: class {},
    addEventListener() {},
    removeEventListener() {},
    event: undefined,
  };
  doc.defaultView = win;
  g.window = win;
  g.document = doc;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  return {
    container: () => {
      const el = mk("div", HTML_NS);
      body.appendChild(el);
      return el;
    },
    text: (n: unknown) => (n as FakeNode).textContent,
    restore: () => {
      g.window = saved.window;
      g.document = saved.document;
    },
  };
});

const spy = vi.hoisted(() => ({
  helpText: new Map<string, number>(),
  groupHeaders: 0,
  summaryHeader: 0,
  infoHeader: 0,
  reset() {
    this.helpText.clear();
    this.groupHeaders = 0;
    this.summaryHeader = 0;
    this.infoHeader = 0;
  },
}));

vi.mock(
  "@/components/workflowControls/specControls",
  async (importOriginal) => {
    const mod =
      await importOriginal<
        typeof import("@/components/workflowControls/specControls")
      >();
    const { createElement } = await import("react");
    return {
      ...mod,
      ControlHelpText: (props: Parameters<typeof mod.ControlHelpText>[0]) => {
        const k = props.control.key;
        spy.helpText.set(k, (spy.helpText.get(k) ?? 0) + 1);
        return createElement(mod.ControlHelpText, props);
      },
    };
  },
);

vi.mock("lucide-react", async (importOriginal) => {
  const mod = await importOriginal<typeof import("lucide-react")>();
  const { createElement } = await import("react");
  type IconProps = { className?: string };
  const wrap =
    (Icon: React.ComponentType<IconProps>, hit: (p: IconProps) => void) =>
    (props: IconProps) => {
      hit(props);
      return createElement(Icon, props);
    };
  // The group header chevron is the only one with this muted color.
  const header = (p: IconProps) => {
    if (
      p.className?.includes(
        "text-light-400/50 dark:text-dark-600/50 transition-transform",
      )
    )
      spy.groupHeaders++;
  };
  return {
    ...mod,
    ChevronDown: wrap(
      mod.ChevronDown as React.ComponentType<IconProps>,
      header,
    ),
    ChevronRight: wrap(
      mod.ChevronRight as React.ComponentType<IconProps>,
      header,
    ),
    SlidersHorizontal: wrap(
      mod.SlidersHorizontal as React.ComponentType<IconProps>,
      () => spy.summaryHeader++,
    ),
    CheckCircle2: wrap(
      mod.CheckCircle2 as React.ComponentType<IconProps>,
      () => spy.infoHeader++,
    ),
  };
});

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { buildControlSchema } from "@/lib/oj/workflowControlSchema";
import {
  packSelectionKey,
  useWorkflowControlStore,
} from "@/store/workflowControlStore";
import { useModelStore } from "@/store/modelStore";
import { WorkflowControlPanel } from "@/components/WorkflowControlPanel";

const T2I = {
  "3": {
    class_type: "KSampler",
    inputs: {
      seed: 1,
      steps: 20,
      cfg: 7,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1,
      model: ["4", 0],
      positive: ["6", 0],
      negative: ["7", 0],
      latent_image: ["5", 0],
    },
  },
  "4": {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "a.safetensors" },
  },
  "5": {
    class_type: "EmptyLatentImage",
    inputs: { width: 1024, height: 1024, batch_size: 1 },
  },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "a", clip: ["4", 1] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "b", clip: ["4", 1] } },
  "8": {
    class_type: "CLIPSetLastLayer",
    inputs: { stop_at_clip_layer: -2, clip: ["4", 1] },
  },
};

const PACK = "renders-test";
const KIND = "t2i";
const SEL = packSelectionKey(PACK, KIND);
const controls = buildControlSchema(T2I as never).controls;

let root: Root;
let container: ReturnType<typeof fakeDom.container>;
const realFetch = globalThis.fetch;

async function flush() {
  // Let the object_info fetch promise chain settle inside act.
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

beforeAll(async () => {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ specs: oi }),
  })) as unknown as typeof fetch;
  useModelStore.setState({ fetchAvailable: async () => {} } as never);
  useWorkflowControlStore.getState().resetAllOverrides(SEL);

  container = fakeDom.container();
  root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(
      createElement(WorkflowControlPanel, {
        controls,
        packId: PACK,
        workflowKind: KIND,
        workflowName: "Test",
        nodeCount: 6,
        missingNodesCount: 0,
      }),
    );
  });
  await flush();
});

afterAll(() => {
  act(() => root.unmount());
  globalThis.fetch = realFetch;
  fakeDom.restore();
});

function setOverride(key: string, value: unknown) {
  spy.reset();
  act(() => {
    useWorkflowControlStore.getState().setOverride(SEL, key, value);
  });
}

describe("WorkflowControlPanel render scope", () => {
  it("renders every section on mount", () => {
    const text = fakeDom.text(container);
    expect(text).toContain("Controls");
    expect(text).toContain("Compatible");
    // Several node groups, each with scalar editors.
    expect(controls.length).toBeGreaterThan(8);
    const groups = new Set(controls.map((c) => c.group)).size;
    expect(groups).toBeGreaterThan(3);
    // Mount (plus the object_info re-render) hit every group header and
    // every scalar editor; the spies are wired to the real tree.
    expect(spy.groupHeaders).toBeGreaterThanOrEqual(groups);
    expect(spy.helpText.size).toBeGreaterThan(5);
    expect(spy.summaryHeader).toBeGreaterThan(0);
    expect(spy.infoHeader).toBeGreaterThan(0);
    // object_info specs were applied (fetch resolved and re-rendered).
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it("one override edit re-renders one group and one editor", () => {
    const steps = controls.find((c) => c.key === "3.steps");
    expect(steps).toBeDefined();

    setOverride("3.steps", 30);
    // Only the KSampler group re-rendered, and inside it only `steps`.
    expect(spy.groupHeaders).toBe(1);
    expect([...spy.helpText.keys()]).toEqual(["3.steps"]);
    expect(spy.helpText.get("3.steps")).toBe(1);
    // The workflow info header never depends on overrides.
    expect(spy.infoHeader).toBe(0);
  });

  it("a second edit of the same control skips the unchanged summary header", () => {
    setOverride("3.steps", 31);
    expect(spy.groupHeaders).toBe(1);
    expect([...spy.helpText.keys()]).toEqual(["3.steps"]);
    // Override count is still 1, so the "Controls" header is skipped.
    expect(spy.summaryHeader).toBe(0);
    expect(spy.infoHeader).toBe(0);
  });

  it("editing a control in another group re-renders only that group", () => {
    setOverride("5.width", 768);
    expect(spy.groupHeaders).toBe(1);
    expect([...spy.helpText.keys()]).toEqual(["5.width"]);
    expect(fakeDom.text(container)).toContain("Reset 2");
  });

  it("reset restores defaults through the same narrow path", () => {
    spy.reset();
    act(() => {
      useWorkflowControlStore.getState().resetOverride(SEL, "5.width");
    });
    expect(spy.groupHeaders).toBe(1);
    expect([...spy.helpText.keys()]).toEqual(["5.width"]);
  });
});

