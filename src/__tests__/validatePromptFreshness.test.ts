import { describe, it, expect, vi, afterEach } from "vitest";
import {
  validatePrompt,
  PromptValidationError,
} from "@/lib/comfy/validatePrompt";
import {
  assertPromptValid,
  clearObjectInfoCache,
} from "@/lib/comfy/objectInfoCache";

const info = (models: string[], images: string[]) => ({
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [models] } },
    output: ["MODEL", "CLIP", "VAE"],
  },
  LoadImage: {
    input: { required: { image: [images, { image_upload: true }] } },
    output: ["IMAGE", "MASK"],
  },
});

const prompt = (ckpt: string, image: string) => ({
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } },
  "2": { class_type: "LoadImage", inputs: { image } },
});

function mockFetchSequence(...bodies: unknown[]) {
  const fn = vi.fn();
  for (const b of bodies)
    fn.mockResolvedValueOnce(new Response(JSON.stringify(b)));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearObjectInfoCache();
});

describe("upload combos", () => {
  it("never flags a just-uploaded image missing from the snapshot", () => {
    const p = prompt("a.safetensors", "upload-123.png");
    expect(validatePrompt(p, info(["a.safetensors"], ["old.png"]))).toEqual([]);
  });

  it("still flags a missing model file", () => {
    const p = prompt("missing.safetensors", "x.png");
    const probs = validatePrompt(p, info(["a.safetensors"], []));
    expect(probs.map((x) => x.kind)).toEqual(["invalid_combo_value"]);
  });
});

describe("assertPromptValid freshness", () => {
  const base = "http://comfy.test";

  it("re-fetches before rejecting: a model installed after caching passes", async () => {
    const fetch = mockFetchSequence(
      info(["a.safetensors"], []), // warms cache
      info(["a.safetensors", "new.safetensors"], []), // fresh re-check
    );
    await assertPromptValid(prompt("a.safetensors", "x.png"), base);
    await expect(
      assertPromptValid(prompt("new.safetensors", "x.png"), base),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects when the fresh snapshot still lacks the file", async () => {
    mockFetchSequence(info(["a.safetensors"], []), info(["a.safetensors"], []));
    await expect(
      assertPromptValid(prompt("nope.safetensors", "x.png"), base),
    ).rejects.toBeInstanceOf(PromptValidationError);
  });

  it("fails open when the refresh can't reach ComfyUI", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(info(["a.safetensors"], []))),
      )
      .mockRejectedValueOnce(new Error("down"));
    vi.stubGlobal("fetch", fn);
    await expect(
      assertPromptValid(prompt("nope.safetensors", "x.png"), base),
    ).resolves.toBeUndefined();
  });
});
