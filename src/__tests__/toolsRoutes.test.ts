import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const tmpRoot = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return mkdtempSync(require("path").join(require("os").tmpdir(), "cj-tools-")) as string;
});
const WF_DIR = path.join(process.cwd(), "public", "workflows");

const { queuePrompt, fetchImage, uploadImageToComfy } = vi.hoisted(() => ({
  queuePrompt: vi.fn(),
  fetchImage: vi.fn(),
  uploadImageToComfy: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ env: { COMFY_ROOT: tmpRoot, ADMIN_API_KEY: "" } }));
vi.mock("@/lib/auth", () => ({ requireAdmin: () => ({ ok: true }) }));
vi.mock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
vi.mock("@/lib/db", () => ({
  insertJob: vi.fn(),
  insertPrompt: vi.fn(),
  insertRun: vi.fn(),
}));
vi.mock("@/lib/comfy/http", () => ({
  ComfyAPIError: class ComfyAPIError extends Error {},
  comfyErrorDetails: () => ({ code: "comfy_error" }),
  queuePrompt: (...a: unknown[]) => queuePrompt(...a),
  fetchImage: (...a: unknown[]) => fetchImage(...a),
  uploadImageToComfy: (...a: unknown[]) => uploadImageToComfy(...a),
}));

import { GET } from "@/app/api/tools/route";
import { POST } from "@/app/api/jobs/tool/route";
import { getEditTools, allToolLoraFiles } from "@/lib/tools/editTools";
import { addActiveRun } from "@/lib/comfy/runs";
import type { ImagineRun } from "@/types";

function touch(rel: string) {
  const p = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "x");
}

function installAllLoras() {
  for (const t of getEditTools())
    for (const f of allToolLoraFiles(t)) touch(path.join("models", "loras", f));
}

function installBaseWeights() {
  const dirs = ["qwen-image-21/edit.json", "flux3/edit_fast.json", "krea2-edit/edit_v2.json", "krea2-edit/edit_ostris.json", "qwen-image-edit/edit.json", "flux3/edit.json", "moss-image/restyle_depth.json", "krea2/control_depth.json", "krea2/control_regions.json", "krea2-edit/swap_head.json", "krea2-edit/swap_body.json", "krea2/outpaintv2.json", "krea2/anypaint.json", "moss-image/charref.json", "moss-image/colorize.json"];
  for (const d of dirs) {
    const wf = JSON.parse(fs.readFileSync(path.join(WF_DIR, "packs", d), "utf8"));
    for (const n of Object.values<{ class_type?: string; inputs?: Record<string, unknown> }>(wf)) {
      if (n?.class_type === "UNETLoader") touch(path.join("models", "diffusion_models", String(n.inputs?.unet_name)));
      if (n?.class_type === "MOSSImageLoader") touch(path.join("models", "diffusion_models", String(n.inputs?.dit)));
    }
  }
  for (const f of ["depth_anything_3_base.safetensors", "depth_anything_3_mono_large.safetensors"]) {
    touch(path.join("models", "geometry_estimation", f));
  }
  touch(path.join("models", "loras", "krea2-control.safetensors")); // control adapter, not a registry lora
}

