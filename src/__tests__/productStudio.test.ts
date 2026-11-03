/**
 * Product Studio (FLUX 3 flagship): card definition, look prompts, and the
 * graph every look / packshot routes to (FLUX.3 Klein only, base settings).
 */
import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { buildWorkflowForAction } from "@/lib/oj/actionWorkflow";
import { parseImagineInput } from "@/lib/oj/parser";
import registry from "@/lib/oj/registry.json";
import { buildHubCards } from "@/lib/tools/hub";
import { FEATURED_KEYS, NEW_KEYS, featuredCards } from "@/lib/tools/hubVisuals";
import {
  DEFAULT_HEADLINE,
  PRODUCT_LOOKS,
  PRODUCT_STUDIO_ANIMATE_KEY,
  PRODUCT_STUDIO_KEY,
  PRODUCT_STUDIO_T2I_WORKFLOW,
  animateHandoff,
  cleanHeadline,
  compileLookPrompt,
  compilePackshotPrompt,
  generatePackshot,
  packshotRequest,
  productLookRequest,
  productStudioCard,
  submitProductLook,
} from "@/lib/tools/productStudio";
import type { ImagineRun, Workflow } from "@/types";

const WORKFLOWS = path.join(process.cwd(), "public", "workflows");
type G = Record<
  string,
  { class_type: string; inputs: Record<string, unknown> }
>;

function load(rel: string): G {
  const g = JSON.parse(fs.readFileSync(path.join(WORKFLOWS, rel), "utf-8"));
  delete g._meta;
  return g;
}

const sourceRun = {
  run_id: "run-p",
  prompt: "tin",
  parsedPrompt: "tin",
  width: 896,
  height: 1120,
  jobs: [
    {
      seed: 1,
      index: 0,
      status: "done",
      progress: 100,
      images: ["/view?filename=tin.png&subfolder=qa&type=input"],
      prompt_id: "p-p",
    },
  ],
  createdAt: new Date().toISOString(),
  status: "done",
  params: {},
} as unknown as ImagineRun;

const unets = (g: G) =>
  Object.values(g)
    .filter((n) => /UNETLoader|CheckpointLoader/.test(n.class_type))
    .map((n) => n.inputs.unet_name ?? n.inputs.ckpt_name);

describe("Product Studio card", () => {
  it("names FLUX 3, needs the flux3 pack and carries the license class", () => {
    const ok = productStudioCard({
      catalog: null,
      packIds: new Set(["flux3"]),
      editLoras: null,
    });
    expect(ok.key).toBe(PRODUCT_STUDIO_KEY);
    expect(ok.kind).toBe("special");
    expect(ok.subtitle).toContain("FLUX 3");
    expect(ok.model).toMatch(/^FLUX\.3 Klein/);
    expect(ok.available).toBe(true);
    expect(ok.weights).toBe("cap");
    expect(ok.hubCategory).toBe("Ads");

    const missing = productStudioCard({
      catalog: null,
      packIds: new Set(["ltx25"]),
      editLoras: null,
    });
    expect(missing.available).toBe(false);
    expect(missing.unavailableReason).toContain("flux3");
    const checking = productStudioCard({
      catalog: null,
      packIds: null,
      editLoras: null,
    });
    expect(checking.checking).toBe(true);
    expect(checking.unavailableReason).toBeNull();
  });

  it("is in the hub, the featured row (replacing Shorts Studio) and New", () => {
    const cards = buildHubCards({
      toolCards: [],
      ctx: {
        catalog: null,
        packIds: new Set(["ltx25", "wan22", "flux3"]),
        editLoras: null,
      },
    });
    expect(cards.filter((c) => c.key === PRODUCT_STUDIO_KEY)).toHaveLength(1);
    expect(FEATURED_KEYS).toHaveLength(5);
    expect(FEATURED_KEYS).toContain(PRODUCT_STUDIO_KEY);
    expect(FEATURED_KEYS).not.toContain("special:shorts_studio");
    expect(featuredCards(cards).map((c) => c.key)).toContain(
      PRODUCT_STUDIO_KEY,
    );
    expect(NEW_KEYS.has(PRODUCT_STUDIO_KEY)).toBe(true);
  });
});

describe("look prompts", () => {
  it("has the four looks, each a full caption anchored on image 1", () => {
    expect(PRODUCT_LOOKS.map((l) => l.id)).toEqual([
      "studio",
      "lifestyle",
      "billboard",
      "flatlay",
    ]);
    for (const l of PRODUCT_LOOKS) {
      const p = compileLookPrompt(l.id);
      expect(p).toContain("the exact product from image 1");
      expect(p).toContain("Keep the product identical to image 1");
      expect(p.length).toBeGreaterThan(200);
      expect(l.motion.length).toBeGreaterThan(0);
    }
    expect(compileLookPrompt("flatlay")).toMatch(/directly from above/);
  });

  it("names the product when described", () => {
    expect(
      compileLookPrompt("studio", { product: "a beige tin of balm" }),
    ).toContain("image 1 (a beige tin of balm)");
  });

  it("billboard quotes the headline in curly quotes the parser keeps", () => {
    const p = compileLookPrompt("billboard", {
      headline: 'Glow "on" --ar 1:1',
    });
    expect(p).toContain("“Glow on ar 1:1”");
    // What the action route injects: the headline survives the parser.
    expect(parseImagineInput(p).prompt).toContain("“Glow on ar 1:1”");
    expect(compileLookPrompt("billboard")).toContain(`“${DEFAULT_HEADLINE}”`);
    expect(cleanHeadline("x".repeat(80))).toHaveLength(40);
    expect(cleanHeadline("   ")).toBe(DEFAULT_HEADLINE);
  });

  it("packshot prompt needs a description and asks for 4:5", () => {
    expect(() => compilePackshotPrompt("  ")).toThrow();
    const p = compilePackshotPrompt("a blue glass bottle");
    expect(p).toContain("a blue glass bottle");
    expect(parseImagineInput(p).params.ar).toBe("4:5");
  });
});

