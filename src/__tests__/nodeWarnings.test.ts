import { describe, it, expect } from "vitest";
import { nodeWarningsOf } from "@/lib/comfy/nodeWarnings";

describe("nodeWarningsOf", () => {
  it("extracts warnings.nodes strings from a job-route response", () => {
    expect(
      nodeWarningsOf({ ok: true, warnings: { nodes: ["a", "", 3, "b"] } }),
    ).toEqual(["a", "b"]);
  });

  it("is empty for responses without node warnings", () => {
    expect(nodeWarningsOf(null)).toEqual([]);
    expect(nodeWarningsOf({ ok: true })).toEqual([]);
    expect(nodeWarningsOf({ warnings: { unknownFlags: ["--x"] } })).toEqual([]);
    expect(nodeWarningsOf({ warnings: { nodes: "nope" } })).toEqual([]);
  });
});
