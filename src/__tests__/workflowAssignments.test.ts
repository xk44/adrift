import { describe, expect, it } from "vitest";
import {
  ACTION_ASSIGNMENT_GROUPS,
  WORKFLOW_ASSIGNMENT_FALLBACKS,
  getAssignmentLabel,
  resolveWorkflowForAssignment,
  resolveWorkflowForAction,
  mergeActionAndSlotAssignments,
  getSlotIdForAction,
  normalizeWorkflowActionId,
  getSlotById,
  promptHasDedicatedRoute,
  imagineWorkflowPathForPrompt,
} from "@/lib/workflowAssignments";
import type { WorkflowAssignment } from "@/lib/workflowAssignments";

describe("workflow assignment routing", () => {
  it("exposes pipeline slots for promptbar, editor, zoom/outpaint, and single-image action buttons", () => {
    const ids = ACTION_ASSIGNMENT_GROUPS.flatMap((group) =>
      group.slots.map((slot) => slot.id),
    );

    expect(ids).toContain("promptbar.imagine");
    expect(ids).toContain("edit.inpaint");
    expect(ids).toContain("single.zoom_out_2x");
    expect(ids).toContain("single.vary_subtle");
    expect(ids).toContain("single.upscale_creative");
  });

  it("resolves an explicit workflow assignment before selected/default workflow fallbacks", () => {
    const resolved = resolveWorkflowForAssignment({
      slotId: "single.vary_subtle",
      legacyActionId: "vary_subtle",
      assignments: {
        "single.vary_subtle": {
          workflowPath: "saved:vary-special.json",
          workflowName: "Vary Special",
        },
      },
      selectedWorkflowPath: "saved:selected.json",
      defaultWorkflowPath: "saved:default.json",
    });

    expect(resolved).toEqual({
      workflowPath: "saved:vary-special.json",
      workflowName: "Vary Special",
    });
  });

  it("honors legacy actionWorkflowMap overrides for existing gallery/lightbox action ids", () => {
    const resolved = resolveWorkflowForAssignment({
      slotId: "single.vary_strong",
      legacyActionId: "vary_strong",
      assignments: {},
      legacyActionMap: {
        vary_strong: {
          workflowPath: "saved:legacy-vary.json",
          workflowName: "Legacy Vary",
        },
      },
      defaultWorkflowPath: "saved:default.json",
    });

    expect(resolved?.workflowPath).toBe("saved:legacy-vary.json");
  });

  it("falls back promptbar to selected workflow then app default", () => {
    expect(
      resolveWorkflowForAssignment({
        slotId: "promptbar.imagine",
        assignments: {},
        selectedWorkflowPath: "saved:selected.json",
        defaultWorkflowPath: "saved:default.json",
      })?.workflowPath,
    ).toBe("saved:selected.json");

    expect(
      resolveWorkflowForAssignment({
        slotId: "promptbar.imagine",
        assignments: {},
        defaultWorkflowPath: "saved:default.json",
      })?.workflowPath,
    ).toBe("saved:default.json");
  });

  it("labels unmapped slots with their built-in fallback", () => {
    expect(getAssignmentLabel("promptbar.imagine", {})).toBe(
      WORKFLOW_ASSIGNMENT_FALLBACKS["promptbar.imagine"],
    );
  });
});

