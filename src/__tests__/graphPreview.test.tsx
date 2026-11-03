import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { graphJson, graphSummary } from "@/lib/tools/graphPreview";
import {
  exportActionToolWorkflow,
  submitActionTool,
  type ApiWorkflowJson,
  type FetchLike,
} from "@/lib/tools/runTool";
import { defaultSettings, getActionTool } from "@/lib/tools/toolsPage";
import { GraphPreviewBody } from "@/components/tools/GraphPreview";

const WF: ApiWorkflowJson = {
  "10": { class_type: "SaveImage", inputs: { images: ["2", 0] } },
  "2": { class_type: "VAEDecode", inputs: {} },
  "1": { class_type: "LoadImage", inputs: { image: "cj_in.png" } },
  "3": { class_type: "LoadImage", inputs: { image: "cj_ref.png" } },
};

describe("graph preview helpers", () => {
  it("summarises node count and classes, most used first", () => {
    expect(graphSummary(WF)).toEqual({
      nodeCount: 4,
      classes: [
        { classType: "LoadImage", count: 2 },
        { classType: "SaveImage", count: 1 },
        { classType: "VAEDecode", count: 1 },
      ],
    });
    expect(graphSummary({})).toEqual({ nodeCount: 0, classes: [] });
  });

  it("copies pretty API JSON with node ids in numeric order", () => {
    const text = graphJson(WF);
    expect(Object.keys(JSON.parse(text))).toEqual(["1", "2", "3", "10"]);
    expect(JSON.parse(text)).toEqual(WF);
    expect(text).toContain('\n  "1": {');
  });

  it("modal body shows the summary, classes, JSON and a copy button", () => {
    const html = renderToStaticMarkup(
      <GraphPreviewBody workflow={WF} copied={false} onCopy={() => {}} />,
    );
    expect(html).toContain("4 nodes");
    expect(html).toContain("nothing was queued");
    expect(html).toContain("LoadImage ×2");
    expect(html).toContain("Copy JSON");
    expect(html).toContain("cj_in.png");
  });
});

describe("exportActionToolWorkflow (dry run)", () => {
  const spec = getActionTool("upscale")!;
  const image = {
    source: "gallery" as const,
    runId: "run_1",
    jobIndex: 0,
    url: "/x.png",
  };

  function fakeFetch(reply: Record<string, unknown>) {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: FetchLike = vi.fn(
      async (url: string, init?: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return { ok: true, status: 200, json: async () => reply };
      },
    );
    return { fetchImpl, calls };
  }

  const args = (fetchImpl: FetchLike) => ({
    fetchImpl,
    spec,
    settings: defaultSettings(spec),
    editLoras: null,
    image: image as never,
    secondImage: null,
    clientId: "c1",
  });

  it("posts the action body with dry_run and returns the workflow", async () => {
    const { fetchImpl, calls } = fakeFetch({ ok: true, workflow: WF, seed: 7 });
    const out = await exportActionToolWorkflow(args(fetchImpl));
    expect(out).toEqual({ workflow: WF, seed: 7 });
    const post = calls.find((c) => c.url === "/api/jobs/action")!;
    expect(post.body.dry_run).toBe(true);
    expect(post.body.run_id).toBe("run_1");
    expect(post.body.tool_page_id).toBe("upscale");
  });

  it("throws when the server sends no workflow", async () => {
    const { fetchImpl } = fakeFetch({ ok: true });
    await expect(exportActionToolWorkflow(args(fetchImpl))).rejects.toThrow(
      /no workflow/,
    );
  });

  it("a real Run never sends dry_run", async () => {
    const { fetchImpl, calls } = fakeFetch({ ok: true, run: { run_id: "r2" } });
    await submitActionTool(args(fetchImpl));
    const post = calls.find((c) => c.url === "/api/jobs/action")!;
    expect("dry_run" in post.body).toBe(false);
  });
});

describe("ToolRunner wiring", () => {
  it("offers Show graph for image action and catalog tools", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/tools/ToolRunner.tsx"),
      "utf8",
    );
    expect(src).toContain("<ShowGraphButton");
    expect(src).toContain("exportActionToolWorkflow({");
  });
});
