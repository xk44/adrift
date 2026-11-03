/**
 * Shots (9 coverage views) and Zooms (9-step zoom ladder): one
 * Qwen-Image-Edit-2509 + Multiple-Angles LoRA graph, builder, registry and
 * tool wiring.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import registry from "@/lib/oj/registry.json";
import { resolveWorkflow } from "@/lib/oj/packs";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  SHOTS_ACTION,
  SHOT_VIEWS,
  ZOOMS_ACTION,
  buildShotsWorkflow,
  buildZoomsWorkflow,
  multiShotPrompts,
  zoomViews,
} from "@/lib/oj/multiShot";
import { routeBackend } from "@/lib/comfy/backends";
import { workflowModelRequirements } from "@/lib/tools/modelStatus";
import { buildActionRequest, getActionTool } from "@/lib/tools/toolsPage";
import type { ImagineRun, Workflow } from "@/types";

const WORKFLOWS_DIR = path.join(process.cwd(), "public/workflows");
const FILE = "packs/qwen-edit-2509/multi_shot.json";
const load = (): Workflow => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(WORKFLOWS_DIR, FILE), "utf-8"),
  );
  delete raw._meta;
  return raw;
};

const run = (images: string[]): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "a fox in snow",
    width: 1024,
    height: 1024,
    jobs: [
      {
        seed: 11,
        index: 0,
        status: "completed",
        progress: 100,
        images,
      },
    ],
    createdAt: new Date().toISOString(),
    status: "completed",
    params: {},
  }) as unknown as ImagineRun;

const IMG = "/api/comfy/view?filename=fox.png&subfolder=&type=output";

const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf)
    .filter(([, n]) => n.class_type === cls)
    .sort(([a], [b]) => Number(a) - Number(b));

const encoderOf = (wf: Workflow, samplerId: string) => {
  const ref = wf[(wf[samplerId].inputs.positive as [string, number])[0]];
  expect(ref.class_type).toBe("ReferenceLatent");
  return wf[(ref.inputs.conditioning as [string, number])[0]];
};

function expectLinksResolve(wf: Workflow) {
  for (const [id, node] of Object.entries(wf)) {
    for (const [k, v] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(v) && typeof v[0] === "string") {
        expect(wf[v[0]], `${id}.${k} → ${v[0]}`).toBeDefined();
      }
    }
  }
}

describe("multi_shot graph", () => {
  it("has nine sampler branches sharing one source latent", () => {
    const wf = load();
    const samplers = byClass(wf, "KSampler");
    expect(samplers).toHaveLength(9);
    const latents = new Set(
      samplers.map(([, n]) => JSON.stringify(n.inputs.latent_image)),
    );
    expect(latents.size).toBe(1);
    for (const [id, ks] of samplers) {
      expect(ks.inputs).toMatchObject({ steps: 4, cfg: 1 });
      expect(encoderOf(wf, id).class_type).toBe("TextEncodeQwenImageEditPlus");
    }
    expectLinksResolve(wf);
  });

  it("saves the contact sheet before the view batch (sheet = first image)", () => {
    const saves = byClass(load(), "SaveImage").map(([id]) => Number(id));
    expect(saves).toEqual([20, 21]);
    const wf = load();
    expect(wf["20"].inputs.filename_prefix).toMatch(/sheet$/);
    expect(wf["21"].inputs.filename_prefix).toMatch(/view$/);
  });

  it("needs only 2509 + Lightning + Multiple-Angles weights", () => {
    expect(
      workflowModelRequirements(load()).map((r) => `${r.dir}/${r.file}`),
    ).toEqual([
      "diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors",
      "loras/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors",
      "loras/qwen-image-edit-2511-multiple-angles-lora.safetensors",
      "text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
      "vae/qwen_image_vae.safetensors",
    ]);
  });

  it("carries no personal paths", () => {
    const raw = fs.readFileSync(path.join(WORKFLOWS_DIR, FILE), "utf-8");
    expect(raw).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\\\/);
  });
});

describe("builders", () => {
  it("shots: image, nine prompts in order, consecutive seeds, prefixes", () => {
    const { workflow, seed, slots } = buildShotsWorkflow(
      load(),
      run([IMG]),
      0,
      { seed: 100 },
    );
    expect(seed).toBe(100);
    expect(byClass(workflow, "LoadImage")[0][1].inputs.image).toBe(
      "fox.png [output]",
    );
    const samplers = byClass(workflow, "KSampler");
    samplers.forEach(([id, ks], k) => {
      expect(ks.inputs.seed).toBe(100 + k);
      const enc = encoderOf(workflow, id);
      expect(enc.inputs.prompt).toBe(SHOT_VIEWS[k].prompt);
      expect(enc._meta?.title).toBe(SHOT_VIEWS[k].label);
      expect(String(enc.inputs.prompt)).toMatch(/^<sks> /);
    });
    expect(slots.ksamplerId).toBe(samplers[0][0]);
    expect(workflow["20"].inputs.filename_prefix).toBe("CJ_Shots/sheet");
    expect(workflow["21"].inputs.filename_prefix).toBe("CJ_Shots/view");
    expectLinksResolve(workflow);
  });

  it("shots: extra direction is appended to every prompt", () => {
    const views = multiShotPrompts(SHOTS_ACTION, {
      text: "  warm evening light ",
    });
    expect(views.map((v) => v.id)).toEqual([
      "establishing",
      "wide",
      "medium",
      "close_up",
      "over_shoulder",
      "low_angle",
      "high_angle",
      "profile",
      "detail",
    ]);
    for (const v of views) expect(v.prompt).toMatch(/ warm evening light\.$/);
    expect(new Set(views.map((v) => v.prompt)).size).toBe(9);
  });

  it("zooms: ladder order, default and custom target", () => {
    const def = zoomViews();
    expect(def.map((v) => v.id)).toEqual([
      "extreme_wide",
      "very_wide",
      "wide",
      "medium_wide",
      "medium",
      "medium_close",
      "close_up",
      "extreme_close",
      "macro",
    ]);
    expect(def[8].prompt).toMatch(/single eye/);
    const custom = multiShotPrompts(ZOOMS_ACTION, { target: "the necklace" });
    expect(custom[6].prompt).toMatch(/the necklace fills most of the frame/);
    expect(custom[8].prompt).toMatch(/finest detail of the necklace/);
    expect(custom[0].prompt).toBe(def[0].prompt);

    const { workflow } = buildZoomsWorkflow(load(), run([IMG]), 0, {
      seed: 2 ** 32 - 1,
      target: "the necklace",
    });
    const samplers = byClass(workflow, "KSampler");
    expect(samplers[0][1].inputs.seed).toBe(2 ** 32 - 1);
    expect(samplers[1][1].inputs.seed).toBe(0);
    expect(encoderOf(workflow, samplers[8][0]).inputs.prompt).toBe(
      custom[8].prompt,
    );
    expect(workflow["20"].inputs.filename_prefix).toBe("CJ_Zooms/sheet");
    expect(workflow["21"].inputs.filename_prefix).toBe("CJ_Zooms/view");
  });

  it("throws without a source image or with a mismatched graph", () => {
    expect(() => buildShotsWorkflow(load(), run([]), 0, {})).toThrow(
      /no image/,
    );
    const wf = load();
    delete wf["180"];
    delete wf["181"];
    delete wf["182"];
    expect(() => buildShotsWorkflow(wf, run([IMG]), 0, {})).toThrow(
      /9 KSampler branches/,
    );
    expect(() => multiShotPrompts("nope")).toThrow(/unknown action/);
  });
});

describe("wiring", () => {
  const actions = registry.actions as Record<string, Record<string, unknown>>;
  const templates = registry.templates as Record<string, { file: string }>;

  it.each([SHOTS_ACTION, ZOOMS_ACTION])("%s registered", (action) => {
    expect(actions[action]).toMatchObject({
      template: action,
      requiresImage: true,
    });
    expect(templates[action].file).toBe(FILE);
    expect(actionBuilderFor(action)).toBeTypeOf("function");
    expect(VIDEO_INPUT_ACTIONS.has(action)).toBe(false);
    expect(
      resolveWorkflow({ templateOrAction: action, packId: "krea2" })
        .workflowPath,
    ).toBe(FILE);
  });

  it("routes to the video host when one is configured", () => {
    const prev = process.env.COMFY_VIDEO_HTTP_URL;
    process.env.COMFY_VIDEO_HTTP_URL = "http://video-host:8188";
    try {
      expect(routeBackend({ action: SHOTS_ACTION, workflowPath: FILE })).toBe(
        "video",
      );
    } finally {
      if (prev === undefined) delete process.env.COMFY_VIDEO_HTTP_URL;
      else process.env.COMFY_VIDEO_HTTP_URL = prev;
    }
  });

  it("tool cards gate on model status and map text", () => {
    const settings = (text: string) =>
      ({ text, picks: {} }) as unknown as Parameters<
        typeof buildActionRequest
      >[1];
    for (const id of ["shots", "zooms"]) {
      const spec = getActionTool(id)!;
      expect(spec.modelCheck).toEqual({ pack: "qwen-edit-2509", action: id });
      expect(spec.requireStatusEntry).toBe(true);
    }
    expect(
      buildActionRequest(getActionTool("shots")!, settings(""), null),
    ).toEqual({ action: "shots", params: {}, overrides: {} });
    expect(
      buildActionRequest(getActionTool("shots")!, settings("rainy"), null)
        .params,
    ).toEqual({ text: "rainy" });
    expect(
      buildActionRequest(getActionTool("zooms")!, settings("the ring"), null)
        .params,
    ).toEqual({ target: "the ring" });
  });
});
