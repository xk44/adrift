import { describe, expect, it } from "vitest";
import {
  canUseInCreate,
  slotsAssignedTo,
  slotsForPackKey,
} from "@/lib/packWorkflowActions";

describe("pack workflow actions", () => {
  it("offers only slots whose kind matches the pack workflow", () => {
    const vary = slotsForPackKey("vary_subtle").map((s) => s.id);
    expect(vary).toContain("single.vary_subtle");
    expect(vary).toContain("single.remix_strong");
    expect(vary).not.toContain("expand.animate_low");
    expect(vary).not.toContain("promptbar.imagine");

    const i2v = slotsForPackKey("i2v").map((s) => s.id);
    expect(i2v).toEqual(
      expect.arrayContaining(["expand.animate_low", "expand.animate_high"]),
    );
    expect(i2v.every((id) => id.startsWith("expand."))).toBe(true);

    expect(slotsForPackKey("make_3d_trellis").map((s) => s.id)).toEqual([
      "expand.make_3d",
    ]);
  });

  it("offers nothing for unmapped pack keys", () => {
    expect(slotsForPackKey("controlnet_depth")).toEqual([]);
  });

  it("allows Use in Create only for text-to-image graphs", () => {
    expect(canUseInCreate("t2i")).toBe(true);
    expect(canUseInCreate("t2i_fast")).toBe(true);
    expect(canUseInCreate("i2i")).toBe(false);
    expect(canUseInCreate("t2v")).toBe(false);
  });

  it("reports which slots already use a graph file", () => {
    const slots = slotsForPackKey("upscale_subtle");
    const ids = slotsAssignedTo(
      {
        "single.upscale_subtle": { workflowPath: "packs/krea2/upscale.json" },
        "single.upscale_creative": { workflowPath: "saved:other.json" },
      },
      "packs/krea2/upscale.json",
      slots,
    );
    expect(ids).toEqual(["single.upscale_subtle"]);
  });
});
