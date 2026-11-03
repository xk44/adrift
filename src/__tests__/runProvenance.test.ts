import { describe, expect, it } from "vitest";
import editToolRegistry from "@/lib/tools/editToolRegistry.json";
import {
  actionLabel,
  GENERIC_EDIT_LABEL,
  madeWithLabelFilter,
  madeWithOptions,
  matchesMadeWith,
  parseMadeWithFilter,
  runProvenance,
  sourceRunLinkTarget,
  toolLabel,
  withActiveMadeWithChoice,
} from "@/lib/runProvenance";
import { isDisplayableParam } from "@/lib/ui/displayParams";
import { catalogToolTitle } from "@/lib/tools/toolNames";

/*
 * Fixtures mirror what reaches the client as GalleryImage.paramsMap / RecentRun
 * .params: the source run's params spread first, then the route's own keys
 * (src/app/api/jobs/action/route.ts, src/app/api/jobs/tool/route.ts).
 */
const promptRun = {
  ar: "16:9",
  stylize: 250,
  seed: 1234,
  packId: "krea2",
};

const upscaleRun = {
  ...promptRun,
  action_source_run_id: "run-src",
  action_workflow_path: "/srv/adrift/public/workflows/upscale_creative.json",
  action_provenance: { kind: "action", id: "upscale_creative", via: "upscale" },
};

const varyRun = {
  ...promptRun,
  action_source_run_id: "run-src",
  action_workflow_path: "/srv/adrift/public/workflows/vary_strong.json",
  action_provenance: { kind: "action", id: "vary_strong" },
};

const firstTool = (
  editToolRegistry as { tools: { id: string; label: string }[] }
).tools[0];

/** Chips show the canonical Tools-page name (outpaint backends → Expand). */
const firstToolTitle = catalogToolTitle(firstTool.id) ?? firstTool.label;

const toolRun = {
  ...promptRun,
  tool_id: firstTool.id,
  tool_options: { strength: 0.6 },
  action_source_run_id: "run-src",
  action_provenance: { kind: "tool", id: firstTool.id, label: firstTool.label },
};

describe("runProvenance", () => {
  it("returns null for plain prompt runs and missing params", () => {
    expect(runProvenance(promptRun)).toBeNull();
    expect(runProvenance({})).toBeNull();
    expect(runProvenance(undefined)).toBeNull();
    expect(runProvenance(null)).toBeNull();
  });

  it("labels action stamps with group · variant", () => {
    expect(runProvenance(upscaleRun)).toEqual({
      kind: "action",
      id: "upscale_creative",
      label: "Upscale · Creative",
      sourceRunId: "run-src",
    });
    expect(runProvenance(varyRun)?.label).toBe("Vary · Strong");
  });

  it("uses the Tools page title for the card that submitted the action", () => {
    const run = {
      action_source_run_id: "run-src",
      action_provenance: {
        kind: "action",
        id: "some_edit",
        via: "remove_object",
      },
    };
    expect(runProvenance(run)?.label).toBe("Object Remover");
  });

  it("ignores an unknown via and falls back to the action id", () => {
    expect(actionLabel("vary_subtle", "not_a_card")).toBe("Vary · Subtle");
    expect(actionLabel("brand_new_thing", "not_a_card")).toBe(
      "Brand new thing",
    );
  });

  it("treats rerun as a prompt run", () => {
    expect(
      runProvenance({
        ...promptRun,
        action_provenance: { kind: "action", id: "rerun" },
      }),
    ).toBeNull();
    expect(actionLabel("rerun")).toBeNull();
  });

  it("labels tool stamps with the canonical tool name", () => {
    expect(runProvenance(toolRun)).toEqual({
      kind: "tool",
      id: firstTool.id,
      label: firstToolTitle,
      sourceRunId: "run-src",
    });
    expect(firstTool.label).toBe("Outpaint");
    expect(firstToolTitle).toBe("Expand");
    expect(toolLabel("unknown-tool", "Stored label")).toBe("Stored label");
    expect(toolLabel("unknown-tool")).toBe("Unknown tool");
  });

  it("prefers the newest stamp over inherited legacy keys", () => {
    // Upscale of a tool run: tool_id was inherited from the source.
    const upscaleOfTool = { ...toolRun, ...upscaleRun };
    expect(runProvenance(upscaleOfTool)?.label).toBe("Upscale · Creative");
    // Tool run on an upscaled image: action_workflow_path was inherited.
    const toolOfUpscale = { ...upscaleRun, ...toolRun };
    expect(runProvenance(toolOfUpscale)?.label).toBe(firstToolTitle);
  });

  it("falls back to legacy keys on pre-stamp rows", () => {
    const { action_provenance: _a, ...legacyAction } = upscaleRun;
    expect(runProvenance(legacyAction)).toEqual({
      kind: "action",
      id: "upscale_creative",
      label: "Upscale · Creative",
      sourceRunId: "run-src",
    });
    const { action_provenance: _t, ...legacyTool } = toolRun;
    expect(runProvenance(legacyTool)?.label).toBe(firstToolTitle);
  });

  it("labels legacy edits with an unknown workflow generically", () => {
    expect(
      runProvenance({
        action_source_run_id: "run-src",
        action_workflow_path: "saved:My custom graph",
      }),
    ).toEqual({
      kind: "action",
      id: "",
      label: GENERIC_EDIT_LABEL,
      sourceRunId: "run-src",
    });
  });

  it("labels ambiguous legacy edits (both keys) generically", () => {
    expect(
      runProvenance({
        tool_id: firstTool.id,
        action_workflow_path: "/srv/adrift/public/workflows/vary_strong.json",
        action_source_run_id: "run-src",
      }),
    ).toEqual({
      kind: "tool",
      id: "",
      label: GENERIC_EDIT_LABEL,
      sourceRunId: "run-src",
    });
  });

  it("shows nothing for legacy rows without evidence of an edit", () => {
    // Unknown workflow, no source-run link.
    const unknown = { ...promptRun, action_workflow_path: "saved:My graph" };
    expect(runProvenance(unknown)).toBeNull();
    expect(matchesMadeWith(unknown, "prompts")).toBe(true);
    // Both keys, no source-run link: which one applies is unknowable.
    expect(
      runProvenance({
        ...promptRun,
        tool_id: firstTool.id,
        action_workflow_path: "/srv/adrift/public/workflows/vary_strong.json",
      }),
    ).toBeNull();
    expect(
      madeWithOptions([{ runId: "legacy", paramsMap: unknown }]),
    ).toEqual([]);
  });

  it("still names legacy rows whose keys pin the tool down", () => {
    expect(
      runProvenance({
        action_workflow_path: "/srv/adrift/public/workflows/vary_strong.json",
      })?.label,
    ).toBe("Vary · Strong");
    expect(runProvenance({ tool_id: firstTool.id })?.label).toBe(
      firstToolTitle,
    );
  });

  it("ignores malformed stamps", () => {
    expect(runProvenance({ action_provenance: "upscale" })).toBeNull();
    expect(runProvenance({ action_provenance: { kind: "action" } })).toBeNull();
  });

  it("is memoized per params object", () => {
    expect(runProvenance(upscaleRun)).toBe(runProvenance(upscaleRun));
  });

  it("hides tool_id and the stamp from param chips", () => {
    expect(isDisplayableParam("tool_id", firstTool.id)).toBe(false);
    expect(
      isDisplayableParam("action_provenance", upscaleRun.action_provenance),
    ).toBe(false);
  });
});

