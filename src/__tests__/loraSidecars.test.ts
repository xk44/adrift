import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findLoraPreview,
  parseLoraSidecar,
  readLoraSidecars,
} from "@/lib/characters/loraSidecars";

describe("parseLoraSidecar", () => {
  it("reads LoRA Manager .metadata.json", () => {
    const info = parseLoraSidecar({
      model_name: "Alice",
      tags: ["character", "anime"],
      base_model: "Illustrious",
      civitai: { trainedWords: ["alicetrig"], model: { tags: ["girl"] } },
    });
    expect(info.modelName).toBe("Alice");
    expect(info.tags).toEqual(["character", "anime", "girl"]);
    expect(info.baseModel).toBe("Illustrious");
    expect(info.triggers).toEqual(["alicetrig"]);
  });

  it("reads Civitai Helper .civitai.info (model.type Character)", () => {
    const info = parseLoraSidecar({
      baseModel: "SDXL 1.0",
      trainedWords: ["bob"],
      model: { name: "Bob", type: "Character", tags: [{ name: "game" }] },
    });
    expect(info.modelName).toBe("Bob");
    expect(info.tags).toEqual(["game", "character"]);
    expect(info.baseModel).toBe("SDXL 1.0");
    expect(info.triggers).toEqual(["bob"]);
  });

  it("reads A1111 user metadata .json", () => {
    const info = parseLoraSidecar({
      "activation text": "ohwx, man",
      "preferred weight": "0.8",
      "sd version": "SDXL",
    });
    expect(info.triggers).toEqual(["ohwx", "man"]);
    expect(info.preferredWeight).toBe(0.8);
    expect(info.baseModel).toBe("SDXL");
  });

  it("garbage gives empty info, text is capped and cleaned", () => {
    expect(parseLoraSidecar("nope").tags).toEqual([]);
    const info = parseLoraSidecar({ model_name: "a\u0000b" + "x".repeat(500) });
    expect(info.modelName!.length).toBeLessThanOrEqual(120);
    expect(info.modelName).not.toContain("\u0000");
  });
});

describe("readLoraSidecars / findLoraPreview (tmp folder)", () => {
  let root: string;
  let outside: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-loras-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-outside-"));
    fs.mkdirSync(path.join(root, "chars"));
    fs.writeFileSync(path.join(root, "chars", "alice.safetensors"), "");
    fs.writeFileSync(
      path.join(root, "chars", "alice.metadata.json"),
      JSON.stringify({ tags: ["character"], base_model: "SDXL" }),
    );
    fs.writeFileSync(path.join(root, "chars", "alice.preview.png"), "png");
    fs.writeFileSync(path.join(root, "plain.safetensors"), "");
    fs.writeFileSync(path.join(root, "huge.safetensors"), "");
    fs.writeFileSync(path.join(root, "huge.json"), "x".repeat(600 * 1024));
    fs.writeFileSync(path.join(outside, "secret.png"), "nope");
    fs.writeFileSync(path.join(root, "linked.safetensors"), "");
    fs.symlinkSync(path.join(outside, "secret.png"), path.join(root, "linked.png"));
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("enriches files that have sidecars and flags previews", async () => {
    const out = await readLoraSidecars(root, [
      "chars/alice.safetensors",
      "plain.safetensors",
      "huge.safetensors",
      "../escape.safetensors",
    ]);
    expect(out[0]).toMatchObject({
      filename: "chars/alice.safetensors",
      tags: ["character"],
      baseModel: "SDXL",
      hasPreview: true,
    });
    expect(out[1]).toEqual({ filename: "plain.safetensors", hasPreview: false });
    expect(out[2].tags).toBeUndefined(); // oversized sidecar ignored
    expect(out[3]).toEqual({ filename: "../escape.safetensors", hasPreview: false });
  });

  it("missing folder: plain list, never throws", async () => {
    expect(await readLoraSidecars(path.join(root, "nope"), ["a.safetensors"])).toEqual([
      { filename: "a.safetensors" },
    ]);
  });

  it("serves previews only from inside the LoRA folder", async () => {
    expect(await findLoraPreview(root, "chars/alice.safetensors")).toMatchObject({
      contentType: "image/png",
    });
    expect(await findLoraPreview(root, "plain.safetensors")).toBeNull();
    expect(await findLoraPreview(root, "linked.safetensors")).toBeNull();
    expect(await findLoraPreview(root, "../x.safetensors")).toBeNull();
  });
});
