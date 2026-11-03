import path from "path";
import { describe, expect, it } from "vitest";
import { loadWorkflowFromSelection, parseWorkflowJson, stripWorkflowMetaKeys } from "@/lib/comfy/workflows";

const WF = (rel: string) => path.join(process.cwd(), "public", "workflows", rel);

describe("pack workflow metadata keys", () => {
  it("stripWorkflowMetaKeys keeps only nodes", () => {
    const wf = stripWorkflowMetaKeys({
      _meta: { title: "x" },
      _comment: "y",
      "1": { class_type: "KSampler", inputs: {} },
    } as Record<string, unknown>);
    expect(Object.keys(wf)).toEqual(["1"]);
  });

  it("parseWorkflowJson treats a _meta-first pack file as API format and drops the key", () => {
    const wf = parseWorkflowJson({ _meta: { title: "t" }, "1": { class_type: "KSampler", inputs: {} } });
    expect(Object.keys(wf)).toEqual(["1"]);
  });

  it.each(["packs/moss-image/t2i.json", "packs/qwen-image-21/t2i.json", "packs/flux3/t2i.json", "packs/moss-image/i2i.json"])(
    "%s loads with no non-node entries",
    async (rel) => {
      const wf = await loadWorkflowFromSelection(WF(rel));
      expect(Object.keys(wf).length).toBeGreaterThan(3);
      for (const [id, n] of Object.entries(wf)) {
        expect(typeof n.class_type, id).toBe("string");
        expect(n.inputs, id).toBeTypeOf("object");
      }
    },
  );
});
