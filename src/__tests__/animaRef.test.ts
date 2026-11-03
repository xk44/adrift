/**
 * Character from reference (Anima Ref Adapter): graph, builder, registry,
 * setup declarations and the prompt-bar submit helper (fetch mocked; no
 * ComfyUI).
 */
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import registry from "@/lib/oj/registry.json";
import { resolveWorkflow } from "@/lib/oj/packs";
import { actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  ANIMA_DEFAULT_NEGATIVE,
  ANIMA_DUO_HEIGHT,
  ANIMA_DUO_WIDTH,
  ANIMA_LICENSE,
  ANIMA_QUALITY_PREFIX,
  ANIMA_REF_ACTION,
  animaDims,
  animaNegative,
  animaPositive,
  animaRefGraphKind,
  buildAnimaRefWorkflow,
} from "@/lib/oj/animaRef";
import { applyWorkflowFallback } from "@/lib/comfy/workflows";
import { workflowModelRequirements } from "@/lib/tools/modelStatus";
import { missingAgainstObjectInfo } from "@/lib/comfy/backendModels";
import { familyFor } from "@/lib/tools/toolsDoc";
import { licenseUrlFor } from "@/lib/models/licenseLinks";
import modelSizes from "@/lib/tools/modelSizes.json";
import modelRepoPaths from "@/lib/tools/modelRepoPaths.json";
import starterPacks from "@/lib/onboarding/starterPacks.json";
import {
  animaRefRequest,
  submitAnimaRef,
} from "@/lib/characters/animaRefSubmit";
import type { ToolImage } from "@/lib/tools/runTool";
import type { ImagineRun, Workflow } from "@/types";

const REL = "packs/anima/anima_ref.json";
const PILOT_REL = "packs/anima/anima_ref_pilot.json";
const loadRel = (rel: string): Workflow =>
  JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "public/workflows", rel), "utf-8"),
  );
const load = (): Workflow => loadRel(REL);
const loadPilot = (): Workflow => loadRel(PILOT_REL);
const classes = (wf: Workflow) =>
  Object.fromEntries(
    Object.entries(wf)
      .filter(([k]) => !k.startsWith("_"))
      .map(([k, n]) => [k, n.class_type]),
  );

const IMG = "/api/comfy/view?filename=cj_anima_x.png&subfolder=&type=input";
const run = (images: string[] = [IMG]): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "ref",
    width: 768,
    height: 1024,
    jobs: [{ seed: 1, index: 0, status: "completed", progress: 100, images }],
    createdAt: new Date().toISOString(),
    status: "completed",
    params: {},
  }) as unknown as ImagineRun;

const node = (wf: Workflow, id: string) => wf[id].inputs;

