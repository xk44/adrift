import { describe, expect, it } from "vitest";

import {
  resolveMissingNodePacks,
  summarizeInstallCandidates,
} from "@/lib/comfy/manager";

describe("ComfyUI Manager missing node resolution", () => {
  it("maps missing node types to ComfyUI Manager pack candidates", () => {
    const reports = resolveMissingNodePacks(
      ["ImageResizeKJv2", "CM_FloatToInt", "TotallyUnknownNode"],
      {
        "comfyui-kjnodes": [["ImageResizeKJv2", "ImageBatchMulti"]],
        "https://github.com/aining2022/ComfyUI_Swwan": [["ImageResizeKJv2"]],
        ComfyMath: [["CM_FloatToInt"]],
      },
    );

    expect(reports[0].candidates.map((candidate) => candidate.id)).toEqual([
      "comfyui-kjnodes",
      "https://github.com/aining2022/ComfyUI_Swwan",
    ]);
    expect(reports[1].candidates).toEqual([
      { id: "ComfyMath", label: "ComfyMath", source: "cnr" },
    ]);
    expect(reports[2].candidates).toEqual([]);
  });

  it("only auto-queues unambiguous missing node packs", () => {
    const summary = summarizeInstallCandidates([
      {
        nodeType: "AmbiguousNode",
        candidates: [
          { id: "pack-a", label: "pack-a", source: "cnr" },
          { id: "pack-b", label: "pack-b", source: "cnr" },
        ],
      },
      {
        nodeType: "KnownNode",
        candidates: [{ id: "known-pack", label: "known-pack", source: "cnr" }],
      },
      { nodeType: "UnknownNode", candidates: [] },
    ]);

    expect(summary.unambiguousInstallPackIds).toEqual(["known-pack"]);
    expect(summary.ambiguousNodeTypes).toEqual(["AmbiguousNode"]);
    expect(summary.unresolvedNodeTypes).toEqual(["UnknownNode"]);
  });
});