const png = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 10, b: 10 } } })
    .png()
    .toBuffer();

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/jobs/tool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("tools routes", () => {
  beforeAll(() => {
    installAllLoras();
    installBaseWeights();
  });
  afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  beforeEach(async () => {
    queuePrompt.mockReset().mockResolvedValue({ prompt_id: "pid-1" });
    uploadImageToComfy.mockReset().mockResolvedValue("uploaded.png [input]");
    fetchImage.mockReset().mockImplementation(async () => png(640, 480));
  });

  describe("GET /api/tools", () => {
    it("lists all tools with installed + packAvailable (subfolder loras)", async () => {
      const res = await GET(new NextRequest("http://localhost/api/tools"));
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.tools).toHaveLength(32);
      for (const t of json.tools) {
        expect(t.installed, t.id).toBe(true);
        expect(t.packAvailable, t.id).toBe(true);
        expect(t.available).toBe(true);
        expect(t).not.toHaveProperty("pack");
      }
      expect(res.headers.get("access-control-allow-origin")).toBeDefined();
    });

    it("reports installed=false when a lora is missing, case-insensitively", async () => {
      const t = getEditTools().find((x) => x.id === "qwen21-restore")!;
      const p = path.join(tmpRoot, "models", "loras", t.loras[0].file);
      const upper = path.join(path.dirname(p), path.basename(p).toUpperCase().replace(".SAFETENSORS", ".safetensors"));
      fs.renameSync(p, upper);
      let json = await (await GET(new NextRequest("http://localhost/api/tools"))).json();
      expect(json.tools.find((x: { id: string }) => x.id === "qwen21-restore").installed).toBe(true);
      fs.unlinkSync(upper);
      json = await (await GET(new NextRequest("http://localhost/api/tools"))).json();
      expect(json.tools.find((x: { id: string }) => x.id === "qwen21-restore").installed).toBe(false);
      touch(path.join("models", "loras", t.loras[0].file));
    });

    it("packAvailable=false without base weights", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cj-tools-empty-"));
      const { env } = await import("@/lib/env");
      const prev = env.COMFY_ROOT;
      (env as { COMFY_ROOT: string }).COMFY_ROOT = root;
      try {
        const json = await (await GET(new NextRequest("http://localhost/api/tools"))).json();
        for (const t of json.tools) {
          // a LoRA-free tool has no tool weights of its own to miss
          expect(t.installed, t.id).toBe(t.id === "qwen21-remove-bg");
          expect(t.packAvailable).toBe(false);
          expect(t.available).toBe(false);
        }
      } finally {
        (env as { COMFY_ROOT: string }).COMFY_ROOT = prev;
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("POST /api/jobs/tool validation", () => {
    it.each([
      ["no body fields", {}, "unknown_tool"],
      ["unknown tool", { toolId: "nope", images: [] }, "unknown_tool"],
      ["images not array", { toolId: "qwen21-restore", images: "x" }, "invalid_image"],
      ["wrong count", { toolId: "qwen21-outfit-swap", images: ["a.png [input]"] }, "wrong_image_count"],
      ["bad ref", { toolId: "qwen21-restore", images: ["../../etc/passwd"] }, "invalid_image"],
      ["bad run obj", { toolId: "qwen21-restore", images: [{ run_id: 3 }] }, "invalid_image"],
      ["mask required", { toolId: "krea2-inpaint", images: ["a.png [input]"], prompt: "x" }, "mask_required"],
      ["mask unsupported", { toolId: "qwen21-restore", images: ["a.png [input]"], mask: "m.png [input]" }, "mask_unsupported"],
      ["prompt required", { toolId: "krea2-general-edit", images: ["a.png [input]"] }, "prompt_required"],
      ["prompt type", { toolId: "qwen21-restore", images: ["a.png [input]"], prompt: 5 }, "invalid_prompt"],
      ["prompt long", { toolId: "qwen21-restore", images: ["a.png [input]"], prompt: "x".repeat(5000) }, "invalid_prompt"],
      ["bad option", { toolId: "qwen21-restore", images: ["a.png [input]"], options: { fast: "x" } }, "invalid_options"],
      ["mask required (redbox)", { toolId: "qwen21-remove-box", images: ["a.png [input]"] }, "mask_required"],
      ["mask required (scribble)", { toolId: "qwen21-doodle", images: ["a.png [input]"], prompt: "x" }, "mask_required"],
      ["doodle prompt required", { toolId: "qwen21-doodle", images: ["a.png [input]"], mask: "m.png [input]" }, "prompt_required"],
      ["2511 remove prompt required", { toolId: "qwen2511-remove", images: ["a.png [input]"] }, "prompt_required"],
      ["head swap needs 2", { toolId: "qwen21-head-swap", images: ["a.png [input]"] }, "wrong_image_count"],
      ["unsupported fast", { toolId: "qwen21-camera", images: ["a.png [input]"], options: { fast: true } }, "invalid_options"],
      ["dry_run type", { toolId: "qwen21-restore", images: ["a.png [input]"], dry_run: "yes" }, "invalid_dry_run"],
    ])("400: %s", async (_n, body, code) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error).toBeTruthy();
      expect(json.details.code).toBe(code);
      expect(queuePrompt).not.toHaveBeenCalled();
    });

    it("400 on invalid JSON", async () => {
      const res = await POST(
        new NextRequest("http://localhost/api/jobs/tool", { method: "POST", body: "{nope" }),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).details.code).toBe("invalid_json");
    });

    it("404 for a missing source run", async () => {
      const res = await post({ toolId: "qwen21-restore", images: [{ run_id: "ghost", job_index: 0 }] });
      expect(res.status).toBe(404);
      expect((await res.json()).details.code).toBe("run_not_found");
    });

    it("409 when a lora is missing", async () => {
      const t = getEditTools().find((x) => x.id === "qwen21-unblur-background")!;
      const p = path.join(tmpRoot, "models", "loras", t.loras[0].file);
      fs.unlinkSync(p);
      try {
        const res = await post({ toolId: t.id, images: ["a.png [input]"] });
        expect(res.status).toBe(409);
        expect((await res.json()).details.code).toBe("lora_missing");
      } finally {
        touch(path.join("models", "loras", t.loras[0].file));
      }
    });

    it.each(["qwen21-remove-box", "qwen21-doodle"])("400 invalid_geometry for an empty mask (%s)", async (toolId) => {
      const black = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).png().toBuffer();
      const res = await post({
        toolId,
        images: ["a.png [input]"],
        prompt: "x",
        mask: `data:image/png;base64,${black.toString("base64")}`,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).details.code).toBe("invalid_geometry");
      expect(queuePrompt).not.toHaveBeenCalled();
    });

    it("400 invalid_geometry for an empty mask", async () => {
      const black = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).png().toBuffer();
      const res = await post({
        toolId: "krea2-inpaint",
        images: ["a.png [input]"],
        prompt: "x",
        mask: `data:image/png;base64,${black.toString("base64")}`,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).details.code).toBe("invalid_geometry");
      expect(queuePrompt).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/jobs/tool success", () => {
    it("restore: queues with lora chain, returns action-shaped run", async () => {
      const res = await post({
        toolId: "qwen21-restore",
        images: ["photo.png [input]"],
        prompt: "old scan",
        options: { seed: 42, keepFraming: true, fast: true },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.request_id).toBeTruthy();
      expect(json.run).toMatchObject({
        action: "tool_qwen21-restore",
        status: "queued",
        jobs: [{ seed: 42, index: 0, status: "queued", prompt_id: "pid-1" }],
      });
      expect(json.run.params).toMatchObject({ tool_id: "qwen21-restore", seed: 42 });

      expect(queuePrompt).toHaveBeenCalledTimes(1);
      const [wf, clientId] = queuePrompt.mock.calls[0] as [Record<string, { class_type: string; inputs: Record<string, unknown> }>, string];
      expect(clientId).toMatch(/^tool-/);
      const loras = Object.values(wf).filter((n) => n.class_type === "LoraLoaderModelOnly").map((n) => n.inputs.lora_name);
      expect(loras).toHaveLength(3);
      expect(loras[2]).toBe("edit_tools/qwen-image-2.1-lightning-4step.safetensors");
      const ks = Object.values(wf).find((n) => n.class_type === "KSampler")!;
      expect(ks.inputs).toMatchObject({ steps: 4, cfg: 1, seed: 42 });
      expect(Object.values(wf).find((n) => n.class_type === "LoadImage")!.inputs.image).toBe("photo.png [input]");
      expect(uploadImageToComfy).not.toHaveBeenCalled();
    });

    it("passes the master-file choice (body output_format) to queuePrompt", async () => {
      const res = await post({
        toolId: "qwen21-restore",
        images: ["photo.png [input]"],
        options: { seed: 9 },
        output_format: { image: "exr" },
      });
      expect(res.status).toBe(200);
      const opts = queuePrompt.mock.calls[0][3] as { master: unknown };
      expect(opts.master).toEqual({
        choice: { image: "exr" },
        tool: "qwen21-restore",
        seed: 9,
      });
    });

    it("dry_run: returns the built workflow without queueing", async () => {
      const res = await post({
        toolId: "qwen21-restore",
        images: ["photo.png [input]"],
        options: { seed: 7 },
        dry_run: true,
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json).toMatchObject({ tool_id: "qwen21-restore", seed: 7 });
      expect(json.run).toBeUndefined();
      const wf = json.workflow as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      expect(Object.values(wf).find((n) => n.class_type === "LoadImage")!.inputs.image).toBe("photo.png [input]");
      expect(Object.values(wf).find((n) => n.class_type === "KSampler")!.inputs).toMatchObject({ seed: 7 });
      expect(queuePrompt).not.toHaveBeenCalled();
    });

    it("returns optional-node bypass warnings like imagine does", async () => {
      queuePrompt.mockResolvedValueOnce({
        prompt_id: "pid-1",
        warnings: ["NegPiP not installed — node bypassed"],
      });
      const res = await post({
        toolId: "qwen21-restore",
        images: ["photo.png [input]"],
        prompt: "old scan",
        options: { seed: 42 },
      });
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.warnings).toEqual({
        nodes: ["NegPiP not installed — node bypassed"],
      });
    });

    it("expands wildcards with the tool seed and embeds the cj chunk", async () => {
      const res = await post({
        toolId: "qwen21-restore",
        images: ["photo.png [input]"],
        prompt: "old __medium__ scan",
        options: { seed: 42 },
      });
      const json = await res.json();
      expect(res.status, JSON.stringify(json)).toBe(200);
      expect(json.wildcards).toMatchObject({ seed: 42, used: ["medium"], missing: [] });
      expect(json.run.prompt).not.toContain("__medium__");
      expect(json.run.params.wildcards).toEqual({
        original: "old __medium__ scan",
        seed: 42,
        used: ["medium"],
      });
      const opts = queuePrompt.mock.calls[0][3] as {
        extraData: { extra_pnginfo: { cj: { params: Record<string, unknown> } } };
      };
      expect(opts.extraData.extra_pnginfo.cj.params).toMatchObject({
        action: "tool_qwen21-restore",
        tool_id: "qwen21-restore",
        seed: 42,
        fullPrompt: json.run.prompt,
      });
    });

    it("accepts a /view URL and a run ref; carries source run fields", async () => {
      const src = {
        run_id: "src-run",
        prompt: "p",
        parsedPrompt: "p",
        params: { foo: 1 },
        width: 777,
        height: 555,
        jobs: [{ seed: 1, index: 0, status: "completed", progress: 100, images: ["http://127.0.0.1:8188/view?filename=r.png&subfolder=&type=output"] }],
        createdAt: new Date().toISOString(),
        status: "completed",
      } as unknown as ImagineRun;
      addActiveRun(src);
      const res = await post({ toolId: "qwen21-unblur-background", images: [{ run_id: "src-run", job_index: 0 }] });
      const json = await res.json();
      expect(res.status, JSON.stringify(json)).toBe(200);
      expect(json.run.width).toBe(777);
      expect(json.run.params).toMatchObject({ foo: 1, action_source_run_id: "src-run" });
      const wf = queuePrompt.mock.calls[0][0] as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      expect(Object.values(wf).find((n) => n.class_type === "LoadImage")!.inputs.image).toBe("r.png [output]");

      queuePrompt.mockClear();
      const res2 = await post({
        toolId: "qwen21-unblur-background",
        images: ["http://127.0.0.1:8188/view?filename=v.png&subfolder=s&type=output"],
      });
      expect(res2.status).toBe(200);
      const wf2 = queuePrompt.mock.calls[0][0] as typeof wf;
      expect(Object.values(wf2).find((n) => n.class_type === "LoadImage")!.inputs.image).toBe("s/v.png [output]");
    });

    it("outpaint: pads server-side and uploads the gray canvas", async () => {
      const res = await post({
        toolId: "qwen21-outpaint",
        images: ["src.png [input]"],
        options: { outpaint: { left: 0.25, right: 0.25 } },
      });
      expect(res.status).toBe(200);
      const [bytes, name] = uploadImageToComfy.mock.calls[0] as [Buffer, string];
      expect(name).toMatch(/outpaint\.png$/);
      const meta = await sharp(bytes).metadata();
      expect([meta.width, meta.height]).toEqual([960, 480]);
      const raw = await sharp(bytes).removeAlpha().raw().toBuffer();
      expect([raw[0], raw[1], raw[2]]).toEqual([128, 128, 128]);
      const json = await res.json();
      expect(json.run.width).toBe(960);
      expect(json.run.height).toBe(480);
      const wf = queuePrompt.mock.calls[0][0] as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      expect(Object.values(wf).find((n) => n.class_type === "LoadImage")!.inputs.image).toBe("uploaded.png [input]");
    });

    it("character sheet: letterboxes into the 1344x768 gray frame and uploads it", async () => {
      fetchImage.mockImplementation(async () => png(600, 1200));
      const res = await post({ toolId: "qwen21-character-sheet", images: ["src.png [input]"], options: { sheet: "pose-neck" } });
      const json = await res.json();
      expect(res.status, JSON.stringify(json)).toBe(200);
      const [bytes, name] = uploadImageToComfy.mock.calls[0] as [Buffer, string];
      expect(name).toMatch(/letterbox\.png$/);
      const meta = await sharp(bytes).metadata();
      expect([meta.width, meta.height]).toEqual([1344, 768]);
      const raw = await sharp(bytes).removeAlpha().raw().toBuffer();
      expect([raw[0], raw[1], raw[2]]).toEqual([128, 128, 128]);
      expect([json.run.width, json.run.height]).toEqual([1344, 768]);
      const wf = queuePrompt.mock.calls[0][0] as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      expect(Object.values(wf).find((n) => n.class_type === "LoadImage")!.inputs.image).toBe("uploaded.png [input]");
      const enc = Object.values(wf).find((n) => n.class_type === "TextEncodeQwenImage21")!;
      expect(enc.inputs.prompt).toMatch(/character pose sheet/);
    });

    it("pano360: no upload, run size follows the size option", async () => {
      const res = await post({ toolId: "qwen21-pano360", images: ["src.png [input]"], prompt: "a snowy alpine pass", options: { size: "2048" } });
      const json = await res.json();
      expect(res.status, JSON.stringify(json)).toBe(200);
      expect(uploadImageToComfy).not.toHaveBeenCalled();
      expect([json.run.width, json.run.height]).toEqual([2048, 1024]);
    });

    it("krea2 outpaint: original image in, no pad/upload, 2 passes for all sides", async () => {
      const res = await post({
        toolId: "krea2-outpaint",
        images: ["src.png [input]"],
        options: { outpaint: "all_25" },
      });
      const json = await res.json();
      expect(res.status, JSON.stringify(json)).toBe(200);
      expect(uploadImageToComfy).not.toHaveBeenCalled();
      const wf = queuePrompt.mock.calls[0][0] as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      expect(Object.values(wf).filter((n) => n.class_type === "LoadImage").map((n) => n.inputs.image)).toEqual(["src.png [input]"]);
      const comps = Object.entries(wf).filter(([, n]) => n.class_type === "Krea2OutpaintComposite");
      expect(comps).toHaveLength(2);
      const final = comps[1][1].inputs;
      expect(json.run.width).toBe(final.canvas_width);
      expect(json.run.height).toBe(final.canvas_height);
      expect(Number(final.canvas_width) / Number(final.canvas_height)).toBeCloseTo(640 / 480, 1);
      const save = Object.values(wf).find((n) => n.class_type === "SaveImage")!;
      expect(save.inputs.images).toEqual([comps[1][0], 0]);
      const tools = (await (await GET(new NextRequest("http://localhost/api/tools"))).json()).tools;
      expect(tools.find((x: { id: string }) => x.id === "krea2-outpaint")).toMatchObject({ available: true, category: "Expand" });
    });

    it("krea2 outpaint: one axis = one pass", async () => {
      const res = await post({ toolId: "krea2-outpaint", images: ["src.png [input]"], options: { outpaint: { right: 0.5 } } });
      expect(res.status).toBe(200);
      const wf = queuePrompt.mock.calls[0][0] as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      const comps = Object.values(wf).filter((n) => n.class_type === "Krea2OutpaintComposite");
      expect(comps).toHaveLength(1);
      expect(comps[0].inputs).toMatchObject({ bbox_x0: 0, bbox_y0: 0, bbox_y1: comps[0].inputs.canvas_height });
    });

    async function anyPaintMask(w: number, h: number, box: [number, number, number, number] | null) {
      const m = Buffer.alloc(w * h, 0);
      if (box) for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) m[y * w + x] = 255;
      const b = await sharp(m, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
      return `data:image/png;base64,${b.toString("base64")}`;
    }
    type Wf = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

    it("krea2 anypaint: uploads a source-sized binary mask, source stays the original ref", async () => {
      const res = await post({
        toolId: "krea2-anypaint",
        images: ["src.png [input]"],
        prompt: "a cat on the sofa",
        mask: await anyPaintMask(64, 48, [20, 10, 40, 20]),
      });
      const json = await res.json();
      expect(res.status, JSON.stringify(json)).toBe(200);
      expect(uploadImageToComfy).toHaveBeenCalledTimes(1);
      const [bytes, name] = uploadImageToComfy.mock.calls[0] as [Buffer, string];
      expect(name).toMatch(/_anypaint_mask\.png$/);
      const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      expect([info.width, info.height]).toEqual([640, 480]);
      expect(new Set(data)).toEqual(new Set([0, 255]));
      const at = (x: number, y: number) => data[(y * 640 + x) * 3];
      expect(at(300, 150)).toBe(255); // inside 200..399 x 100..199
      expect(at(100, 50)).toBe(0);
      const wf = queuePrompt.mock.calls[0][0] as Wf;
      const by = (c: string) => Object.values(wf).filter((n) => n.class_type === c);
      // Source in, plus the same source for the full-res paste-back.
      expect(by("LoadImage").map((n) => n.inputs.image)).toEqual([
        "src.png [input]",
        "src.png [input]",
      ]);
      const masks = by("LoadImageMask").map((n) => n.inputs.image);
      expect(new Set(masks)).toEqual(new Set(["uploaded.png [input]"]));
      expect(by("CJImagePasteBack")).toHaveLength(1);
      expect(by("ImageCompositeMasked")).toHaveLength(1);
      const prep = by("Krea2AnyPaintPrepare")[0].inputs;
      expect(prep).toMatchObject({ bbox_x0: 0, bbox_y0: 0, bbox_x1: prep.canvas_width, bbox_y1: prep.canvas_height });
      expect(Number(prep.canvas_width) % 16).toBe(0);
      expect(Number(prep.canvas_width) / Number(prep.canvas_height)).toBeCloseTo(640 / 480, 1);
      expect([json.run.width, json.run.height]).toEqual([640, 480]);
      expect(JSON.stringify(by("TextEncodeKrea2AnyPaint")[0].inputs)).toContain("a cat on the sofa");
      expect(by("LoraLoaderModelOnly").map((n) => n.inputs.lora_name)).toEqual(["krea2_anypaint_rank32.safetensors"]);
      expect(by("KSampler")[0].inputs).toMatchObject({ steps: 8, cfg: 1 });
    });

    it("krea2 anypaint: expand without a mask grows the canvas, source anchored left", async () => {
      const res = await post({
        toolId: "krea2-anypaint",
        images: ["src.png [input]"],
        prompt: "a wide beach",
        options: { expand: "right_50" },
      });
      const json = await res.json();
      expect(res.status, JSON.stringify(json)).toBe(200);
      const [bytes] = uploadImageToComfy.mock.calls[0] as [Buffer];
      const { data } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(data.every((v) => v === 0)).toBe(true); // empty mask allowed when expanding
      const wf = queuePrompt.mock.calls[0][0] as Wf;
      const prep = Object.values(wf).find((n) => n.class_type === "Krea2AnyPaintPrepare")!.inputs;
      expect(prep).toMatchObject({ bbox_x0: 0, bbox_y0: 0, bbox_y1: prep.canvas_height });
      expect(Number(prep.bbox_x1)).toBeLessThan(Number(prep.canvas_width));
      expect(Number(prep.canvas_width) / Number(prep.canvas_height)).toBeCloseTo((640 * 1.5) / 480, 1);
      expect([json.run.width, json.run.height]).toEqual([prep.canvas_width, prep.canvas_height]);
    });

    it("krea2 anypaint: 400 mask_required without mask or expand, invalid_geometry for an empty mask", async () => {
      const noMask = await post({ toolId: "krea2-anypaint", images: ["src.png [input]"], prompt: "x" });
      expect(noMask.status).toBe(400);
      expect((await noMask.json()).details.code).toBe("mask_required");
      const empty = await post({
        toolId: "krea2-anypaint",
        images: ["src.png [input]"],
        prompt: "x",
        mask: await anyPaintMask(8, 8, null),
      });
      expect(empty.status).toBe(400);
      expect((await empty.json()).details.code).toBe("invalid_geometry");
      expect(queuePrompt).not.toHaveBeenCalled();
    });

    it("flux3 outpaint with an aspect preset", async () => {
      const res = await post({
        toolId: "flux3-outpaint",
        images: ["src.png [input]"],
        options: { outpaint: { aspect: "21:9" } },
      });
      expect(res.status).toBe(200);
      const [bytes] = uploadImageToComfy.mock.calls[0] as [Buffer];
      const meta = await sharp(bytes).metadata();
      expect(meta.width! / meta.height!).toBeCloseTo(21 / 9, 1);
    });

    it("krea2 inpaint: black-fills the mask and sets latent size", async () => {
      const maskRaw = Buffer.alloc(64 * 48, 0);
      for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++) maskRaw[y * 64 + x] = 255;
      const mask = await sharp(maskRaw, { raw: { width: 64, height: 48, channels: 1 } }).png().toBuffer();
      const res = await post({
        toolId: "krea2-inpaint",
        images: ["src.png [input]"],
        prompt: "a lamp",
        mask: `data:image/png;base64,${mask.toString("base64")}`,
      });
      const json = await res.json();
      expect(res.status, JSON.stringify(json)).toBe(200);
      const [bytes] = uploadImageToComfy.mock.calls[0] as [Buffer];
      const raw = await sharp(bytes).removeAlpha().raw().toBuffer();
      expect([raw[0], raw[1], raw[2]]).toEqual([0, 0, 0]);
      const last = raw.length - 3;
      expect([raw[last], raw[last + 1], raw[last + 2]]).toEqual([200, 10, 10]);
      const wf = queuePrompt.mock.calls[0][0] as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      const latents = Object.values(wf).filter((n) => n.class_type === "EmptySD3LatentImage");
      for (const l of latents) {
        expect(Number(l.inputs.width) % 16).toBe(0);
        expect(Number(l.inputs.height) % 16).toBe(0);
      }
    });

    it("krea2 general edit: latent follows the source aspect (not fixed 1024 square)", async () => {
      const res = await post({
        toolId: "krea2-general-edit",
        images: ["src.png [input]"],
        prompt: "make it red",
      });
      expect(res.status).toBe(200);
      const wf = queuePrompt.mock.calls[0][0] as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      const l = Object.values(wf).find((n) => n.class_type === "EmptySD3LatentImage")!;
      expect(Number(l.inputs.width)).toBeGreaterThan(Number(l.inputs.height));
      expect(Number(l.inputs.width) / Number(l.inputs.height)).toBeCloseTo(640 / 480, 1);
    });

    async function squareMask() {
      const m = Buffer.alloc(64 * 48, 0);
      for (let y = 10; y < 20; y++) for (let x = 20; x < 40; x++) m[y * 64 + x] = 255;
      const b = await sharp(m, { raw: { width: 64, height: 48, channels: 1 } }).png().toBuffer();
      return `data:image/png;base64,${b.toString("base64")}`;
    }

    it("remove-box: uploads the red-outlined image, fixed prompt, speed lora by default", async () => {
      const res = await post({ toolId: "qwen21-remove-box", images: ["src.png [input]"], mask: await squareMask() });
      const json = await res.json();
      expect(res.status, JSON.stringify(json)).toBe(200);
      const [bytes, name] = uploadImageToComfy.mock.calls[0] as [Buffer, string];
      expect(name).toMatch(/_redbox\.png$/);
      const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      expect([info.width, info.height]).toEqual([640, 480]);
      const at = (x: number, y: number) => [...data.subarray((y * 640 + x) * 3, (y * 640 + x) * 3 + 3)];
      // mask scaled 10x to 640x480: box x 200..399, y 100..199; outline sits just outside (top bar)
      expect(at(300, 100 - 2)).toEqual([239, 68, 68]);
      expect(at(300, 150)).toEqual([200, 10, 10]); // interior untouched
      const wf = queuePrompt.mock.calls[0][0] as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      expect(JSON.stringify(wf)).toContain("Remove the red highlighted object from the scene");
      const ks = Object.values(wf).find((n) => n.class_type === "KSampler")!;
      expect(ks.inputs.steps).toBe(4);
    });

    it("doodle: paints the mask magenta and renders the template", async () => {
      const res = await post({
        toolId: "qwen21-doodle",
        images: ["src.png [input]"],
        prompt: "a red chair",
        mask: await squareMask(),
      });
      const json = await res.json();
      expect(res.status, JSON.stringify(json)).toBe(200);
      const [bytes, name] = uploadImageToComfy.mock.calls[0] as [Buffer, string];
      expect(name).toMatch(/_scribble\.png$/);
      const { data } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const o = (150 * 640 + 300) * 3;
      expect([data[o], data[o + 1], data[o + 2]]).toEqual([255, 0, 255]);
      const wf = queuePrompt.mock.calls[0][0] as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      expect(JSON.stringify(wf)).toContain("<doodle> Turn the magenta scribble into a red chair.");
      const ks = Object.values(wf).find((n) => n.class_type === "KSampler")!;
      expect(ks.inputs).toMatchObject({ steps: 40, cfg: 1 });
    });

    it.each([
      ["krea2-inpaint", "a lamp", true],
      ["qwen21-remove-box", undefined, true],
      ["qwen21-doodle", "a red chair", false],
    ] as const)(
      "%s: masked edit pastes back onto the full-res source",
      async (toolId, prompt, clamp) => {
        const res = await post({
          toolId,
          images: ["src.png [input]"],
          ...(prompt ? { prompt } : {}),
          mask: await squareMask(),
        });
        const json = await res.json();
        expect(res.status, JSON.stringify(json)).toBe(200);
        const calls = uploadImageToComfy.mock.calls as [Buffer, string][];
        const up = calls.find(([, n]) => n.endsWith("_pasteback_mask.png"));
        expect(up).toBeDefined();
        const { data, info } = await sharp(up![0])
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        expect([info.width, info.height]).toEqual([640, 480]);
        expect(data[(150 * 640 + 300) * 3]).toBe(255);
        expect(data[(50 * 640 + 100) * 3]).toBe(0);
        type N = { class_type: string; inputs: Record<string, unknown> };
        const wf = queuePrompt.mock.calls[0][0] as Record<string, N>;
        const by = (c: string) =>
          Object.entries(wf).filter(([, n]) => n.class_type === c);
        const [[pbId, pb]] = by("CJImagePasteBack");
        const orig = wf[(pb.inputs.original as [string, number])[0]];
        expect(orig.inputs.image).toBe("src.png [input]");
        const save = by("SaveImage")[0][1];
        const fed = (save.inputs.images as [string, number])[0];
        if (clamp) {
          expect(wf[fed].class_type).toBe("ImageCompositeMasked");
        } else {
          expect(fed).toBe(pbId);
          expect(by("ImageCompositeMasked")).toHaveLength(0);
        }
        expect([json.run.width, json.run.height]).toEqual([640, 480]);
      },
    );

    it("moss restyle: depth graph sized to the source aspect, options reach the graph", async () => {
      const res = await post({
        toolId: "moss-restyle-depth",
        images: ["src.png [input]"],
        prompt: "art deco hotel lobby",
        options: { structure: "loose", depth: "large", fast: false },
      });
      const json = await res.json();
      expect(res.status, JSON.stringify(json)).toBe(200);
      const wf = queuePrompt.mock.calls[0][0] as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      const by = (c: string) => Object.values(wf).find((n) => n.class_type === c)!;
      const lat = by("EmptyFlux2LatentImage").inputs;
      expect(Number(lat.width) / Number(lat.height)).toBeCloseTo(640 / 480, 1);
      expect(by("ImageScale").inputs).toMatchObject({ width: lat.width, height: lat.height });
      expect(by("MOSSImageControl").inputs.end_percent).toBe(0.5);
      expect(by("LoadDA3Model").inputs.model_name).toBe("depth_anything_3_mono_large.safetensors");
      expect(by("KSampler").inputs.steps).toBe(50);
      expect(JSON.stringify(wf)).toContain("art deco hotel lobby");
    });

    it("moss restyle: packAvailable=false without the DA3 depth weights", async () => {
      const p = path.join(tmpRoot, "models", "geometry_estimation", "depth_anything_3_mono_large.safetensors");
      fs.renameSync(p, p + ".off");
      try {
        const json = await (await GET(new NextRequest("http://localhost/api/tools"))).json();
        const t = json.tools.find((x: { id: string }) => x.id === "moss-restyle-depth");
        expect(t.packAvailable).toBe(false);
      } finally {
        fs.renameSync(p + ".off", p);
      }
    });

    it("krea2 restyle: depth graph sized to the source aspect, loose ends depth early", async () => {
      const res = await post({
        toolId: "krea2-restyle-depth",
        images: ["src.png [input]"],
        prompt: "flooded cathedral, moonlight",
        options: { structure: "loose", depth: "large" },
      });
      const json = await res.json();
      expect(res.status, JSON.stringify(json)).toBe(200);
      const wf = queuePrompt.mock.calls[0][0] as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      const by = (c: string) => Object.values(wf).find((n) => n.class_type === c)!;
      const lat = by("EmptySD3LatentImage").inputs;
      expect(Number(lat.width) / Number(lat.height)).toBeCloseTo(640 / 480, 1);
      expect(by("ImageScale").inputs).toMatchObject({ width: lat.width, height: lat.height });
      expect(by("Krea2DualControlApply").inputs).toMatchObject({ depth_end: 0.6, adapter_name: "krea2-control.safetensors" });
      expect(by("LoadDA3Model").inputs.model_name).toBe("depth_anything_3_mono_large.safetensors");
      expect(by("KSampler").inputs).toMatchObject({ steps: 8, cfg: 1 });
      expect(JSON.stringify(wf)).toContain("flooded cathedral, moonlight");
    });

    it("krea2 layout: region map sizes the latent, loose ends the color map early", async () => {
      const res = await post({
        toolId: "krea2-layout-regions",
        images: ["src.png [input]"],
        prompt: "two people on a beach",
        options: { layout: "loose" },
      });
      const json = await res.json();
      expect(res.status, JSON.stringify(json)).toBe(200);
      const wf = queuePrompt.mock.calls[0][0] as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      const by = (c: string) => Object.values(wf).find((n) => n.class_type === c)!;
      const lat = by("EmptySD3LatentImage").inputs;
      expect(Number(lat.width) / Number(lat.height)).toBeCloseTo(640 / 480, 1);
      expect(by("ImageScale").inputs).toMatchObject({ width: lat.width, height: lat.height, upscale_method: "nearest-exact" });
      expect(by("Krea2DualControlApply").inputs).toMatchObject({ color_end: 0.4, depth_end: 1 });
      const tools = (await (await GET(new NextRequest("http://localhost/api/tools"))).json()).tools;
      expect(tools.find((x: { id: string }) => x.id === "krea2-layout-regions")).toMatchObject({ available: true, category: "Compose" });
    });

    it("krea2 head swap: both refs reach the graph, latent follows the base image", async () => {
      const res = await post({
        toolId: "krea2-head-swap",
        images: ["base.png [input]", "head.png [input]"],
        options: { likeness: "strong" },
      });
      const json = await res.json();
      expect(res.status, JSON.stringify(json)).toBe(200);
      const wf = queuePrompt.mock.calls[0][0] as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      const loads = Object.values(wf).filter((n) => n.class_type === "LoadImage").map((n) => n.inputs.image);
      expect(loads.sort()).toEqual(["base.png [input]", "head.png [input]"]);
      const by = (c: string) => Object.values(wf).find((n) => n.class_type === c)!;
      const lat = by("EmptySD3LatentImage").inputs;
      expect(Number(lat.width) / Number(lat.height)).toBeCloseTo(640 / 480, 1);
      expect(by("Krea2EditModelPatch").inputs.ref_boost).toBe(4);
      expect(JSON.stringify(wf)).toContain("head_swap: replace the head with the reference head.");
      const tools = (await (await GET(new NextRequest("http://localhost/api/tools"))).json()).tools;
      expect(tools.find((x: { id: string }) => x.id === "krea2-head-swap")).toMatchObject({ available: true, category: "Swap" });
    });

    it("krea2 restyle: installed=false without the control adapter", async () => {
      const p = path.join(tmpRoot, "models", "loras", "krea2-control.safetensors");
      fs.renameSync(p, p + ".off");
      try {
        const json = await (await GET(new NextRequest("http://localhost/api/tools"))).json();
        const t = json.tools.find((x: { id: string }) => x.id === "krea2-restyle-depth");
        expect(t).toMatchObject({ installed: false, packAvailable: true, available: false });
        expect(json.tools.find((x: { id: string }) => x.id === "moss-restyle-depth").available).toBe(true);
      } finally {
        fs.renameSync(p + ".off", p);
      }
    });

    it("qwen2511 remove: latent follows source aspect, prompt on the encoder", async () => {
      const res = await post({ toolId: "qwen2511-remove", images: ["src.png [input]"], prompt: "the lamp" });
      const json = await res.json();
      expect(res.status, JSON.stringify(json)).toBe(200);
      const wf = queuePrompt.mock.calls[0][0] as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      const l = Object.values(wf).find((n) => n.class_type === "EmptySD3LatentImage")!;
      expect(Number(l.inputs.width) / Number(l.inputs.height)).toBeCloseTo(640 / 480, 1);
      expect(JSON.stringify(wf)).toContain("Remove the lamp from the image");
    });

    it("flux3 camera: queues the <mva> prompt on the base edit graph at 50 steps", async () => {
      const res = await post({
        toolId: "flux3-camera",
        images: ["p.png [input]"],
        options: { azimuth: "back-left", elevation: "top-down", distance: "close-up" },
      });
      const json = await res.json();
      expect(res.status, JSON.stringify(json)).toBe(200);
      const wf = queuePrompt.mock.calls[0][0] as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      expect(JSON.stringify(wf)).toContain("<mva> back-left quarter view, top-down shot close-up");
      const ks = Object.values(wf).find((n) => n.class_type === "KSampler")!;
      expect(ks.inputs.steps).toBe(50);
    });

    it("head swap wires both refs", async () => {
      const res = await post({ toolId: "qwen21-head-swap", images: ["body.png [input]", "face.png [input]"] });
      expect(res.status).toBe(200);
      const s = JSON.stringify(queuePrompt.mock.calls[0][0]);
      expect(s).toContain("body.png [input]");
      expect(s).toContain("face.png [input]");
      expect(s).toContain("head_swap:");
    });

    it("camera: renders the QMA prompt into the graph", async () => {
      const res = await post({
        toolId: "qwen21-camera",
        images: ["p.png [input]"],
        options: { azimuth: "front-right" },
      });
      expect(res.status).toBe(200);
      const wf = queuePrompt.mock.calls[0][0];
      const s = JSON.stringify(wf);
      expect(s).toContain("<qma>");
      expect(s).toContain("front-right quarter view");
    });

    it("outfit swap needs and wires 2 images", async () => {
      const res = await post({
        toolId: "qwen21-outfit-swap",
        images: ["person.png [input]", "outfit.png [input]"],
      });
      expect(res.status).toBe(200);
      expect(JSON.stringify(queuePrompt.mock.calls[0][0])).toContain("outfit.png [input]");
    });

    it("ComfyUI failure surfaces as 502 without a run", async () => {
      const { ComfyAPIError } = await import("@/lib/comfy/http");
      queuePrompt.mockRejectedValueOnce(new ComfyAPIError("boom"));
      const res = await post({ toolId: "qwen21-restore", images: ["a.png [input]"] });
      expect(res.status).toBe(502);
      expect((await res.json()).ok).toBe(false);
    });
  });
});