describe("anima_ref graph (v2)", () => {
  it("is the verified one-node v2 graph (node ids, classes, models)", () => {
    const wf = load();
    expect(classes(wf)).toEqual({
      "1": "UNETLoader",
      "2": "CLIPLoader",
      "3": "VAELoader",
      "4": "AnimaRefAdapter",
      "7": "LoadImage",
      "9": "CLIPTextEncode",
      "10": "CLIPTextEncode",
      "11": "EmptyLatentImage",
      "15": "KSampler",
      "16": "VAEDecode",
      "17": "SaveImage",
    });
    expect(animaRefGraphKind(wf)).toBe("v2");
    expect(node(wf, "4")).toEqual({
      model: ["1", 0],
      vae: ["3", 0],
      image: ["7", 0],
      lora_name: "anima_ref_adapter_v2_r64.safetensors",
      ref_guidance: 4.5,
      correction: "apg",
      strength: 1,
      ref_end: 1,
      ref_megapixels: 1,
    });
    expect(node(wf, "15")).toMatchObject({
      model: ["4", 0],
      positive: ["9", 0],
      negative: ["10", 0],
      latent_image: ["11", 0],
      steps: 30,
      cfg: 4.5,
      sampler_name: "er_sde",
      scheduler: "simple",
      denoise: 1,
    });
    expect(node(wf, "11")).toMatchObject({ width: 832, height: 1216, batch_size: 1 });
    const meta = (wf as unknown as { _meta: { description: string } })._meta;
    expect(meta.description).toMatch(/v2/);
    expect(meta.description).toMatch(/2x faster/);
    expect(meta.description).toMatch(/Non-Commercial/);
    expect(JSON.stringify(wf)).not.toMatch(/sage|KJ/i);
    expect(JSON.stringify(wf)).not.toMatch(/\/Users\/|\/home\//);
  });

  it("falls back to the pilot graph when AnimaRefAdapter is missing", async () => {
    const raw = load() as unknown as Record<string, unknown>;
    expect(raw._fallback).toMatchObject({ file: PILOT_REL });
    const pilot = loadRel(PILOT_REL) as unknown as Record<string, unknown>;
    const fixture = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "fixtures/animaRefNodes.objectInfo.json"),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    const core = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "fixtures/graphLint.objectInfo.json"),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    const full = { ...core, ...fixture };
    expect(await applyWorkflowFallback(raw, REL, full)).toBe(raw);
    const old = { ...full };
    delete old.AnimaRefAdapter;
    expect(await applyWorkflowFallback(raw, REL, old)).toEqual(pilot);
  });

  it("declares its four weights in the right folders", () => {
    expect(
      workflowModelRequirements(load()).map((r) => `${r.dir}/${r.file}`),
    ).toEqual([
      "diffusion_models/anima-base-v1.0.safetensors",
      "text_encoders/qwen_3_06b_base.safetensors",
      "vae/qwen_image_vae.safetensors",
      "loras/anima_ref_adapter_v2_r64.safetensors",
    ]);
    expect(
      workflowModelRequirements(loadRel(PILOT_REL)).map((r) => r.file),
    ).toContain("anima_ref_adapter_pilot_r32.safetensors");
  });

  it("reports the adapter LoRA + node class missing on a bare backend", () => {
    expect(
      missingAgainstObjectInfo(load(), {
        UNETLoader: { input: { required: { unet_name: [["x.safetensors"]] } } },
      }),
    ).toContain("node:AnimaRefAdapter");
    const missing = missingAgainstObjectInfo(load(), {
      AnimaRefAdapter: {
        input: { required: { lora_name: [["other.safetensors"]] } },
      },
    });
    expect(missing).toContain("loras/anima_ref_adapter_v2_r64.safetensors");
  });

  it("has sizes, repo paths and a non-commercial license for each weight", () => {
    const sizes = (modelSizes as unknown as { files: Record<string, { source: string; set: string | null; note?: string }> }).files;
    const paths = (modelRepoPaths as { files: Record<string, string> }).files;
    for (const f of [
      "anima-base-v1.0.safetensors",
      "qwen_3_06b_base.safetensors",
      "anima_ref_adapter_pilot_r32.safetensors",
      "anima_ref_adapter_v2_r64.safetensors",
    ]) {
      // Optional NC weights: outside the minimal/full sets, with a note.
      expect(sizes[f]?.set).toBeNull();
      expect(sizes[f]?.note).toMatch(/Non-Commercial/);
      expect(paths[f]).toMatch(new RegExp(`${f.replace(/\./g, "\\.")}$`));
      expect(familyFor(f)).toMatchObject({
        license: ANIMA_LICENSE,
        commercial: "no",
      });
    }
    expect(licenseUrlFor(ANIMA_LICENSE)).toBe(
      "https://huggingface.co/circlestone-labs/Anima/blob/main/LICENSE.md",
    );
  });

  it("is not part of any starter pack", () => {
    expect(JSON.stringify(starterPacks)).not.toMatch(
      /anima[-_ ]ref|anima-base|qwen_3_06b/i,
    );
  });
});

