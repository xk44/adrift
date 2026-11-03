import { describe, expect, it } from "vitest";
import { EDIT_ENGINES, SINGLE_ENGINES, preferredEngine } from "@/lib/tools/templates";
import { nextFrameEngineIds } from "@/lib/tools/storyboard";

const list = (ids: string[]) => ids.map((id) => EDIT_ENGINES[id as keyof typeof EDIT_ENGINES]);

describe("preferredEngine", () => {
  it("skips a non-commercial generic engine when a commercial one is installed", () => {
    expect(preferredEngine(list(SINGLE_ENGINES))?.id).toBe("qwen2511");
    expect(preferredEngine(list(["krea2", "flux3"]))?.id).toBe("flux3");
  });

  it("falls back to the first engine when all are non-commercial", () => {
    expect(preferredEngine(list(["krea2", "fibo2"]))?.id).toBe("krea2");
  });

  it("keeps a purpose-built specialist listed first", () => {
    expect(preferredEngine(list(nextFrameEngineIds(false)))?.id).toBe("qwen21-next-scene");
    expect(preferredEngine(list(["qwen21-realism", "qwen2511"]))?.id).toBe("qwen21-realism");
  });

  it("returns null for an empty list", () => {
    expect(preferredEngine([])).toBeNull();
  });
});