describe("resolveWorkflowForAction", () => {
  it("converts action IDs to slot IDs and resolves correctly", () => {
    const result = resolveWorkflowForAction("vary_subtle", {
      assignments: {
        "single.vary_subtle": {
          workflowPath: "saved:my-vary.json",
          workflowName: "My Vary",
        },
      },
    });
    expect(result?.workflowPath).toBe("saved:my-vary.json");
  });

  it("never applies the Create picker's selected/default workflow to image actions", () => {
    // A t2i graph has no LoadImage: the server would throw "I2I slot
    // discovery failed" and skip the action packs. Image actions fall back
    // to server routing instead.
    for (const action of [
      "upscale_creative",
      "vary_subtle",
      "pan_left",
      "zoom_out_2x",
      "animate_low",
      "make_3d",
      "edit.inpaint",
    ]) {
      expect(
        resolveWorkflowForAction(action, {
          selectedWorkflowPath: "krea2_t2i.json",
          defaultWorkflowPath: "saved:default.json",
        }),
      ).toBeUndefined();
    }
  });

  it("still honours explicit slot and legacy assignments for image actions", () => {
    expect(
      resolveWorkflowForAction("upscale_creative", {
        assignments: { "single.upscale_creative": { workflowPath: "saved:up.json" } },
        selectedWorkflowPath: "krea2_t2i.json",
      })?.workflowPath,
    ).toBe("saved:up.json");
    expect(
      resolveWorkflowForAction("vary_strong", {
        legacyActionMap: { vary_strong: { workflowPath: "saved:legacy.json" } },
        selectedWorkflowPath: "krea2_t2i.json",
      })?.workflowPath,
    ).toBe("saved:legacy.json");
  });

  it("promptbar still falls back to selected then default", () => {
    expect(
      resolveWorkflowForAction("promptbar.imagine", {
        selectedWorkflowPath: "krea2_t2i.json",
        defaultWorkflowPath: "saved:default.json",
      })?.workflowPath,
    ).toBe("krea2_t2i.json");
    expect(
      resolveWorkflowForAction("promptbar.imagine", {
        defaultWorkflowPath: "saved:default.json",
      })?.workflowPath,
    ).toBe("saved:default.json");
  });

  it("resolves promptbar.imagine action ID", () => {
    const result = resolveWorkflowForAction("promptbar.imagine", {
      assignments: {
        "promptbar.imagine": {
          workflowPath: "saved:custom-t2i.json",
        },
      },
    });
    expect(result?.workflowPath).toBe("saved:custom-t2i.json");
  });

  it("resolves edit.inpaint action ID", () => {
    const result = resolveWorkflowForAction("edit.inpaint", {
      assignments: {
        "edit.inpaint": {
          workflowPath: "saved:custom-inpaint.json",
        },
      },
    });
    expect(result?.workflowPath).toBe("saved:custom-inpaint.json");
  });

  it("normalizes zoom_out_1_5x action to its slot", () => {
    const result = resolveWorkflowForAction("zoom_out_1_5x", {
      assignments: {
        "single.zoom_out_1_5x": {
          workflowPath: "saved:zoom-1.5x.json",
        },
      },
    });
    expect(result?.workflowPath).toBe("saved:zoom-1.5x.json");
  });

  it("returns undefined when nothing matches", () => {
    const result = resolveWorkflowForAction("vary_subtle", {});
    expect(result).toBeUndefined();
  });

  it("uses legacyActionMap for legacy action IDs without slot assignments", () => {
    const result = resolveWorkflowForAction("vary_subtle", {
      legacyActionMap: {
        vary_subtle: {
          workflowPath: "saved:legacy-vary.json",
          workflowName: "Legacy Vary",
        },
      },
    });
    expect(result?.workflowPath).toBe("saved:legacy-vary.json");
  });
});

