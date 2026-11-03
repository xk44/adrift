/**
 * modelListing: one entry per file, stable order, folder aliases
 * (unet/diffusion_models, clip/text_encoders) fetched once and merged on disk.
 * comfyFetch and env are mocked; disk tests use a temp ComfyUI tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const h = vi.hoisted(() => ({
  url: "http://127.0.0.1:8188",
  root: "",
  answers: {} as Record<string, unknown>,
  requested: [] as string[],
}));

vi.mock("@/lib/env", () => ({
  env: {
    get COMFY_HTTP_URL() {
      return h.url;
    },
    get COMFY_ROOT() {
      return h.root;
    },
  },
}));

vi.mock("@/lib/comfy/comfyFetch", () => ({
  comfyFetch: vi.fn(async (p: string) => {
    h.requested.push(p);
    const folder = decodeURIComponent(p.replace(/^\/models\//, ""));
    if (!(folder in h.answers)) return new Response("no", { status: 404 });
    return Response.json(h.answers[folder]);
  }),
}));

import {
  canonicalFolder,
  dedupeListing,
  modelListing,
  modelListings,
} from "@/lib/tools/modelListing";

beforeEach(() => {
  h.root = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-listing-"));
  h.answers = {};
  h.requested = [];
  h.url = "http://127.0.0.1:8188";
});

afterEach(() => {
  fs.rmSync(h.root, { recursive: true, force: true });
});

function touch(rel: string) {
  const p = path.join(h.root, "models", rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "x");
}

describe("dedupeListing", () => {
  it("collapses case, separator, ./ and doubled-slash variants into one entry", () => {
    const out = dedupeListing([
      "Flux\\Model.safetensors",
      "flux/model.safetensors",
      "./flux//MODEL.safetensors",
      "/flux/model.safetensors",
      "a.gguf",
      "A.GGUF",
    ]);
    expect([...out]).toEqual(["a.gguf", "flux/model.safetensors"]);
  });

  it("order is stable whatever order the roots answered in", () => {
    const one = ["z.safetensors", "sub/b.safetensors", "a.safetensors"];
    const two = [...one].reverse().concat(["A.safetensors"]);
    expect([...dedupeListing(one)]).toEqual([...dedupeListing(two)]);
    expect([...dedupeListing(one)]).toEqual([
      "a.safetensors",
      "sub/b.safetensors",
      "z.safetensors",
    ]);
  });

  it("drops empty and non-string entries", () => {
    const raw = ["", "./", "ok.safetensors", 3 as unknown as string];
    expect([...dedupeListing(raw)]).toEqual(["ok.safetensors"]);
  });
});

describe("modelListing (remote)", () => {
  it("dedupes duplicates ComfyUI reports from extra_model_paths roots", async () => {
    h.answers.loras = [
      "Style.safetensors",
      "style.safetensors",
      "x\\y.safetensors",
      "x/y.safetensors",
    ];
    const got = await modelListing("loras");
    expect([...got!]).toEqual(["style.safetensors", "x/y.safetensors"]);
  });

  it("legacy names ask ComfyUI for the current folder first", async () => {
    h.answers.diffusion_models = ["m.gguf"];
    expect([...(await modelListing("unet"))!]).toEqual(["m.gguf"]);
    expect(h.requested).toEqual(["/models/diffusion_models"]);
  });

  it("falls back to the legacy name on an older ComfyUI", async () => {
    h.answers.unet = ["old.safetensors"];
    expect([...(await modelListing("diffusion_models"))!]).toEqual([
      "old.safetensors",
    ]);
    expect(h.requested).toEqual(["/models/diffusion_models", "/models/unet"]);
  });

  it("an erroring ComfyUI is not asked again under the legacy name", async () => {
    h.url = "http://192.0.2.10:8188";
    const { comfyFetch } = await import("@/lib/comfy/comfyFetch");
    vi.mocked(comfyFetch).mockImplementationOnce(async (p) => {
      h.requested.push(String(p));
      return new Response("err", { status: 500 });
    });
    expect(await modelListing("diffusion_models")).toBeNull();
    expect(h.requested).toEqual(["/models/diffusion_models"]);
  });

  it("modelListings: aliases share one fetch and the same Set", async () => {
    h.answers.diffusion_models = ["m.gguf"];
    h.answers.text_encoders = ["t5.safetensors"];
    const out = await modelListings([
      "unet",
      "diffusion_models",
      "clip",
      "text_encoders",
      "unet",
    ]);
    expect(Object.keys(out)).toEqual([
      "unet",
      "diffusion_models",
      "clip",
      "text_encoders",
    ]);
    expect(out.unet).toBe(out.diffusion_models);
    expect(out.clip).toBe(out.text_encoders);
    expect(h.requested.sort()).toEqual([
      "/models/diffusion_models",
      "/models/text_encoders",
    ]);
  });

  it("canonicalFolder", () => {
    expect(canonicalFolder("unet")).toBe("diffusion_models");
    expect(canonicalFolder("clip")).toBe("text_encoders");
    expect(canonicalFolder("loras")).toBe("loras");
  });
});

describe("modelListing (disk fallback, local ComfyUI)", () => {
  it("merges models/unet and models/diffusion_models, one entry per file", async () => {
    touch("unet/shared.safetensors");
    touch("diffusion_models/shared.safetensors");
    touch("diffusion_models/only-new.safetensors");
    touch("unet/sub/only-old.gguf");
    const got = await modelListing("diffusion_models");
    expect([...got!]).toEqual([
      "only-new.safetensors",
      "shared.safetensors",
      "sub/only-old.gguf",
    ]);
  });

  it("empty set when models/ exists but the folder doesn't; null without models/", async () => {
    fs.mkdirSync(path.join(h.root, "models"));
    expect((await modelListing("loras"))?.size).toBe(0);
    fs.rmSync(path.join(h.root, "models"), { recursive: true });
    expect(await modelListing("loras")).toBeNull();
  });

  it("never reads this disk for a remote ComfyUI", async () => {
    h.url = "http://192.0.2.30:8188";
    touch("loras/here.safetensors");
    expect(await modelListing("loras")).toBeNull();
  });
});