describe("anima_ref registry + builder", () => {
  it("is a registered image action with a custom builder", () => {
    const actions = registry.actions as Record<string, Record<string, unknown>>;
    expect(actions[ANIMA_REF_ACTION]).toMatchObject({
      template: ANIMA_REF_ACTION,
      requiresImage: true,
      requiresPrompt: true,
    });
    expect(actionBuilderFor(ANIMA_REF_ACTION)).toBe(buildAnimaRefWorkflow);
    expect(
      resolveWorkflow({ templateOrAction: ANIMA_REF_ACTION, packId: "krea2" })
        .workflowPath,
    ).toBe(REL);
  });

  it("v2: fills reference, prompts, size and seed (KSampler.seed)", () => {
    const base = load();
    const { workflow: wf, seed, slots } = buildAnimaRefWorkflow(base, run(), 0, {
      prompt: "1girl, solo, sitting on a bench, park, autumn",
      negative: ["text", "watermark"],
      aspect: "2:3",
      seed: 42,
    });
    expect(seed).toBe(42);
    expect(node(wf, "7").image).toBe("cj_anima_x.png [input]");
    expect(node(wf, "4").image).toEqual(["7", 0]);
    expect(node(wf, "9").text).toBe(
      `${ANIMA_QUALITY_PREFIX}1girl, solo, sitting on a bench, park, autumn`,
    );
    expect(node(wf, "10").text).toBe(
      `${ANIMA_DEFAULT_NEGATIVE}, text, watermark`,
    );
    expect(node(wf, "11")).toMatchObject({ width: 832, height: 1216 });
    expect(node(wf, "15")).toMatchObject({ seed: 42, steps: 30, cfg: 4.5 });
    expect(slots).toMatchObject({
      ksamplerId: "15",
      posTextId: "9",
      negTextId: "10",
      latentDimsId: "11",
      imageInputId: "7",
    });
    expect(Object.keys(classes(wf))).toHaveLength(11);
    // base graph untouched
    expect(base["7"].inputs.image).toBe("");
    expect(base["15"].inputs.seed).toBe(0);
  });

  it("v2: defaults to 832x1216 and a random seed; clamps guidance, cfg + steps", () => {
    const { workflow: wf, seed } = buildAnimaRefWorkflow(load(), run(), 0, {
      text: "masterpiece, 1boy, solo, running",
      steps: 99,
      ref_guidance: 6,
      cfg: 50,
    });
    expect(Number.isInteger(seed)).toBe(true);
    expect(node(wf, "15").seed).toBe(seed);
    expect(node(wf, "11")).toMatchObject({ width: 832, height: 1216 });
    expect(node(wf, "9").text).toBe("masterpiece, 1boy, solo, running");
    expect(node(wf, "15")).toMatchObject({ steps: 40, cfg: 8 });
    expect(node(wf, "4").ref_guidance).toBe(6);
    const low = buildAnimaRefWorkflow(load(), run(), 0, {
      prompt: "1girl",
      steps: 1,
      ref_guidance: 1,
      cfg: 0,
    }).workflow;
    expect(node(low, "15")).toMatchObject({ steps: 20, cfg: 1 });
    expect(node(low, "4").ref_guidance).toBe(3);
  });

  it("v2 duo: stitches the second reference on the right, landscape by default", () => {
    const { workflow: wf } = buildAnimaRefWorkflow(load(), run(), 0, {
      prompt: "2girls, the girl on the left is waving, the girl on the right is reading",
      secondRefImage: "cj_anima_ref2_b.png [input]",
      seed: 3,
    });
    const cls = classes(wf);
    const loads = Object.keys(cls).filter((k) => cls[k] === "LoadImage");
    const stitchId = Object.keys(cls).find((k) => cls[k] === "ImageStitch");
    expect(loads).toHaveLength(2);
    expect(stitchId).toBeDefined();
    const load2 = loads.find((k) => k !== "7") as string;
    expect(node(wf, load2).image).toBe("cj_anima_ref2_b.png [input]");
    expect(node(wf, stitchId as string)).toEqual({
      image1: ["7", 0],
      image2: [load2, 0],
      direction: "right",
      match_image_size: true,
      spacing_width: 0,
      spacing_color: "white",
    });
    expect(node(wf, "4").image).toEqual([stitchId, 0]);
    expect(node(wf, "11")).toMatchObject({
      width: ANIMA_DUO_WIDTH,
      height: ANIMA_DUO_HEIGHT,
    });
    // --ar wins over the landscape default
    const tall = buildAnimaRefWorkflow(load(), run(), 0, {
      prompt: "2girls",
      secondRefImage: "b.png [input]",
      aspect: "2:3",
    }).workflow;
    expect(node(tall, "11")).toMatchObject({ width: 832, height: 1216 });
  });

  it("v2 duo graph saved and re-run with one reference drops the stitch", () => {
    const duo = buildAnimaRefWorkflow(load(), run(), 0, {
      prompt: "2girls",
      secondRefImage: "b.png [input]",
    }).workflow;
    const again = buildAnimaRefWorkflow(duo, run(), 0, {
      prompt: "2girls",
      secondRefImage: "c.png [input]",
    }).workflow;
    expect(Object.values(classes(again)).filter((c) => c === "ImageStitch")).toHaveLength(1);
    expect(JSON.stringify(again)).toContain("c.png [input]");
    const single = buildAnimaRefWorkflow(duo, run(), 0, { prompt: "1girl" }).workflow;
    expect(classes(single)).toEqual(classes(load()));
    expect(node(single, "4").image).toEqual(["7", 0]);
    expect(node(single, "11")).toMatchObject({ width: 832, height: 1216 });
  });

  it("rejects a malformed second reference", () => {
    expect(() =>
      buildAnimaRefWorkflow(load(), run(), 0, {
        prompt: "2girls",
        secondRefImage: "../etc/passwd",
      }),
    ).toThrow(/secondRefImage/);
  });

  it("legacy pilot graph: same params, pilot nodes, 896x1152 default", () => {
    const pilot = loadPilot();
    expect(animaRefGraphKind(pilot)).toBe("pilot");
    expect(node(pilot, "4").lora_name).toBe(
      "anima_ref_adapter_pilot_r32.safetensors",
    );
    const { workflow: wf, seed } = buildAnimaRefWorkflow(pilot, run(), 0, {
      prompt: "1girl, solo, cafe",
      seed: 9,
      steps: 99,
      cfg: 50,
      ref_guidance: 6,
    });
    expect(seed).toBe(9);
    expect(node(wf, "7").image).toBe("cj_anima_x.png [input]");
    expect(node(wf, "9").text).toBe(`${ANIMA_QUALITY_PREFIX}1girl, solo, cafe`);
    expect(node(wf, "8")).toMatchObject({ width: 896, height: 1152 });
    expect(node(wf, "14").noise_seed).toBe(9);
    expect(node(wf, "13").steps).toBe(40);
    expect(node(wf, "11")).toMatchObject({ ref_guidance: 6, cfg: 8 });
    expect(
      node(
        buildAnimaRefWorkflow(pilot, run(), 0, { prompt: "x", aspect: "2:3" }).workflow,
        "8",
      ),
    ).toMatchObject({ width: 832, height: 1216 });
  });

  it("legacy pilot graph refuses two characters with an update hint", () => {
    expect(() =>
      buildAnimaRefWorkflow(loadPilot(), run(), 0, {
        prompt: "2girls",
        secondRefImage: "b.png [input]",
      }),
    ).toThrow(/two characters need the v2 .*update ComfyUI-Anima-Ref-Adapter/);
  });

  it("rejects a missing prompt or image", () => {
    expect(() =>
      buildAnimaRefWorkflow(load(), run(), 0, { prompt: "  " }),
    ).toThrow(/describe the scene/);
    expect(() =>
      buildAnimaRefWorkflow(load(), run([]), 0, { prompt: "1girl" }),
    ).toThrow(/reference image/);
  });

  it("size helpers", () => {
    expect(animaDims()).toEqual({ width: 832, height: 1216 });
    expect(animaDims({ aspect: "1:1" }).width).toBe(
      animaDims({ aspect: "1:1" }).height,
    );
    expect(animaDims({ width: 1000, height: 300 })).toEqual({
      width: 1024,
      height: 512,
    });
    const odd = animaDims({ aspect: "21:9" });
    expect(odd.width % 64).toBe(0);
    expect(odd.width).toBeGreaterThan(odd.height);
    expect(animaPositive("score_9, 1girl")).toBe("score_9, 1girl");
    expect(animaNegative(undefined)).toBe(ANIMA_DEFAULT_NEGATIVE);
  });
});