describe("mergeActionAndSlotAssignments", () => {
  it("converts legacy actionWorkflowMap keys to slot IDs", () => {
    const actionWorkflowMap = {
      vary_subtle: { workflowPath: "vary-subtle-wf.json" },
      upscale_creative: { workflowPath: "upscale-creative-wf.json" },
    };

    const result = mergeActionAndSlotAssignments(actionWorkflowMap);

    expect(result["single.vary_subtle"]?.workflowPath).toBe(
      "vary-subtle-wf.json",
    );
    expect(result["single.upscale_creative"]?.workflowPath).toBe(
      "upscale-creative-wf.json",
    );
  });

  it("preserves slot-based assignments over legacy map entries", () => {
    const actionWorkflowMap = {
      vary_subtle: { workflowPath: "legacy-wf.json" },
    };

    const slotAssignments: Record<string, WorkflowAssignment | undefined> = {
      "single.vary_subtle": {
        workflowPath: "slot-wf.json",
        workflowName: "Slot Vary",
      },
    };

    const result = mergeActionAndSlotAssignments(
      actionWorkflowMap,
      slotAssignments,
    );

    // Slot-based assignment should take priority
    expect(result["single.vary_subtle"]?.workflowPath).toBe("slot-wf.json");
  });

  it("fills in from legacy map when slot assignment is absent", () => {
    const actionWorkflowMap = {
      vary_subtle: { workflowPath: "legacy-wf.json" },
    };

    const result = mergeActionAndSlotAssignments(actionWorkflowMap, {});

    expect(result["single.vary_subtle"]?.workflowPath).toBe("legacy-wf.json");
  });

  it("handles zoom_out_1_5x normalization in action map", () => {
    const actionWorkflowMap = {
      zoom_out_1_5x: { workflowPath: "zoom-1.5x-wf.json" },
    };

    const result = mergeActionAndSlotAssignments(actionWorkflowMap);

    expect(result["single.zoom_out_1_5x"]?.workflowPath).toBe(
      "zoom-1.5x-wf.json",
    );
  });
});

describe("getSlotIdForAction", () => {
  it("maps known action IDs to their canonical slot IDs", () => {
    expect(getSlotIdForAction("vary_subtle")).toBe("single.vary_subtle");
    expect(getSlotIdForAction("upscale_creative")).toBe(
      "single.upscale_creative",
    );
    // legacy "edit" (the old inpaint mapping) feeds the editor inpaint slot
    expect(getSlotIdForAction("edit")).toBe("edit.inpaint");
    expect(getSlotIdForAction("zoom_out_1_5x")).toBe(
      "single.zoom_out_1_5x",
    );
    expect(getSlotIdForAction("animate_low")).toBe("expand.animate_low");
    expect(getSlotIdForAction("make_3d")).toBe("expand.make_3d");
  });

  it("returns slot-style ID for unknown actions", () => {
    expect(getSlotIdForAction("custom_action")).toBe("single.custom_action");
  });
});

describe("normalizeWorkflowActionId", () => {
  it("normalizes zoom_out_1_5x to zoom_1_5x", () => {
    expect(normalizeWorkflowActionId("zoom_out_1_5x")).toBe("zoom_1_5x");
  });

  it("normalizes zoom_out_2x to zoom_2x", () => {
    expect(normalizeWorkflowActionId("zoom_out_2x")).toBe("zoom_2x");
  });

  it("passes through other action IDs unchanged", () => {
    expect(normalizeWorkflowActionId("vary_subtle")).toBe("vary_subtle");
    expect(normalizeWorkflowActionId("upscale_creative")).toBe(
      "upscale_creative",
    );
    expect(normalizeWorkflowActionId("edit")).toBe("edit");
  });
});
describe("imagine routing flags", () => {
  it("detects routing flags as whole tokens, case-insensitively", () => {
    expect(promptHasDedicatedRoute("a cat --video --ar 16:9")).toBe(true);
    expect(promptHasDedicatedRoute("a cat --SREF 123")).toBe(true);
    expect(promptHasDedicatedRoute("a cat\n--3d")).toBe(true);
    expect(promptHasDedicatedRoute("a cat --ar 3:2 --stylize 200")).toBe(false);
    expect(promptHasDedicatedRoute("--videogame poster")).toBe(false);
  });

  it("drops workflow_path only when the prompt has a dedicated route", () => {
    expect(imagineWorkflowPathForPrompt("krea2_t2i.json", "a cat")).toBe(
      "krea2_t2i.json",
    );
    expect(
      imagineWorkflowPathForPrompt("krea2_t2i.json", "a cat --video"),
    ).toBeUndefined();
    expect(imagineWorkflowPathForPrompt(undefined, "a cat")).toBeUndefined();
    expect(imagineWorkflowPathForPrompt(null, "a cat")).toBeUndefined();
  });
});

