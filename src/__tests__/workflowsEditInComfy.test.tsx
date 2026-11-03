/**
 * Workflows page: "Edit in ComfyUI" per saved-workflow card and in the empty
 * state (static render, no DOM library).
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowManager, type WorkflowData } from "@/components/WorkflowsPage";

const wf = (file: string, name: string): WorkflowData => ({
  id: file,
  name,
  file,
  path: `/comfy/user/default/workflows/${file}`,
  source: "saved",
});

describe("WorkflowManager Edit in ComfyUI", () => {
  it("renders one Edit in ComfyUI action per card", () => {
    const html = renderToStaticMarkup(
      createElement(WorkflowManager, {
        initialWorkflows: [wf("a.json", "alpha"), wf("sub/b.json", "beta")],
      }),
    );
    const labels = html.match(/aria-label="Edit [^"]+ in ComfyUI"/g) ?? [];
    expect(labels).toHaveLength(2);
    expect(html).toContain("Refresh");
  });

  it("shows the editor hint and action in the empty state", () => {
    const html = renderToStaticMarkup(
      createElement(WorkflowManager, { initialWorkflows: [] }),
    );
    expect(html).toContain(
      "Build or edit graphs in ComfyUI&#x27;s editor — they show up here.",
    );
    expect(html).toContain("Open ComfyUI");
  });
});
