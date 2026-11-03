import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ImageAttachment, Workflow } from "@/types";
import {
  H3_MAX_REF_IMAGES,
  videoRefAttachments,
  wireVideoRefImages,
} from "@/lib/oj/videoRefImages";

const pack = (rel: string): Workflow =>
  JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "public/workflows", rel), "utf8"),
  );

const att = (id: string, mode: ImageAttachment["mode"]): ImageAttachment => ({
  id,
  url: `data:image/png;base64,${id}`,
  mode,
  weight: 1,
});

describe("videoRefAttachments", () => {
  const list = [
    att("a", "style_ref"),
    att("b", "image_prompt"),
    att("c", "starting_frame"),
    att("d", "image_prompt"),
    att("e", "image_prompt"),
    att("f", "image_prompt"),
  ];

  it("r2v takes image prompts in order, capped", () => {
    expect(videoRefAttachments("r2v", list).map((a) => a.id)).toEqual(
      ["b", "d", "e", "f"].slice(0, H3_MAX_REF_IMAGES),
    );
  });

  it("i2v prefers the starting frame, else the first image prompt", () => {
    expect(videoRefAttachments("i2v", list).map((a) => a.id)).toEqual(["c"]);
    expect(
      videoRefAttachments("i2v", [att("x", "image_prompt")]).map((a) => a.id),
    ).toEqual(["x"]);
  });

  it("t2v and no attachments take nothing", () => {
    expect(videoRefAttachments("t2v", list)).toEqual([]);
    expect(videoRefAttachments("r2v", undefined)).toEqual([]);
  });
});

describe("wireVideoRefImages", () => {
  it("H3 r2v: first ref fills node 15, extras get LoadImage + ref_image_n", () => {
    const wf = pack("packs/minimax/r2v.json");
    const ids = wireVideoRefImages(wf, ["mara.png", "pip.png", "market.png"]);
    expect(ids).toHaveLength(3);
    expect(wf["15"].inputs.image).toBe("mara.png");
    const r2v = Object.values(wf).find(
      (n) => n.class_type === "MiniMaxH3ReferenceToVideo",
    )!;
    expect(r2v.inputs["ref_images.ref_image_0"]).toEqual(["15", 0]);
    for (const [i, name] of ["pip.png", "market.png"].entries()) {
      const link = r2v.inputs[`ref_images.ref_image_${i + 1}`] as [
        string,
        number,
      ];
      expect(wf[link[0]].class_type).toBe("LoadImage");
      expect(wf[link[0]].inputs.image).toBe(name);
    }
  });

  it("i2v graphs: the empty LoadImage gets the frame", () => {
    for (const rel of [
      "packs/minimax/i2v.json",
      "packs/ltx25/i2v.json",
      "packs/wan/i2v.json",
    ]) {
      const wf = pack(rel);
      const [id] = wireVideoRefImages(wf, ["frame.png"]);
      expect(wf[id].class_type).toBe("LoadImage");
      expect(wf[id].inputs.image).toBe("frame.png");
    }
  });

  it("no refs leaves the graph untouched", () => {
    const wf = pack("packs/minimax/r2v.json");
    const before = JSON.stringify(wf);
    expect(wireVideoRefImages(wf, [])).toEqual([]);
    expect(JSON.stringify(wf)).toBe(before);
  });
});
