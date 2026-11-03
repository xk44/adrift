/**
 * Edit page Tools panel: which tools take the canvas, mask hand-off, result
 * routing, and the editor store side (result -> layer + undoable canvas).
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { CatalogTool } from "@/lib/tools/toolsPage";
import type { ImagineRun } from "@/types";
import {
  EDITOR_EXCLUDED_KEYS,
  buildEditorTools,
  editorHandoff,
  editorSourceRun,
  editorToolMask,
  filterEditorTools,
  groupEditorTools,
  routeEditorToolRun,
  type EditorToolRun,
} from "@/lib/editorTools";
import { REGION_MASK_TOOLS } from "@/lib/tools/maskWiring";
import { takeHandoff, galleryToolImage } from "@/lib/tools/toolHandoff";
import { editorMaskToBinaryPixels } from "@/lib/editorMask";
import { useEditorStore } from "@/store/editorStore";

const cat = (over: Partial<CatalogTool>): CatalogTool =>
  ({
    id: "krea2-inpaint",
    label: "Inpaint",
    category: "Edit",
    base: "krea2",
    baseLabel: "Krea 2",
    description: "Repaint a masked area",
    loras: [],
    extras: { keepFraming: null },
    speed: { supported: false },
    defaults: { steps: 20, cfg: 4 },
    refCount: 1,
    refLabels: ["Image"],
    needsMask: true,
    outpaint: null,
    promptMode: "required",
    promptTemplate: "",
    promptHint: "",
    options: [],
    requiresNodes: null,
    license: { name: "Apache-2.0", commercial: true, note: "" },
    sourceUrl: "",
    installed: true,
    packAvailable: true,
    available: true,
    ...over,
  }) as CatalogTool;

const ALL = buildEditorTools();
const byKey = (key: string, tools = ALL) => tools.find((t) => t.key === key);

describe("buildEditorTools: which tools take the canvas", () => {
  it("drops prompt-only rows and Describe (text result)", () => {
    for (const key of EDITOR_EXCLUDED_KEYS) expect(byKey(key)).toBeUndefined();
  });

  it("keeps the inline lightbox actions and image tools", () => {
    for (const key of [
      "inline:zoom",
      "inline:pan",
      "inline:detail",
      "inline:adetailer",
      "inline:realism",
      "action:edit_photo",
      "action:upscale",
    ])
      expect(byKey(key), key).toBeDefined();
  });

  it("every tool accepts an image", () => {
    expect(ALL.every((t) => t.media.includes("image"))).toBe(true);
  });

  it("sorts by what the tool makes", () => {
    expect(byKey("action:make_3d_trellis")?.output).toBe("3d");
    expect(byKey("action:animate")?.output).toBe("video");
    expect(byKey("action:lipsync")?.output).toBe("video");
    expect(byKey("app:sketch_to_video")?.output).toBe("video");
    expect(byKey("inline:detail")?.output).toBe("image");
    expect(byKey("action:upscale")?.output).toBe("image");
  });

  it("region-mask tools use the selection per subject; others ignore it", () => {
    for (const id of Object.keys(REGION_MASK_TOOLS)) {
      const t = byKey(`action:${id}`);
      if (t) expect(t.mask, id).toBe("region");
    }
    expect(byKey("action:edit_photo")?.mask).toBe("region");
    expect(byKey("action:upscale")?.mask).toBeNull();
    expect(byKey("inline:detail")?.mask).toBeNull();
  });

  it("catalog tools with a mask slot take the selection as their mask", () => {
    const tools = buildEditorTools([
      cat({}),
      cat({ id: "krea2-restyle", label: "Restyle", needsMask: false }),
    ]);
    expect(byKey("catalog:krea2-inpaint", tools)?.mask).toBe("inpaint");
    expect(byKey("catalog:krea2-restyle", tools)?.mask).toBeNull();
    expect(editorToolMask("catalog:missing", [cat({})])).toBeNull();
    expect(editorToolMask("catalog:krea2-inpaint", null)).toBeNull();
  });
});

describe("filter + group", () => {
  it("search uses the lightbox AND-of-words match", () => {
    const hits = filterEditorTools(ALL, "face");
    expect(hits.some((t) => t.key === "inline:adetailer")).toBe(true);
    expect(filterEditorTools(ALL, "zzzz no such tool")).toEqual([]);
  });

  it("groups into Image / Video / 3D in that order, dropping empty ones", () => {
    const sections = groupEditorTools(ALL);
    expect(sections.map((s) => s.output)).toEqual(["image", "video", "3d"]);
    for (const s of sections)
      for (const g of s.groups)
        for (const t of g.tools)
          expect((t as (typeof ALL)[number]).output).toBe(s.output);
    const onlyImage = groupEditorTools(ALL.filter((t) => t.output === "image"));
    expect(onlyImage.map((s) => s.output)).toEqual(["image"]);
  });

  it("small sections are one flat list; no heading repeats its section", () => {
    const sections = groupEditorTools(ALL);
    const threeD = sections.find((s) => s.output === "3d")!;
    expect(threeD.groups).toHaveLength(1);
    expect(threeD.groups[0].group).toBe("3D");
    const image = sections.find((s) => s.output === "image")!;
    expect(image.groups.map((g) => g.group)).not.toContain("Image");
  });
});

describe("editorHandoff: canvas + selection to a Tools page card", () => {
  const canvas = {
    url: "/api/comfy/view?filename=a.png",
    id: "g1",
    width: 832,
    height: 1216,
    run: { runId: "r1", jobIndex: 2 },
  };
  const MASK = "data:image/png;base64,AAAA";

  it("passes the selection only to tools that use a mask", () => {
    const edit = byKey("action:edit_photo")!;
    const up = byKey("action:upscale")!;
    expect(editorHandoff(edit, canvas, MASK, 1).mask).toBe(MASK);
    expect(editorHandoff(up, canvas, MASK, 1).mask).toBeUndefined();
    expect(editorHandoff(edit, canvas, null, 1).mask).toBeUndefined();
  });

  it("a canvas with a local run goes in by run/job (no pixel fetch)", () => {
    const h = editorHandoff(byKey("action:upscale")!, canvas, null, 5);
    expect(h).toMatchObject({
      toolKey: "action:upscale",
      media: "image",
      itemId: "g1",
      runId: "r1",
      jobIndex: 2,
      origin: "editor",
      at: 5,
    });
    expect(galleryToolImage(h)).toMatchObject({ runId: "r1", jobIndex: 2 });
  });

  it("an upload has no run, so the runner loads its pixels", () => {
    const h = editorHandoff(
      byKey("action:upscale")!,
      { ...canvas, id: null, run: null, url: "data:image/png;base64,BB" },
      null,
      7,
    );
    expect(h.runId).toBeUndefined();
    expect(h.itemId).toBe("editor:7");
    expect(galleryToolImage(h)).toBeNull();
  });

  it("the runner takes it like any other hand-off", () => {
    const h = editorHandoff(byKey("action:edit_photo")!, canvas, MASK, 100);
    const { handoff, remaining } = takeHandoff(h, "action:edit_photo", 200);
    expect(handoff?.origin).toBe("editor");
    expect(handoff?.mask).toBe(MASK);
    expect(remaining).toBeNull();
    expect(takeHandoff(h, "action:upscale", 200).handoff).toBeNull();
  });
});

describe("editorSourceRun", () => {
  const gallery = [
    { id: "g1", runId: "r1", jobIndex: 3 },
    { id: "g2", runId: undefined as unknown as string, jobIndex: 0 },
  ];
  it("prefers the run a tool result set", () => {
    expect(editorSourceRun({ runId: "x", jobIndex: 0 }, "g1", gallery)).toEqual(
      {
        runId: "x",
        jobIndex: 0,
      },
    );
  });
  it("falls back to the gallery item; null for uploads", () => {
    expect(editorSourceRun(null, "g1", gallery)).toEqual({
      runId: "r1",
      jobIndex: 3,
    });
    expect(editorSourceRun(null, "g2", gallery)).toBeNull();
    expect(editorSourceRun(null, null, gallery)).toBeNull();
  });
});

describe("routeEditorToolRun: where a result goes", () => {
  const tracked = (
    origin: EditorToolRun["origin"] = "inline",
  ): EditorToolRun => ({
    runId: "r9",
    title: "Detail",
    origin,
    at: 0,
  });
  const run = (jobs: Partial<ImagineRun["jobs"][number]>[]): ImagineRun =>
    ({
      run_id: "r9",
      jobs: jobs.map((j, index) => ({
        index,
        status: "done",
        images: [],
        ...j,
      })),
    }) as unknown as ImagineRun;

  it("waits while missing, empty, queued or running", () => {
    expect(routeEditorToolRun(tracked(), undefined).kind).toBe("wait");
    expect(routeEditorToolRun(tracked(), run([])).kind).toBe("wait");
    expect(
      routeEditorToolRun(tracked(), run([{ status: "queued" }])).kind,
    ).toBe("wait");
    expect(
      routeEditorToolRun(
        tracked(),
        run([{ status: "done", images: ["a"] }, { status: "running" }]),
      ).kind,
    ).toBe("wait");
  });

  it("fails with the job error, or a plain message", () => {
    expect(
      routeEditorToolRun(tracked(), run([{ status: "error", error: "OOM" }])),
    ).toEqual({
      kind: "failed",
      message: "Detail failed: OOM",
    });
    expect(
      routeEditorToolRun(tracked(), run([{ status: "cancelled" }])),
    ).toEqual({
      kind: "failed",
      message: "Detail did not finish.",
    });
    expect(
      routeEditorToolRun(tracked(), run([{ status: "done", images: [] }])).kind,
    ).toBe("failed");
  });

  it("images from all finished jobs become layers", () => {
    expect(
      routeEditorToolRun(
        tracked(),
        run([
          { status: "done", images: ["a", "b"] },
          { status: "error", error: "x" },
          { status: "done", images: ["c"] },
        ]),
      ),
    ).toEqual({
      kind: "apply",
      images: ["a", "b", "c"],
      runId: "r9",
      jobIndex: 0,
    });
  });

  it("video / 3D open from inline runs, notify from Tools page runs", () => {
    const vid = run([{ status: "done", videos: ["v.mp4"] }]);
    const mesh = run([
      { status: "done", meshes: ["m.glb"], images: ["preview"] },
    ]);
    expect(routeEditorToolRun(tracked("inline"), vid)).toEqual({
      kind: "open",
      output: "video",
      runId: "r9",
    });
    expect(routeEditorToolRun(tracked("inline"), mesh)).toMatchObject({
      output: "3d",
    });
    expect(routeEditorToolRun(tracked("tool"), vid)).toEqual({
      kind: "notify",
      output: "video",
    });
  });
});

describe("editorMaskToBinaryPixels", () => {
  it("any painted alpha is white, the rest opaque black", () => {
    const rgba = new Uint8ClampedArray([
      255, 0, 0, 128, 0, 0, 0, 0, 10, 20, 30, 1,
    ]);
    const { pixels, painted } = editorMaskToBinaryPixels(rgba);
    expect(painted).toBe(2);
    expect(Array.from(pixels)).toEqual([
      255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255,
    ]);
  });
});

describe("editorStore: tool results", () => {
  beforeEach(() => useEditorStore.getState().resetEditor());

  it("trackToolRun dedupes by run id; untrack removes", () => {
    const s = useEditorStore.getState();
    s.trackToolRun({ runId: "a", title: "A", origin: "inline", at: 1 });
    s.trackToolRun({ runId: "a", title: "A2", origin: "inline", at: 2 });
    s.trackToolRun({ runId: "b", title: "B", origin: "tool", at: 3 });
    expect(useEditorStore.getState().toolRuns.map((r) => r.title)).toEqual([
      "A2",
      "B",
    ]);
    s.untrackToolRun("a");
    expect(useEditorStore.getState().toolRuns.map((r) => r.runId)).toEqual([
      "b",
    ]);
  });

  it("a result becomes a layer and the canvas; undo/redo swap the canvas back", () => {
    const s = useEditorStore.getState();
    s.openEditor("orig.png", "g0");
    s.applyToolResult({
      images: ["detail.png"],
      title: "Detail",
      run: { runId: "r1", jobIndex: 0 },
      galleryId: "g1",
    });
    let st = useEditorStore.getState();
    expect(st.sourceImage).toBe("detail.png");
    expect(st.sourceImageId).toBe("g1");
    expect(st.sourceRun).toEqual({ runId: "r1", jobIndex: 0 });
    expect(st.layers.at(-1)).toMatchObject({
      name: "Detail",
      imageUrl: "detail.png",
    });

    st.undo();
    st = useEditorStore.getState();
    expect(st.sourceImage).toBe("orig.png");
    expect(st.sourceImageId).toBe("g0");
    expect(st.sourceRun).toBeNull();
    expect(st.layers.some((l) => l.name === "Detail")).toBe(false);

    st.redo();
    st = useEditorStore.getState();
    expect(st.sourceImage).toBe("detail.png");
    expect(st.sourceRun).toEqual({ runId: "r1", jobIndex: 0 });
  });

  it("several images add numbered layers; the first is the canvas", () => {
    const s = useEditorStore.getState();
    s.openEditor("orig.png");
    s.applyToolResult({
      images: ["l1.png", "l2.png"],
      title: "Layers",
      run: { runId: "r2", jobIndex: 0 },
      galleryId: null,
    });
    const st = useEditorStore.getState();
    expect(st.sourceImage).toBe("l1.png");
    expect(st.layers.slice(-2).map((l) => l.name)).toEqual([
      "Layers 1",
      "Layers 2",
    ]);
  });

  it("closing the editor forgets pending runs", () => {
    const s = useEditorStore.getState();
    s.openEditor("orig.png");
    s.trackToolRun({ runId: "a", title: "A", origin: "inline", at: 1 });
    s.closeEditor();
    expect(useEditorStore.getState().toolRuns).toEqual([]);
  });
});
