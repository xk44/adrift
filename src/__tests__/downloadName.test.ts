import { describe, expect, it } from "vitest";
import { mediaDownloadName, sidecarDownloadName } from "@/lib/output/downloadName";

describe("gallery download names", () => {
  const img = { id: "abc", seed: 99, jobIndex: 0, paramsMap: { tool_id: "relight" } };

  it("uses the real extension and job index", () => {
    expect(mediaDownloadName(img, "/api/comfy/image?filename=x.jpg", ".png")).toBe(
      "Adrift_relight_99_v1.jpg",
    );
    expect(mediaDownloadName({ ...img, jobIndex: 3 }, undefined, ".png")).toBe(
      "Adrift_relight_99_v4.png",
    );
  });

  it("falls back to the id when the seed is missing", () => {
    expect(mediaDownloadName({ id: "Run 7", seed: NaN }, "/a", ".glb")).toBe(
      "Adrift_create_run-7_v1.glb",
    );
  });

  it("names sidecars with the same stem", () => {
    expect(sidecarDownloadName(img, "metadata.json")).toBe("Adrift_relight_99_v1_metadata.json");
  });
});