describe("dead slots and legacy mapping (#8)", () => {
  it("has no dead editor-zoom, text-to-video or single.edit slots", () => {
    for (const id of [
      "edit.zoom_out_1_5x",
      "edit.zoom_out_2x",
      "expand.text_to_video",
      "single.edit",
    ]) {
      expect(getSlotById(id)).toBeUndefined();
    }
  });

  it("legacy zoom keys reach the live lightbox zoom slots", () => {
    expect(getSlotIdForAction("zoom_1_5x")).toBe("single.zoom_out_1_5x");
    expect(getSlotIdForAction("zoom_2x")).toBe("single.zoom_out_2x");
    const merged = mergeActionAndSlotAssignments({
      zoom_1_5x: { workflowPath: "saved:zoom.json" },
    });
    expect(
      resolveWorkflowForAction("zoom_out_1_5x", { assignments: merged })
        ?.workflowPath,
    ).toBe("saved:zoom.json");
  });

  it("legacy edit mapping feeds inpaint instead of hijacking it", () => {
    const merged = mergeActionAndSlotAssignments({
      edit: { workflowPath: "saved:inpaint.json" },
    });
    expect(
      resolveWorkflowForAction("edit.inpaint", { assignments: merged })
        ?.workflowPath,
    ).toBe("saved:inpaint.json");
  });

  it("a slot-key assignment beats a legacy key regardless of insert order", () => {
    const merged = mergeActionAndSlotAssignments({
      vary_subtle: { workflowPath: "saved:old.json" },
      "single.vary_subtle": { workflowPath: "packs/krea2/i2i.json" },
    });
    expect(merged["single.vary_subtle"]?.workflowPath).toBe(
      "packs/krea2/i2i.json",
    );
  });

  it("only the promptbar fallback copy mentions the selected workflow", () => {
    for (const [id, text] of Object.entries(WORKFLOW_ASSIGNMENT_FALLBACKS)) {
      if (id.startsWith("promptbar.")) {
        expect(text).toMatch(/Selected workflow/);
      } else {
        expect(text).not.toMatch(/Selected workflow|app default/i);
      }
    }
  });

  it("no slot copy mentions TripoSR", () => {
    expect(JSON.stringify(ACTION_ASSIGNMENT_GROUPS)).not.toMatch(/TripoSR/i);
  });
});

describe("listUnslottedMappings / mappingKeysForSlot", () => {
  it("lists live mappings that have no Pipelines row, ignoring slotted ones", async () => {
    const { listUnslottedMappings } = await import("@/lib/workflowAssignments");
    const map = {
      "single.vary_subtle": { workflowPath: "saved:a.json" },
      vary_strong: { workflowPath: "saved:b.json" },
      detail: { workflowPath: "saved:c.json", workflowName: "C" },
      "expand.text_to_video": { workflowPath: "saved:d.json" },
    };
    expect(listUnslottedMappings(map).map((m) => m.key).sort()).toEqual([
      "detail",
      "expand.text_to_video",
    ]);
  });

  it("finds every key that routes to a slot, including legacy aliases", async () => {
    const { mappingKeysForSlot } = await import("@/lib/workflowAssignments");
    const map = {
      "single.zoom_out_1_5x": { workflowPath: "x" },
      zoom_1_5x: { workflowPath: "y" },
      zoom_out_1_5x: { workflowPath: "z" },
      zoom_2x: { workflowPath: "w" },
    };
    expect(mappingKeysForSlot(map, "single.zoom_out_1_5x").sort()).toEqual([
      "single.zoom_out_1_5x",
      "zoom_1_5x",
      "zoom_out_1_5x",
    ]);
  });
});
