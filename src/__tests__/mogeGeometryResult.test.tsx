/**
 * Tool result card for a MoGe run: both maps in a grid beside the GLB
 * links, plus the estimated-FOV text output.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolRunResult } from "@/components/tools/RunnerStudio";
import type { ImagineRun } from "@/types";

const view = (f: string) => `/api/comfy/image?filename=${f}&subfolder=&type=output`;

const run = (job: Record<string, unknown>): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "",
    width: 1024,
    height: 768,
    jobs: [{ seed: 0, index: 0, status: "done", progress: 100, ...job }],
    createdAt: new Date().toISOString(),
    status: "done",
    params: {},
  }) as unknown as ImagineRun;

const html = (r: ImagineRun) =>
  renderToStaticMarkup(createElement(ToolRunResult, { run: r, card: null }));

describe("ToolRunResult with maps, mesh and text", () => {
  it("shows every map, the mesh links and the FOV line", () => {
    const out = html(
      run({
        images: [view("depth.png"), view("normal.png")],
        meshes: [view("adrift_moge.glb")],
        texts: ["Estimated FOV: 63.2° horizontal"],
      }),
    );
    expect(out).toContain("depth.png");
    expect(out).toContain("normal.png");
    expect(out).toContain("adrift_moge.glb");
    expect(out).toContain("Estimated FOV: 63.2° horizontal");
    expect(out).not.toContain("3D model preview");
  });

  it("keeps the single preview for one-image mesh tools", () => {
    const out = html(
      run({ images: [view("preview.png")], meshes: [view("m.glb")] }),
    );
    expect(out).toContain("3D model preview");
  });

  it("shows text with images when there is no mesh", () => {
    const out = html(
      run({
        images: [view("depth.png"), view("normal.png")],
        texts: ["Estimated FOV: 50.0° horizontal"],
      }),
    );
    expect(out).toContain("normal.png");
    expect(out).toContain("Estimated FOV: 50.0° horizontal");
  });
});
