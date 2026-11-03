import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SeeThroughResult } from "@/components/tools/SeeThroughResult";
import { ToolRunResult } from "@/components/tools/RunnerStudio";
import type { ImagineRun } from "@/types";

const run = (job: Record<string, unknown>): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "",
    width: 1024,
    height: 1024,
    jobs: [
      { seed: 0, index: 0, status: "done", progress: 100, images: [], ...job },
    ],
    createdAt: new Date().toISOString(),
    status: "done",
    params: {},
  }) as unknown as ImagineRun;

const manifestText =
  "/srv/ComfyUI/output/adrift_layers_20261031_ab12_layers.json";

describe("SeeThroughResult", () => {
  it("starts in a loading state", () => {
    const html = renderToStaticMarkup(
      createElement(SeeThroughResult, { run: run({ texts: [manifestText] }) }),
    );
    expect(html).toContain('data-testid="see-through-result"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading layers...");
  });

  it("renders the fallback when there is no manifest", () => {
    const html = renderToStaticMarkup(
      createElement(SeeThroughResult, {
        run: run({ texts: ["hello"] }),
        fallback: createElement("p", null, "plain"),
      }),
    );
    expect(html).toBe("<p>plain</p>");
  });
});

describe("ToolRunResult layer split hook", () => {
  it("shows the layer viewer instead of the manifest path line", () => {
    const html = renderToStaticMarkup(
      createElement(ToolRunResult, {
        run: run({
          texts: [manifestText],
          images: ["/api/comfy/image?filename=p.png&subfolder=&type=output"],
        }),
        card: null,
      }),
    );
    expect(html).toContain('data-testid="see-through-result"');
    expect(html).not.toContain('data-testid="tool-run-text"');
    expect(html).not.toContain(manifestText);
  });

  it("leaves other text outputs alone", () => {
    const html = renderToStaticMarkup(
      createElement(ToolRunResult, {
        run: run({ texts: ["Estimated FOV: 63°"] }),
        card: null,
      }),
    );
    expect(html).not.toContain("see-through-result");
    expect(html).toContain('data-testid="tool-run-text"');
  });
});
