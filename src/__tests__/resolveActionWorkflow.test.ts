/**
 * Action -> workflow resolution with a template fallback: an action id no
 * pack maps must not land on the generic t2i.json (Animate on a krea2 default
 * pack used to get an image graph and fail video slot discovery).
 */
import { describe, expect, it, vi } from "vitest";
import { getDefaultPack, getPack, resolveActionWorkflow } from "@/lib/oj/packs";

describe("resolveActionWorkflow", () => {
  const def = getDefaultPack();

  it("keeps action-keyed pack graphs", () => {
    const key = Object.keys(def.workflows).find((k) => k.startsWith("vary_"));
    if (!key) return; // default pack without vary graphs: nothing to assert
    const r = resolveActionWorkflow({ templateOrAction: key, template: "i2i" });
    expect(r.source).toBe("pack_workflow");
    expect(r.workflowPath).toBe(def.workflows[key]);
  });

  it("routes animate to a video pack's i2v graph, never t2i.json", () => {
    const r = resolveActionWorkflow(
      { templateOrAction: "animate_low", template: "i2v" },
      [undefined, "ltx25"],
    );
    expect(r.workflowPath).not.toMatch(/(^|\/)t2i\.json$/);
    if (!def.workflows.i2v) {
      expect(r.workflowPath).toBe(getPack("ltx25")!.workflows.i2v);
      expect(r.pack?.id).toBe("ltx25");
    }
  });

  it("an explicit pack hint resolves the template inside that pack", () => {
    const r = resolveActionWorkflow(
      { templateOrAction: "animate_high", template: "i2v", packId: "wan" },
      ["ltx25"],
    );
    expect(r.workflowPath).toBe(getPack("wan")!.workflows.i2v);
  });

  it("falls back to the registry template file without a providing pack", () => {
    const r = resolveActionWorkflow(
      { templateOrAction: "make_3d", template: "i23d" },
      [],
    );
    expect(r.workflowPath).not.toBe("t2i.json");
  });

  it("user override still wins", () => {
    const r = resolveActionWorkflow({
      templateOrAction: "animate_low",
      template: "i2v",
      userWorkflowPath: "mine.json",
    });
    expect(r).toMatchObject({
      workflowPath: "mine.json",
      source: "user_override",
    });
  });
});

describe("resolveActionWorkflow with a krea2 default pack (no i2v)", () => {
  it("animate resolves to LTX-2.5 i2v instead of krea2 t2i", async () => {
    vi.resetModules();
    vi.stubEnv("CJ_DEFAULT_PACK", "krea2");
    try {
      const packs = await import("@/lib/oj/packs");
      expect(packs.getDefaultPack().id).toBe("krea2");
      expect(packs.getDefaultPack().workflows.i2v).toBeUndefined();
      const r = packs.resolveActionWorkflow(
        { templateOrAction: "animate_low", template: "i2v" },
        [undefined, "ltx25"],
      );
      expect(r.workflowPath).toBe("packs/ltx25/i2v.json");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
