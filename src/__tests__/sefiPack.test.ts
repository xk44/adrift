/**
 * SeFi-Image pack: resolution, api-prompt-node slot discovery, param injection.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { resolveWorkflow } from "@/lib/oj/packs";
import { discoverT2ISlots } from "@/lib/oj/discovery";
import { injectParams } from "@/lib/oj/engine";
import type { Workflow } from "@/types";

const sefiWorkflow = (): Workflow =>
  JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "public/workflows/packs/sefi/t2i.json"),
      "utf-8",
    ),
  );

describe("sefi pack", () => {
  it("t2i resolves for sefi checkpoints", () => {
    const r = resolveWorkflow({
      templateOrAction: "t2i",
      checkpointName: "SeFi-Image-1B-turbo",
    });
    expect(r.workflowPath).toBe("packs/sefi/t2i.json");
    expect(r.pack?.id).toBe("sefi");
  });

  it("SeFiGenerate is discovered as the api prompt node", () => {
    const slots = discoverT2ISlots(sefiWorkflow());
    expect(slots.apiPromptNodeId).toBe("2");
    expect(slots.posTextInputName).toBe("prompt");
  });

  it("prompt/seed/ar inject onto the generate node", () => {
    const wf = sefiWorkflow();
    const slots = discoverT2ISlots(wf);
    injectParams(wf, slots, { ar: "16:9" }, "a lighthouse", "", 77);
    const inputs = wf["2"].inputs as Record<string, unknown>;
    expect(inputs.prompt).toBe("a lighthouse");
    expect(inputs.seed).toBe(77);
    expect((inputs.width as number) > (inputs.height as number)).toBe(true);
    expect((inputs.width as number) % 16).toBe(0);
    // steps/guidance untouched (node owns them; turbo contract)
    expect(inputs.steps).toBe(4);
    expect(inputs.guidance).toBe(1.0);
    // no junk model.* field leaked
    expect(inputs["model.aspect_ratio"]).toBeUndefined();
  });
});
