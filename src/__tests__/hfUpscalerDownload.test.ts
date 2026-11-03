/**
 * HF upscaler detection, the super-resolution filter, and /api/hf/download.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const h = vi.hoisted(() => ({ root: "" }));
vi.mock("@/lib/env", () => ({
  env: {
    get COMFY_ROOT() {
      return h.root;
    },
  },
}));
vi.mock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
vi.mock("@/lib/wildcardsFs", () => ({ wildcardRoot: () => h.root }));

import { GET, POST } from "@/app/api/hf/download/route";
import {
  isHfUpscalerFile,
  isHfUpscalerRepo,
  suggestedUpscaleFolder,
} from "@/lib/hfUpscalers";
import { hfTaskLabel, parseHfModelsRequest } from "@/lib/hfModels";

const REPO = "Kim2091/UltraSharp";
const REV = "920fe218c211f831b43cb30327f203e2b59f5dab";
const BYTES = new Uint8Array([7, 7, 7, 7]);
const SHA = createHash("sha256").update(BYTES).digest("hex");

function hubInfo(overrides: Record<string, unknown> = {}) {
  return {
    id: REPO,
    sha: REV,
    gated: false,
    private: false,
    tags: ["pytorch", "super-resolution", "image-to-image"],
    siblings: [
      { rfilename: ".gitattributes", size: 10 },
      {
        rfilename: "4x-UltraSharp.safetensors",
        size: BYTES.byteLength,
        lfs: { sha256: SHA, size: BYTES.byteLength },
      },
      {
        rfilename: "4x-UltraSharp.pth",
        size: BYTES.byteLength,
        lfs: { sha256: SHA, size: BYTES.byteLength },
      },
      { rfilename: "NCNN/4x-UltraSharp.bin", size: 4 },
      { rfilename: "NCNN/4x-UltraSharp.safetensors", size: 4 },
    ],
    ...overrides,
  };
}

let fetchMock: Mock;
let info: Record<string, unknown>;
let fileBytes: Uint8Array<ArrayBuffer>;

beforeEach(() => {
  h.root = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-hf-"));
  info = hubInfo();
  fileBytes = BYTES;
  fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.startsWith("https://huggingface.co/api/models/")) {
      return new Response(JSON.stringify(info), { status: 200 });
    }
    if (url.includes("/resolve/")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://cas-bridge.xethub.hf.co/blob" },
      });
    }
    if (url.startsWith("https://cas-bridge.xethub.hf.co/")) {
      return new Response(fileBytes, { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(h.root, { recursive: true, force: true });
});

const post = (body: Record<string, unknown>) =>
  POST(
    new NextRequest("http://localhost/api/hf/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
const base = {
  repo: REPO,
  file: "4x-UltraSharp.safetensors",
  revision: REV,
  folder: "upscale_models",
};
const upscaleDir = () =>
  path.join(fs.realpathSync(h.root), "models", "upscale_models");

describe("upscaler detection", () => {
  it("recognises upscaler repos by tag or name", () => {
    expect(isHfUpscalerRepo({ id: REPO, tags: ["super-resolution"] })).toBe(
      true,
    );
    expect(isHfUpscalerRepo({ id: "x/RealESRGAN_x4plus", tags: [] })).toBe(
      true,
    );
    expect(isHfUpscalerRepo({ id: "x/4x_NMKD-Siax", tags: [] })).toBe(true);
    expect(isHfUpscalerRepo({ id: "x/sdxl-base", tags: [] })).toBe(false);
  });

  it("skips ControlNet / LoRA / diffusers repos tagged super-resolution", () => {
    for (const tag of [
      "controlnet",
      "ControlNet",
      "lora",
      "ic-lora",
      "diffusers",
      "transformers",
    ]) {
      const repo = {
        id: "x/Flux-Controlnet-Upscaler",
        tags: ["super-resolution", tag],
      };
      expect(isHfUpscalerRepo(repo)).toBe(false);
      expect(isHfUpscalerFile(repo, "model.safetensors")).toBe(false);
    }
  });

  it("only offers loadable files", () => {
    const repo = { id: REPO, tags: ["super-resolution"] };
    expect(isHfUpscalerFile(repo, "4x-UltraSharp.pth")).toBe(true);
    expect(isHfUpscalerFile(repo, "NCNN/4x-UltraSharp.safetensors")).toBe(
      false,
    );
    expect(isHfUpscalerFile(repo, "x.bin")).toBe(false);
    expect(isHfUpscalerFile(repo, "x.onnx")).toBe(false);
    // Non-upscaler repo, but the file name says upscaler.
    expect(
      isHfUpscalerFile({ id: "a/misc", tags: [] }, "RealESRGAN_x2.pth"),
    ).toBe(true);
    expect(
      isHfUpscalerFile({ id: "a/misc", tags: [] }, "unet.safetensors"),
    ).toBe(false);
  });

  it("suggests latent_upscale_models for latent upscalers", () => {
    expect(
      suggestedUpscaleFolder("ltx-2-spatial-upscaler-x2.safetensors"),
    ).toBe("latent_upscale_models");
    expect(suggestedUpscaleFolder("m.safetensors", ["latent-upscaler"])).toBe(
      "latent_upscale_models",
    );
    expect(suggestedUpscaleFolder("4x-UltraSharp.pth")).toBe("upscale_models");
  });
});

describe("super-resolution filter", () => {
  it("is sent as a tag filter, not a pipeline_tag", () => {
    const r = parseHfModelsRequest(
      new URLSearchParams("pipeline_tag=super-resolution"),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.upstream.get("pipeline_tag")).toBeNull();
    expect(r.upstream.getAll("filter")).toContain("super-resolution");
    expect(hfTaskLabel("super-resolution")).toBe(
      "Upscalers (super-resolution)",
    );
  });
});

describe("GET /api/hf/download", () => {
  it("lists loadable upscaler files pinned to the commit", async () => {
    const res = await GET(
      new NextRequest(`http://localhost/api/hf/download?repo=${REPO}`),
    );
    const data = await res.json();
    expect(data.revision).toBe(REV);
    expect(data.files.map((f: { file: string }) => f.file)).toEqual([
      "4x-UltraSharp.safetensors",
      "4x-UltraSharp.pth",
    ]);
    expect(data.files[1].pickle).toBe(true);
  });

  it("rejects malformed repos", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/hf/download?repo=../x"),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/hf/download", () => {
  it("downloads via the HF CDN and verifies the checksum", async () => {
    const res = await post(base);
    expect(res.status).toBe(200);
    expect(
      fs.readFileSync(path.join(upscaleDir(), "4x-UltraSharp.safetensors")),
    ).toEqual(Buffer.from(BYTES));
    const resolveCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/resolve/"),
    );
    expect(String(resolveCall?.[0])).toBe(
      `https://huggingface.co/${REPO}/resolve/${REV}/4x-UltraSharp.safetensors`,
    );
  });

  it("refuses folders other than the upscaler folders", async () => {
    for (const folder of ["loras", "checkpoints", "../x", "ultralytics/bbox"]) {
      expect((await post({ ...base, folder })).status).toBe(400);
    }
  });

  it("accepts latent_upscale_models", async () => {
    expect(
      (await post({ ...base, folder: "latent_upscale_models" })).status,
    ).toBe(200);
  });

  it("rejects bad revisions, files not in the repo and traversal", async () => {
    expect((await post({ ...base, revision: "main" })).status).toBe(400);
    expect((await post({ ...base, file: "other.safetensors" })).status).toBe(
      400,
    );
    expect(
      (await post({ ...base, file: "../../etc/x.safetensors" })).status,
    ).toBe(400);
  });

  it("refuses non-upscaler files and repos", async () => {
    info = hubInfo({ tags: ["super-resolution", "controlnet"] });
    expect((await post(base)).status).toBe(400);
    info = hubInfo();
    expect(
      (await post({ ...base, file: "NCNN/4x-UltraSharp.safetensors" })).status,
    ).toBe(400);
  });

  it("refuses gated repos", async () => {
    info = hubInfo({ gated: "auto" });
    const res = await post(base);
    expect(res.status).toBe(403);
    expect((await res.json()).gated).toBe(true);
  });

  it("asks before downloading a pickle file", async () => {
    const first = await post({ ...base, file: "4x-UltraSharp.pth" });
    expect(first.status).toBe(409);
    expect((await first.json()).needsPickleAck).toBe(true);
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("/resolve/")),
    ).toBe(false);
    const ok = await post({
      ...base,
      file: "4x-UltraSharp.pth",
      acceptPickle: true,
    });
    expect(ok.status).toBe(200);
  });

  it("fails on a checksum mismatch and leaves nothing behind", async () => {
    fileBytes = new Uint8Array([1, 2, 3, 4]);
    const res = await post(base);
    expect(res.status).toBe(502);
    expect(fs.readdirSync(upscaleDir())).toEqual([]);
  });

  it("never silently overwrites a different file", async () => {
    fs.mkdirSync(upscaleDir(), { recursive: true });
    fs.writeFileSync(
      path.join(upscaleDir(), "4x-UltraSharp.safetensors"),
      "older-and-bigger",
    );
    const res = await post(base);
    expect(res.status).toBe(409);
    expect((await res.json()).conflict).toBe(true);
    expect((await post({ ...base, overwrite: true })).status).toBe(200);
  });

  it("skips a file that is already there with the same size", async () => {
    fs.mkdirSync(upscaleDir(), { recursive: true });
    fs.writeFileSync(
      path.join(upscaleDir(), "4x-UltraSharp.safetensors"),
      Buffer.from(BYTES),
    );
    const data = await (await post(base)).json();
    expect(data.skipped).toBe(true);
  });

  it("refuses a symlink at the final path in upscale_models", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-hf-out-"));
    try {
      const dir = path.join(h.root, "models", "upscale_models");
      fs.mkdirSync(dir, { recursive: true });
      fs.symlinkSync(path.join(outside, "victim"), path.join(dir, base.file));
      const res = await post({ ...base, overwrite: true });
      expect(res.status).toBe(400);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses redirects off Hugging Face", async () => {
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith("https://huggingface.co/api/"))
        return new Response(JSON.stringify(info), { status: 200 });
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/x" },
      });
    });
    expect((await post(base)).status).toBe(502);
  });
});