describe("animaRefRequest / submitAnimaRef", () => {
  it("prompt flags win over settings; square default leaves the adapter size", () => {
    expect(
      animaRefRequest("1girl, solo, beach --ar 2:3 --seed 7 --no hat", {
        aspect: "16:9",
        seed: 3,
        negative: "blur",
      }),
    ).toEqual({
      prompt: "1girl, solo, beach",
      params: {
        prompt: "1girl, solo, beach",
        aspect: "2:3",
        seed: 7,
        negative: ["hat"],
      },
    });
    expect(
      animaRefRequest("1girl, solo", { aspect: "1:1", negative: " blur " })
        .params,
    ).toEqual({ prompt: "1girl, solo", negative: ["blur"] });
    expect(() => animaRefRequest("--ar 2:3")).toThrow(/Describe the scene/);
  });

  it("two characters: the bar's aspect is ignored (landscape default), --ar still wins", () => {
    expect(
      animaRefRequest("2girls, left waves", { aspect: "2:3" }, { twoCharacters: true })
        .params,
    ).toEqual({ prompt: "2girls, left waves" });
    expect(
      animaRefRequest("2girls --ar 3:2", { aspect: "2:3" }, { twoCharacters: true })
        .params.aspect,
    ).toBe("3:2");
  });

  const upload: ToolImage = {
    id: "u",
    source: "upload",
    previewUrl: "data:image/png;base64,AAAA",
    dataUrl: "data:image/png;base64,AAAA",
    label: "ref.png",
    width: 768,
    height: 1024,
  };

  const ok = (body: unknown) => ({
    ok: true,
    status: 200,
    json: async () => body,
  });

  it("uploads, seeds a run, then queues anima_ref", async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === "/api/comfy/upload") return ok({ ok: true, ref: "cj_anima.png" });
      if (url === "/api/jobs/seed-run")
        return ok({ ok: true, run: { run_id: "seed1", jobs: [{ index: 0 }] } });
      if (url === "/api/jobs/action")
        return ok({ ok: true, run: { run_id: "out1" } });
      throw new Error(url);
    });
    const out = await submitAnimaRef({
      fetchImpl,
      image: upload,
      input: "1girl, solo, cafe --seed 5",
      settings: { aspect: "1:1" },
      clientId: "c1",
    });
    expect(out.run_id).toBe("out1");
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      "/api/comfy/upload",
      "/api/jobs/seed-run",
      "/api/jobs/action",
    ]);
    const body = JSON.parse(String(fetchImpl.mock.calls[2][1]?.body));
    expect(body).toEqual({
      run_id: "seed1",
      job_index: 0,
      action: "anima_ref",
      client_id: "c1",
      params: { prompt: "1girl, solo, cafe", seed: 5 },
    });
  });

  it("uses a gallery reference's run directly and surfaces API errors", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, error: "nope" }),
    }));
    await expect(
      submitAnimaRef({
        fetchImpl,
        image: { ...upload, source: "gallery", runId: "g1", jobIndex: 2 },
        input: "1girl",
        clientId: "c1",
      }),
    ).rejects.toThrow("nope");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/jobs/action");
    expect(JSON.parse(String(init.body))).toMatchObject({
      run_id: "g1",
      job_index: 2,
    });
  });

  it("two characters: uploads the second reference and sends secondRefImage", async () => {
    const uploads: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/comfy/upload") {
        uploads.push(JSON.parse(String(init?.body)).filename);
        return ok({
          ok: true,
          ref: uploads.length === 1 ? "cj_ref2.png [input]" : "cj_ref1.png [input]",
        });
      }
      if (url === "/api/jobs/seed-run")
        return ok({ ok: true, run: { run_id: "seed1", jobs: [{ index: 0 }] } });
      if (url === "/api/jobs/action")
        return ok({ ok: true, run: { run_id: "out2" } });
      throw new Error(url);
    });
    const out = await submitAnimaRef({
      fetchImpl,
      image: upload,
      secondImage: { ...upload, id: "u2", label: "b.png" },
      input: "2girls, the girl on the left waves, the girl on the right reads",
      settings: { aspect: "2:3" },
      clientId: "c1",
    });
    expect(out.run_id).toBe("out2");
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      "/api/comfy/upload",
      "/api/comfy/upload",
      "/api/jobs/seed-run",
      "/api/jobs/action",
    ]);
    expect(uploads[0]).toMatch(/^cj_anima_ref2_/);
    const body = JSON.parse(String(fetchImpl.mock.calls[3][1]?.body));
    expect(body.params).toEqual({
      prompt: "2girls, the girl on the left waves, the girl on the right reads",
      secondRefImage: "cj_ref2.png [input]",
    });
  });

  it("two characters: an input ref is used as-is; an unready picture is refused", async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === "/api/jobs/action")
        return ok({ ok: true, run: { run_id: "out3" } });
      throw new Error(url);
    });
    const gallery = { ...upload, source: "gallery" as const, runId: "g1", jobIndex: 0 };
    await submitAnimaRef({
      fetchImpl,
      image: gallery,
      secondImage: { ...upload, dataUrl: undefined, comfyRef: "b.png [input]" },
      input: "2girls",
      clientId: "c1",
    });
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.params.secondRefImage).toBe("b.png [input]");
    await expect(
      submitAnimaRef({
        fetchImpl,
        image: gallery,
        secondImage: { ...upload, dataUrl: undefined },
        input: "2girls",
        clientId: "c1",
      }),
    ).rejects.toThrow(/second character/);
  });

  it("validates the prompt before uploading", async () => {
    const fetchImpl = vi.fn();
    await expect(
      submitAnimaRef({ fetchImpl, image: upload, input: "  ", clientId: "c" }),
    ).rejects.toThrow(/Describe the scene/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("animaRefStore", () => {
  it("keeps the second reference behind the first", async () => {
    const { useAnimaRefStore } = await import("@/store/animaRefStore");
    const a = { id: "a" } as ToolImage;
    const b = { id: "b" } as ToolImage;
    const s = () => useAnimaRefStore.getState();
    s().setSecond(b); // no first yet: becomes the first
    expect([s().reference?.id, s().second]).toEqual(["b", null]);
    s().setReference(a);
    s().setSecond(b);
    expect([s().reference?.id, s().second?.id]).toEqual(["a", "b"]);
    s().clearReference(); // second moves up
    expect([s().reference?.id, s().second]).toEqual(["b", null]);
    s().setSecond(a);
    s().clearSecond();
    expect([s().reference?.id, s().second]).toEqual(["b", null]);
    s().setSecond(a);
    s().clear();
    expect([s().reference, s().second]).toEqual([null, null]);
  });
});
