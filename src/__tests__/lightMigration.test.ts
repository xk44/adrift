/**
 * Relight "Match a reference" (Light Migration): Qwen-Image-Edit-2509 +
 * dx8152 Light-Migration LoRA, subject = picture 1, light reference =
 * picture 2, faces keep their detail through CJImagePasteBack (relight
 * protect mode) unless the user picks Redraw.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import registry from "@/lib/oj/registry.json";
import { resolveWorkflow } from "@/lib/oj/packs";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  LIGHT_MIGRATION_ACTION,
  LIGHT_MIGRATION_PROMPT,
  buildLightMigrationWorkflow,
  lightMigrationPrompt,
} from "@/lib/oj/lightMigration";
import { routeBackend } from "@/lib/comfy/backends";
import { workflowModelRequirements } from "@/lib/tools/modelStatus";
import {
  ToolInputError,
  buildActionRequest,
  buildToolCards,
  defaultSettings,
  getActionTool,
  optionBlocksFor,
  pickBlock,
  pickerVisible,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import { actionsForTool, familyFor } from "@/lib/tools/toolsDoc";
import modelSizes from "@/lib/tools/modelSizes.json";
import modelRepoPaths from "@/lib/tools/modelRepoPaths.json";
import weightClasses from "@/lib/tools/toolWeightClasses.json";
import type { ImagineRun, Workflow } from "@/types";

const PACK = "packs/qwen-edit-2509/light_migration.json";
const LORA = "Qwen-Image-Edit-2509-Light-Migration.safetensors";
const load = (): Workflow =>
  JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "public/workflows", PACK),
      "utf-8",
    ),
  );

const IMG = "/api/comfy/view?filename=ml_mara.png&subfolder=&type=input";
const LIGHT = "ml_pip.png [input]";

const run = (images: string[] = [IMG]): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "",
    width: 1024,
    height: 1024,
    jobs: [{ seed: 1, index: 0, status: "completed", progress: 100, images }],
    createdAt: new Date().toISOString(),
    status: "completed",
    params: {},
  }) as unknown as ImagineRun;

const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(([, n]) => n.class_type === cls);

function expectLinksResolve(wf: Workflow) {
  for (const [id, node] of Object.entries(wf)) {
    for (const [k, v] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(v) && typeof v[0] === "string")
        expect(wf[v[0]], `${id}.${k} -> ${v[0]}`).toBeDefined();
    }
  }
}

const spec = getActionTool("relight")!;
const settings = (picks: Record<string, string>, text = ""): ToolSettings =>
  ({ ...defaultSettings(spec), text, picks }) as ToolSettings;

describe("light_migration registry + pack", () => {
  it("is a registry action with its own builder and graph", () => {
    const actions = registry.actions as Record<string, Record<string, unknown>>;
    const templates = registry.templates as Record<string, { file: string }>;
    expect(actions[LIGHT_MIGRATION_ACTION]).toMatchObject({
      template: LIGHT_MIGRATION_ACTION,
      requiresImage: true,
    });
    expect(templates[LIGHT_MIGRATION_ACTION].file).toBe(PACK);
    expect(actionBuilderFor(LIGHT_MIGRATION_ACTION)).toBe(
      buildLightMigrationWorkflow,
    );
    expect(VIDEO_INPUT_ACTIONS.has(LIGHT_MIGRATION_ACTION)).toBe(false);
    expect(
      resolveWorkflow({
        templateOrAction: LIGHT_MIGRATION_ACTION,
        packId: "krea2",
      }).workflowPath,
    ).toBe(PACK);
  });

  it("routes to the video host like Relight", () => {
    const prev = process.env.COMFY_VIDEO_HTTP_URL;
    process.env.COMFY_VIDEO_HTTP_URL = "http://video-host:8188";
    try {
      expect(
        routeBackend({ action: LIGHT_MIGRATION_ACTION, workflowPath: PACK }),
      ).toBe("video");
    } finally {
      if (prev === undefined) delete process.env.COMFY_VIDEO_HTTP_URL;
      else process.env.COMFY_VIDEO_HTTP_URL = prev;
    }
  });

  it("follows the comfy.org template: 4-step Lightning + LoRA 1.0, cfg 1", () => {
    const wf = load();
    const loras = byClass(wf, "LoraLoaderModelOnly").map(([, n]) => [
      n.inputs.lora_name,
      n.inputs.strength_model,
    ]);
    expect(loras).toEqual([
      ["Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors", 1],
      [LORA, 1],
    ]);
    const [, ks] = byClass(wf, "KSampler")[0];
    expect(ks.inputs).toMatchObject({
      steps: 4,
      cfg: 1,
      sampler_name: "euler",
      scheduler: "simple",
      denoise: 1,
    });
    expect(byClass(wf, "ModelSamplingAuraFlow")[0][1].inputs.shift).toBe(3);
    expect(byClass(wf, "LoadImage")).toHaveLength(2);
    expect(byClass(wf, "ReferenceLatent")).toHaveLength(4);
  });

  it("lists every weight (incl. SAM3 for face protect)", () => {
    expect(
      workflowModelRequirements(load()).map((r) => `${r.dir}/${r.file}`),
    ).toEqual(
      expect.arrayContaining([
        "diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors",
        "loras/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors",
        `loras/${LORA}`,
        "text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
        "vae/qwen_image_vae.safetensors",
        "checkpoints/sam3.1_multiplex_fp16.safetensors",
      ]),
    );
  });

  it("carries no personal paths", () => {
    const raw = fs.readFileSync(
      path.join(process.cwd(), "public/workflows", PACK),
      "utf-8",
    );
    expect(raw).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\\\/);
  });
});

describe("buildLightMigrationWorkflow", () => {
  it("wires subject = picture 1, light = picture 2, prompt and seed", () => {
    const { workflow, slots, seed } = buildLightMigrationWorkflow(
      load(),
      run(),
      0,
      { secondRefImage: LIGHT, seed: 42 },
    );
    expect(seed).toBe(42);
    expect(workflow["1"].inputs.image).toBe("ml_mara.png [input]");
    expect(workflow["3"].inputs.image).toBe(LIGHT);
    expect(workflow["12"].inputs).toMatchObject({
      image1: ["2", 0],
      image2: ["4", 0],
      prompt: LIGHT_MIGRATION_PROMPT,
    });
    expect(workflow["20"].inputs.seed).toBe(42);
    expect(slots).toMatchObject({
      ksamplerId: "20",
      posTextId: "12",
      imageInputId: "1",
    });
    // Reference latents append in picture order: subject, then light.
    expect(workflow["16"].inputs.latent).toEqual(["14", 0]);
    expect(workflow["17"].inputs).toEqual({
      conditioning: ["16", 0],
      latent: ["15", 0],
    });
    expect(workflow["14"].inputs.pixels).toEqual(["2", 0]);
    expect(workflow["15"].inputs.pixels).toEqual(["4", 0]);
    expectLinksResolve(workflow);
  });

  it("keeps face detail by default (paste-back, relight protect)", () => {
    const { workflow } = buildLightMigrationWorkflow(load(), run(), 0, {
      secondRefImage: LIGHT,
    });
    const [pbId, pb] = byClass(workflow, "CJImagePasteBack")[0];
    expect(pb.inputs).toMatchObject({
      original: ["2", 0],
      edited: ["21", 0],
      protect: ["24", 0],
      protect_mode: "relight",
      color_match: false,
      fit: "stretch",
    });
    // Diff-only (no region): a region would switch face protect off inside it.
    expect(pb.inputs.region).toBeUndefined();
    expect(pb.inputs.diff_thresh).toBe(1);
    expect(pb.inputs.min_blob).toBe(0);
    const [, save] = byClass(workflow, "SaveImage")[0];
    expect(save.inputs.images).toEqual([pbId, 0]);
    expect(byClass(workflow, "SAM3_Detect")).toHaveLength(1);
  });

  it("Redraw drops the paste-back chain", () => {
    const { workflow } = buildLightMigrationWorkflow(load(), run(), 0, {
      secondRefImage: LIGHT,
      faceDetail: "model",
    });
    for (const gone of [
      "CJImagePasteBack",
      "SAM3_Detect",
      "CheckpointLoaderSimple",
      "CLIPTextEncode",
    ])
      expect(byClass(workflow, gone), gone).toHaveLength(0);
    expect(byClass(workflow, "SaveImage")[0][1].inputs.images).toEqual([
      "21",
      0,
    ]);
    expectLinksResolve(workflow);
  });

  it("appends details after the fixed instruction", () => {
    expect(lightMigrationPrompt("  ")).toBe(LIGHT_MIGRATION_PROMPT);
    expect(lightMigrationPrompt("keep the lamp glow")).toBe(
      `${LIGHT_MIGRATION_PROMPT}, keep the lamp glow`,
    );
    const { workflow } = buildLightMigrationWorkflow(load(), run(), 0, {
      secondRefImage: LIGHT,
      text: "keep the lamp glow",
    });
    expect(workflow["12"].inputs.prompt).toBe(
      `${LIGHT_MIGRATION_PROMPT}, keep the lamp glow`,
    );
  });

  it("rejects a missing or unsafe light reference and a missing source", () => {
    for (const bad of [undefined, "", "../x.png [input]", "x.png [output]"])
      expect(() =>
        buildLightMigrationWorkflow(load(), run(), 0, { secondRefImage: bad }),
      ).toThrow(/lighting reference/);
    expect(() =>
      buildLightMigrationWorkflow(load(), run([]), 0, {
        secondRefImage: LIGHT,
      }),
    ).toThrow(/no image/);
  });
});

describe("Relight card: Match a reference", () => {
  it("is an option of Relight, not a separate card", () => {
    const presets = spec.pickers!.find((p) => p.key === "preset")!;
    expect(presets.options[0].id).toBe("golden_hour");
    expect(presets.options.find((o) => o.id === "reference")).toMatchObject({
      label: "Match a reference",
      requiresTool: "light_migration",
    });
    expect(spec.secondImage).toMatch(/Light reference/);
    expect(spec.secondImageOptional).toBe(true);
    const hidden = getActionTool("light_migration")!;
    expect(hidden.hidden).toBe(true);
    expect(hidden.modelCheck).toEqual({
      pack: "qwen-edit-2509",
      action: "light_migration",
    });
    const cards = buildToolCards({
      catalog: [],
      packIds: null,
      editLoras: null,
    });
    expect(cards.some((c) => c.key === "action:light_migration")).toBe(false);
    expect(actionsForTool(spec)).toEqual(
      expect.arrayContaining(["relight", "light_migration"]),
    );
  });

  it("Faces picker only shows for Match a reference", () => {
    const faces = spec.pickers!.find((p) => p.key === "faceDetail")!;
    expect(faces.options.map((o) => o.id)).toEqual(["keep", "model"]);
    expect(pickerVisible(faces, spec, settings({}))).toBe(false);
    expect(pickerVisible(faces, spec, settings({ preset: "reference" }))).toBe(
      true,
    );
  });

  it("routes to light_migration with the light reference", () => {
    expect(
      buildActionRequest(spec, settings({ preset: "reference" }), null, LIGHT),
    ).toEqual({
      action: "light_migration",
      params: { secondRefImage: LIGHT, faceDetail: "keep" },
      overrides: {},
    });
    expect(
      buildActionRequest(
        spec,
        settings({ preset: "reference", faceDetail: "model" }, "warmer"),
        null,
        LIGHT,
      ).params,
    ).toEqual({ secondRefImage: LIGHT, faceDetail: "model", text: "warmer" });
    expect(() =>
      buildActionRequest(spec, settings({ preset: "reference" }), null),
    ).toThrow(ToolInputError);
    // Presets ignore a stray second image.
    expect(
      buildActionRequest(spec, settings({ preset: "neon_night" }), null, LIGHT),
    ).toEqual({
      action: "relight",
      params: { preset: "neon_night" },
      overrides: {},
    });
  });

  it("blocks only Match a reference when the LoRA is missing", () => {
    const blocks = optionBlocksFor(spec, new Set(["qwen-edit-2509"]), null, {
      tools: {
        relight: { missing: [] },
        light_migration: { missing: [`loras/${LORA}`] },
      },
    } as never);
    expect(Object.keys(blocks?.preset ?? {})).toEqual(["reference"]);
    const card = { optionBlocks: blocks };
    expect(pickBlock(card, spec, settings({ preset: "reference" }))).toBe(
      blocks!.preset.reference,
    );
    expect(pickBlock(card, spec, settings({}))).toBeNull();
  });

  it("builds end to end from the card", () => {
    const req = buildActionRequest(
      spec,
      settings({ preset: "reference" }),
      null,
      LIGHT,
    );
    const { workflow } = actionBuilderFor(req.action)!(
      load(),
      run(),
      0,
      req.params,
    );
    expect(workflow["3"].inputs.image).toBe(LIGHT);
    expect(byClass(workflow, "CJImagePasteBack")).toHaveLength(1);
  });
});

describe("license + download metadata", () => {
  it("Apache-2.0, commercial OK (open badge)", () => {
    expect(familyFor(`loras/${LORA}`)).toMatchObject({
      id: "qwen-light-migration",
      license: "Apache-2.0",
      commercial: "yes",
    });
    const classes = (weightClasses as { classes: Record<string, string> })
      .classes;
    expect(classes["action:light_migration"]).toBe("open");
    expect(classes["action:relight"]).toBe("open");
  });

  it("size + repo path match the pinned Comfy-Org repack", () => {
    const sizes = (
      modelSizes as unknown as {
        files: Record<string, { bytes: number; source: string }>;
      }
    ).files;
    expect(sizes[LORA]).toMatchObject({
      bytes: 236117032,
      source: "Comfy-Org/Qwen-Image-Edit",
    });
    const paths = (
      modelRepoPaths as unknown as { files: Record<string, string> }
    ).files;
    expect(paths[LORA]).toBe(`split_files/loras/${LORA}`);
  });
});