describe("Made with filter", () => {
  it("matches all / prompts / tools", () => {
    expect(matchesMadeWith(promptRun, "all")).toBe(true);
    expect(matchesMadeWith(upscaleRun, "all")).toBe(true);
    expect(matchesMadeWith(promptRun, "prompts")).toBe(true);
    expect(matchesMadeWith(upscaleRun, "prompts")).toBe(false);
    expect(matchesMadeWith(promptRun, "tools")).toBe(false);
    expect(matchesMadeWith(toolRun, "tools")).toBe(true);
    expect(matchesMadeWith(undefined, "prompts")).toBe(true);
  });

  it("matches a single tool label", () => {
    const f = madeWithLabelFilter("Upscale · Creative");
    expect(matchesMadeWith(upscaleRun, f)).toBe(true);
    expect(matchesMadeWith(varyRun, f)).toBe(false);
    expect(matchesMadeWith(promptRun, f)).toBe(false);
  });

  it("lists labels by distinct run count, ties A→Z", () => {
    const items = [
      { runId: "a", paramsMap: varyRun },
      { runId: "a", paramsMap: varyRun },
      { runId: "a", paramsMap: varyRun },
      { runId: "b", paramsMap: upscaleRun },
      { runId: "c", paramsMap: upscaleRun },
      { runId: "d", paramsMap: toolRun },
      { runId: "e", paramsMap: promptRun },
      { runId: "f" },
    ];
    expect(madeWithOptions(items)).toEqual([
      { label: "Upscale · Creative", count: 2 },
      ...[
        { label: "Vary · Strong", count: 1 },
        { label: firstToolTitle, count: 1 },
      ].sort((x, y) => x.label.localeCompare(y.label)),
    ]);
    expect(madeWithOptions([])).toEqual([]);
  });

  it("parses stored filters, falling back to all", () => {
    expect(parseMadeWithFilter("prompts")).toBe("prompts");
    expect(parseMadeWithFilter("tools")).toBe("tools");
    expect(parseMadeWithFilter("label:Upscale · Creative")).toBe(
      "label:Upscale · Creative",
    );
    expect(parseMadeWithFilter("label:   ")).toBe("all");
    expect(parseMadeWithFilter(`label:${"x".repeat(200)}`)).toBe("all");
    expect(parseMadeWithFilter("bogus")).toBe("all");
    expect(parseMadeWithFilter(42)).toBe("all");
    expect(parseMadeWithFilter(undefined)).toBe("all");
  });

  it("keeps a remembered label choice visible when no loaded run has it", () => {
    const options = [{ label: "Vary · Strong", count: 2 }];
    expect(withActiveMadeWithChoice(options, "tools")).toBe(options);
    expect(
      withActiveMadeWithChoice(options, madeWithLabelFilter("Vary · Strong")),
    ).toBe(options);
    expect(
      withActiveMadeWithChoice(options, madeWithLabelFilter("Expand")),
    ).toEqual([...options, { label: "Expand", count: 0 }]);
  });
});

describe("sourceRunLinkTarget", () => {
  it("links to the source run whether or not it is loaded", () => {
    const p = runProvenance({ tool_id: "upscale", action_source_run_id: "run-src" });
    expect(sourceRunLinkTarget(p, "run-new")).toBe("run-src");
  });

  it("hides the link without a source or for a self-reference", () => {
    expect(sourceRunLinkTarget(null, "run-1")).toBeUndefined();
    expect(sourceRunLinkTarget(runProvenance({ tool_id: "upscale" }), "run-1")).toBeUndefined();
    const self = runProvenance({ tool_id: "upscale", action_source_run_id: "run-1" });
    expect(sourceRunLinkTarget(self, "run-1")).toBeUndefined();
  });
});
