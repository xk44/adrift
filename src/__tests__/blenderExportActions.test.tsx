/** One "Export for Blender" control for every 3D output, rendered statically. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BlenderExportActions } from "@/components/BlenderExportActions";

const render = (props: Parameters<typeof BlenderExportActions>[0]) =>
  renderToStaticMarkup(createElement(BlenderExportActions, props));

describe("BlenderExportActions", () => {
  it("links a mesh bundle from view URLs", () => {
    const html = render({
      urls: ["/api/comfy/image?filename=h_00001_.glb&subfolder=3d&type=output"],
      className: "btn",
    });
    expect(html).toContain("/api/comfy/blender-bundle?filename=h_00001_.glb");
    expect(html).toContain("Export for Blender");
  });

  it("offers FBX for a job with a GLB, not for splats or layers", () => {
    const of = (name: string) =>
      render({
        urls: [`/api/comfy/image?filename=${name}&subfolder=3d&type=output`],
        className: "btn",
      });
    expect(of("h_00001_.glb")).toContain("Export FBX");
    expect(of("h_00001_.ply")).toContain("Export for Blender");
    expect(of("h_00001_.ply")).not.toContain("Export FBX");
    expect(
      render({ source: { kind: "layers", manifest: "ls_1_layers.json" }, className: "btn" }),
    ).not.toContain("Export FBX");
  });

  it("icon variant is labelled and points at the layer bundle", () => {
    const html = render({
      source: { kind: "layers", manifest: "ls_1_layers.json", resolution: 1280 },
      variant: "icon",
      className: "btn",
    });
    expect(html).toContain('aria-label="Export for Blender"');
    expect(html).toContain("layers=ls_1_layers.json");
    expect(html).toContain("image planes");
  });

  it("renders nothing without a 3D source", () => {
    expect(render({ source: null, className: "btn" })).toBe("");
    expect(render({ urls: ["/api/comfy/image?filename=a.png"], className: "b" })).toBe("");
  });

  it("is wired into the lightbox toolbar and stage with the job's source", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/Lightbox.tsx"),
      "utf8",
    );
    expect(src).toContain("blenderSourceFor({");
    expect(src.match(/source=\{blenderSource\}/g)).toHaveLength(3);
    expect(src).toContain('variant="icon"');
    // No duplicate toolbar icon on the 3D view, which has labelled buttons.
    expect(src).toMatch(/!currentImage\?\.meshUrl && \(\s*<BlenderExportActions/);
  });
});