describe("routing: FLUX.3 Klein is the only image model", () => {
  it("every look is the flux3 edit action at 50 steps, CFG 1", () => {
    for (const l of PRODUCT_LOOKS) {
      const req = productLookRequest(l.id);
      expect(req.action).toBe("edit_flux3");
      expect(req.params.pack_id).toBe("flux3");
      expect(req.workflow_control_overrides).toEqual({
        "7.steps": 50,
        "7.cfg": 1,
      });
    }
    const actions = registry.actions as Record<string, { template?: string }>;
    const templates = registry.templates as Record<string, { file: string }>;
    expect(templates[actions.edit_flux3.template!].file).toBe(
      "packs/flux3/edit.json",
    );
  });

  it("the built look graph loads only the FLUX.3 base model", () => {
    const req = productLookRequest("billboard", { headline: "Glow on." });
    const built = buildWorkflowForAction(
      req.action,
      { ...req.params, seed: 7 },
      {
        baseWorkflow: load("packs/flux3/edit.json") as unknown as Workflow,
        sourceRun,
        overrides: req.workflow_control_overrides,
      },
    );
    const w = built.workflow as unknown as G;
    expect(unets(w)).toEqual(["flux3_image_klein_bf16.safetensors"]);
    expect(w["7"].inputs.steps).toBe(50);
    expect(w["7"].inputs.cfg).toBe(1);
    expect(w["7"].inputs.seed).toBe(7);
    expect(w["11"].inputs.image).toBe("qa/tin.png [input]");
    expect(w["17"].class_type).toBe("ReferenceMultiLatent");
    expect(w["4"].inputs.text).toContain("“Glow on.”");
  });

  it("the packshot is the flux3 t2i graph at 50 steps", async () => {
    vi.stubEnv("CJ_FLUX3", "1");
    vi.resetModules();
    const packs = await import("@/lib/oj/packs");
    expect(
      packs.resolveWorkflow({ templateOrAction: "edit_flux3", packId: "flux3" })
        .workflowPath,
    ).toBe("packs/flux3/edit.json");
    vi.unstubAllEnvs();

    const body = packshotRequest("a blue glass bottle", "c1");
    expect(body.workflow_path).toBe(PRODUCT_STUDIO_T2I_WORKFLOW);
    expect(body.workflow_control_overrides["7.steps"]).toBe(50);
    const t2i = load(PRODUCT_STUDIO_T2I_WORKFLOW);
    expect(unets(t2i)).toEqual(["flux3_image_klein_bf16.safetensors"]);
    expect(t2i["7"].class_type).toBe("KSampler");
  });
});

describe("runner helpers", () => {
  const okJson = (data: unknown) => ({
    ok: true,
    status: 200,
    json: async () => data,
  });

  it("seeds the source once and queues one flux3 action per look", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url, body });
      if (url === "/api/jobs/action")
        return okJson({ run: { run_id: `r${calls.length}`, jobs: [] } });
      throw new Error(`unexpected ${url}`);
    });
    const prepared = {};
    const image = {
      id: "g",
      source: "gallery" as const,
      previewUrl: "/x.png",
      label: "tin",
      width: 896,
      height: 1120,
      runId: "src",
      jobIndex: 0,
    };
    for (const look of ["studio", "billboard"] as const) {
      await submitProductLook({
        fetchImpl,
        image,
        look,
        headline: "Glow on.",
        clientId: "c1",
        prepared,
      });
    }
    expect(calls.map((c) => c.url)).toEqual([
      "/api/jobs/action",
      "/api/jobs/action",
    ]);
    for (const c of calls) {
      expect(c.body.run_id).toBe("src");
      expect(c.body.action).toBe("edit_flux3");
      expect((c.body.params as { pack_id: string }).pack_id).toBe("flux3");
      expect(c.body.workflow_control_overrides).toEqual({
        "7.steps": 50,
        "7.cfg": 1,
      });
    }
  });

  it("prompt mode renders the packshot and returns it as a gallery image", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "/api/jobs/imagine")
        return okJson({
          runs: [
            {
              run_id: "pk",
              width: 896,
              height: 1120,
              jobs: [{ index: 0, prompt_id: "pid" }],
            },
          ],
        });
      if (url.startsWith("/api/comfy/history/"))
        return okJson({
          status: { status_str: "success" },
          images: [{ filename: "a.png", url: "/view?filename=a.png" }],
        });
      throw new Error(`unexpected ${url}`);
    });
    const img = await generatePackshot(
      { fetchImpl, clientId: "c1", sleep: async () => {} },
      "a blue glass bottle",
    );
    expect(img).toMatchObject({
      source: "gallery",
      runId: "pk",
      jobIndex: 0,
      width: 896,
      height: 1120,
    });
  });

  it("hands a finished look to the LTX-2.5 Animate card", () => {
    const h = animateHandoff({
      runId: "r1",
      jobIndex: 0,
      url: "/view?filename=a.png",
      label: "Studio",
      width: 896,
      height: 1120,
      now: 5,
    });
    expect(h.toolKey).toBe(PRODUCT_STUDIO_ANIMATE_KEY);
    expect(PRODUCT_STUDIO_ANIMATE_KEY).toBe("action:ltx25_animate");
    expect(h).toMatchObject({ media: "image", runId: "r1", at: 5 });
  });
});
