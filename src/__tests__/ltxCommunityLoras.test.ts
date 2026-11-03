/**
 * Extra LTX LoRA (src/lib/oj/ltxCommunityLoras.ts): picker filter, the
 * LoraLoaderModelOnly graph patch on the LTX-2.5 image-in tools, registry
 * trigger injection, and the request params.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { COMFY_HTTP_URL: "http://mac:8188", COMFY_ROOT: "/nonexistent" },
}));

import type { ImagineRun, Workflow } from "@/types";
import ltxNodes from "./fixtures/ltxVfxNodes.objectInfo.json";
import { validatePrompt } from "@/lib/comfy/validatePrompt";
import {
  LTX_BUILTIN_IC_LORA_FILES,
  LTX_COMMUNITY_LORAS,
  LTX_EXTRA_LORA_PICK,
  LTX_EXTRA_LORA_TOOLS,
  LTX_TOOL_LORA_FILES,
  applyLtxExtraLora,
  isLtxLoraFile,
  ltxExtraLoraParams,
  ltxLoraChoices,
  ltxLoraLabel,
  ltxLoraStrength,
  ltxLorasFromObjectInfo,
  ltxModelChainEnd,
  staleLtxLoraPick,
  type LtxCommunityLora,
} from "@/lib/oj/ltxCommunityLoras";
import {
  buildLtx25AnimateWorkflow,
  buildLtx25TransitionWorkflow,
} from "@/lib/oj/ltx25Tools";
import { buildLtxVfxWorkflow } from "@/lib/oj/ltxVfx";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";

const PUBLIC = path.join(process.cwd(), "public/workflows");
const pack = (name: string): Workflow =>
  Object.fromEntries(
    Object.entries(
      JSON.parse(
        fs.readFileSync(path.join(PUBLIC, `packs/ltx25/${name}.json`), "utf8"),
      ) as Record<string, unknown>,
    ).filter(([k]) => !k.startsWith("_")),
  ) as Workflow;

const EXTRA = "ltx25/community/ltx-2.5-orbit-cam.safetensors";
const REG: LtxCommunityLora[] = [
  {
    file: EXTRA,
    label: "Orbit Cam",
    kind: "lora",
    trigger: "0rb1t",
    defaultStrength: 0.8,
    license: "LTX-2 Community License",
    url: "https://example.com/orbit",
  },
  {
    file: "ltx25/community/ltx-2.5-ref-thing.safetensors",
    label: "Ref thing",
    kind: "ic-lora",
    defaultStrength: 1,
    license: "LTX-2 Community License",
    url: "https://example.com/ref",
  },
];

/** object_info with EXTRA added to the LoRA list (as if installed). */
const INFO = (() => {
  const info = structuredClone(ltxNodes) as unknown as Record<
    string,
    { input: { required: Record<string, unknown[]> } }
  >;
  (info.LoraLoaderModelOnly.input.required.lora_name[0] as string[]).push(
    EXTRA,
  );
  return info;
})();

const byClass = (wf: Workflow, cls: string) =>
  Object.keys(wf).filter((id) => wf[id].class_type === cls);

const photoRun = (): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "",
    parsedPrompt: "",
    width: 1280,
    height: 720,
    createdAt: "2026-10-25T00:00:00Z",
    status: "done",
    params: {},
    jobs: [
      {
        seed: 0,
        index: 0,
        status: "done",
        progress: 100,
        images: [
          "http://127.0.0.1:8188/view?filename=photo.png&subfolder=&type=output",
        ],
      },
    ],
  }) as unknown as ImagineRun;

/** Every MODEL consumer (not a loader in the chain) reads from `id`. */
function modelConsumersFrom(wf: Workflow, id: string): boolean {
  const consumers = Object.entries(wf).filter(
    ([, n]) =>
      n.class_type !== "LoraLoaderModelOnly" &&
      Array.isArray((n.inputs as Record<string, unknown>).model),
  );
  expect(consumers.length).toBeGreaterThan(0);
  return consumers.every(
    ([, n]) => String((n.inputs.model as unknown[])[0]) === id,
  );
}

describe("ltxLoraChoices (picker filter)", () => {
  const installed = [
    "sdxl/detail.safetensors",
    "ltx25\\community\\LTX-2.5-Orbit-Cam.safetensors",
    "LTX25/community/ltx-2.5-orbit-cam.safetensors", // case duplicate
    "flux/ltxstyle-notes.txt",
    "ltx25/ltx-2.5-22b-lora-cinemagraph-0.9.safetensors",
    "ltx25/ltx-2.5-22b-lora-slow-motion-control-1.0.safetensors",
    ...LTX_BUILTIN_IC_LORA_FILES,
    "ltx25/community/someone-ic-lora-depth.safetensors",
    "ltx25/community/ltx-2.5-ref-thing.safetensors",
    "../ltx-escape.safetensors",
  ];

  it("keeps LTX-named LoRA files, case-insensitive, deduplicated", () => {
    const out = ltxLoraChoices(installed, "ltx25_animate", REG);
    expect(out).toEqual([
      "ltx25/community/LTX-2.5-Orbit-Cam.safetensors",
      "ltx25/ltx-2.5-22b-lora-cinemagraph-0.9.safetensors",
      "ltx25/ltx-2.5-22b-lora-slow-motion-control-1.0.safetensors",
    ]);
  });

  it("excludes the files the tool already loads", () => {
    const cine = ltxLoraChoices(installed, "ltx_cinemagraph", REG);
    expect(cine).not.toContain(LTX_TOOL_LORA_FILES.ltx_cinemagraph[0]);
    expect(cine).toContain(LTX_TOOL_LORA_FILES.ltx_slow_motion[0]);
    const slow = ltxLoraChoices(installed, "ltx_slow_motion", REG);
    expect(slow).not.toContain(LTX_TOOL_LORA_FILES.ltx_slow_motion[0]);
    expect(slow).toContain(LTX_TOOL_LORA_FILES.ltx_cinemagraph[0]);
  });

  it("excludes IC-LoRAs (built-in, by name, by registry kind)", () => {
    for (const tool of LTX_EXTRA_LORA_TOOLS) {
      const out = ltxLoraChoices(installed, tool, REG).join("\n");
      expect(out).not.toMatch(/ic-lora|ref-thing/);
    }
  });

  it("tool LoRA lists match what the pack graphs load", () => {
    const files = (name: string) =>
      byClass(pack(name), "LoraLoaderModelOnly").map(
        (id) => pack(name)[id].inputs.lora_name,
      );
    expect(files("vfx_cinemagraph")).toEqual(
      LTX_TOOL_LORA_FILES.ltx_cinemagraph,
    );
    expect(files("vfx_slowmo")).toEqual(LTX_TOOL_LORA_FILES.ltx_slow_motion);
    expect(files("i2v")).toEqual([]);
    expect(files("flf2v")).toEqual([]);
    for (const name of ["vfx_alpha", "vfx_clean_plate", "vfx_water"])
      for (const f of files(name))
        expect(LTX_BUILTIN_IC_LORA_FILES).toContain(f);
  });

  it("labels: registry label, else the bare file name", () => {
    expect(ltxLoraLabel(EXTRA, REG)).toBe("Orbit Cam");
    expect(ltxLoraLabel("ltx25/foo-ltx.safetensors", REG)).toBe("foo-ltx");
  });

  it("object_info extraction keeps only LTX-named files", () => {
    expect(ltxLorasFromObjectInfo(INFO)).toContain(EXTRA);
    expect(ltxLorasFromObjectInfo(null)).toEqual([]);
    expect(
      ltxLorasFromObjectInfo({
        LoraLoader: { input: { required: { lora_name: [["a.safetensors"]] } } },
      }),
    ).toEqual([]);
  });

  it("file name guard", () => {
    expect(isLtxLoraFile(EXTRA)).toBe(true);
    expect(isLtxLoraFile("sdxl/detail.safetensors")).toBe(false);
    expect(isLtxLoraFile("../ltx.safetensors")).toBe(false);
    expect(isLtxLoraFile("/abs/ltx.safetensors")).toBe(false);
    expect(isLtxLoraFile("C:/ltx.safetensors")).toBe(false);
    expect(isLtxLoraFile("ltx.json")).toBe(false);
  });

  it("stale pick: cleared once the list is known and lacks it", () => {
    const picks = { [LTX_EXTRA_LORA_PICK.lora]: EXTRA };
    expect(staleLtxLoraPick(picks, null)).toBe(false);
    expect(staleLtxLoraPick(picks, [EXTRA])).toBe(false);
    expect(staleLtxLoraPick(picks, [])).toBe(true);
    expect(staleLtxLoraPick({}, [])).toBe(false);
  });
});

describe("installed community LoRAs", () => {
  it("each has a license, card URL and an LTX file name", () => {
    expect(LTX_COMMUNITY_LORAS.length).toBeGreaterThanOrEqual(4);
    for (const l of LTX_COMMUNITY_LORAS) {
      expect(isLtxLoraFile(l.file), l.file).toBe(true);
      expect(l.license).toMatch(/^LTX-2(\.x)? Community License$/);
      expect(l.url).toMatch(/^https:\/\/huggingface\.co\//);
    }
  });

  it("only the plain LoRA (XPLDV) reaches the Extra LTX LoRA picker", () => {
    const files = LTX_COMMUNITY_LORAS.map((l) => l.file);
    const out = ltxLoraChoices(files, "ltx25_animate");
    expect(out).toEqual(["ltx25/ltx-2.5-xpldv_v5-lora.safetensors"]);
    expect(ltxLoraLabel(out[0])).toBe("Exploded View (XPLDV v5)");
    expect(ltxLoraStrength(undefined, out[0])).toBe(0.5);
    for (const l of LTX_COMMUNITY_LORAS.filter((x) => x.kind === "ic-lora"))
      expect(LTX_BUILTIN_IC_LORA_FILES).toContain(l.file);
  });
});

describe("applyLtxExtraLora (graph patch)", () => {
  it("absent: no pick, bad file, strength 0, or a file already loaded", () => {
    const base = pack("vfx_cinemagraph");
    for (const params of [
      {},
      { ltxLora: "sdxl/detail.safetensors" },
      { ltxLora: EXTRA, ltxLoraStrength: 0 },
      { ltxLora: LTX_TOOL_LORA_FILES.ltx_cinemagraph[0] },
    ]) {
      const wf = structuredClone(base);
      expect(applyLtxExtraLora(wf, params, undefined, REG)).toBeNull();
      expect(wf).toEqual(base);
    }
  });

  it("inserted after the tool's own LoRA; consumers rewired", () => {
    const wf = pack("vfx_slowmo");
    const own = ltxModelChainEnd(wf)!;
    expect(wf[own].class_type).toBe("LoraLoaderModelOnly");
    const id = applyLtxExtraLora(
      wf,
      { ltxLora: EXTRA, ltxLoraStrength: 1.5 },
      undefined,
      REG,
    )!;
    expect(wf[id]).toMatchObject({
      class_type: "LoraLoaderModelOnly",
      inputs: { model: [own, 0], lora_name: EXTRA, strength_model: 1.5 },
    });
    expect(ltxModelChainEnd(wf)).toBe(id);
    expect(modelConsumersFrom(wf, id)).toBe(true);
    expect(validatePrompt(wf, INFO as never)).toEqual([]);
  });

  it("inserted straight after UNETLoader when the graph has no LoRA", () => {
    const wf = pack("i2v");
    const [unet] = byClass(wf, "UNETLoader");
    const id = applyLtxExtraLora(wf, { ltxLora: EXTRA }, undefined, REG)!;
    expect(wf[id].inputs.model).toEqual([unet, 0]);
    // Registry default strength when none is given.
    expect(wf[id].inputs.strength_model).toBe(0.8);
    expect(modelConsumersFrom(wf, id)).toBe(true);
  });
});

describe("trigger injection", () => {
  const posOf = (wf: Workflow) =>
    byClass(wf, "CLIPTextEncode").find((id) =>
      String(wf[id].inputs.text ?? "").includes("dancer"),
    )!;

  it("prepends a known LoRA's trigger once", () => {
    const wf = pack("i2v");
    const [pos] = byClass(wf, "CLIPTextEncode");
    wf[pos].inputs.text = "a dancer spins";
    applyLtxExtraLora(wf, { ltxLora: EXTRA }, pos, REG);
    expect(wf[pos].inputs.text).toBe("0rb1t, a dancer spins");
    const again = pack("i2v");
    again[pos].inputs.text = "0RB1T shot of a dancer";
    applyLtxExtraLora(again, { ltxLora: EXTRA }, pos, REG);
    expect(again[pos].inputs.text).toBe("0RB1T shot of a dancer");
    expect(posOf(again)).toBe(pos);
  });

  it("unknown files leave the prompt alone", () => {
    const wf = pack("i2v");
    const [pos] = byClass(wf, "CLIPTextEncode");
    wf[pos].inputs.text = "a dancer spins";
    applyLtxExtraLora(wf, { ltxLora: "ltx25/other-ltx.safetensors" }, pos, REG);
    expect(wf[pos].inputs.text).toBe("a dancer spins");
  });
});

describe("builders and requests", () => {
  const params = { ltxLora: EXTRA, ltxLoraStrength: 1.2, seed: 7 };

  it("Animate / Transition / Cinemagraph / Slow Motion chain the LoRA", () => {
    const results = [
      buildLtx25AnimateWorkflow(pack("i2v"), photoRun(), 0, params).workflow,
      buildLtx25TransitionWorkflow(pack("flf2v"), photoRun(), 0, {
        ...params,
        secondRefImage: "end.png [input]",
      }).workflow,
      buildLtxVfxWorkflow(pack("vfx_cinemagraph"), photoRun(), 0, {
        ...params,
        prompt: "the waterfall",
        action: "ltx_cinemagraph",
      }).workflow,
      buildLtxVfxWorkflow(pack("vfx_slowmo"), photoRun(), 0, {
        ...params,
        prompt: "a dancer spins",
        action: "ltx_slow_motion",
      }).workflow,
    ];
    for (const wf of results) {
      const end = ltxModelChainEnd(wf)!;
      expect(wf[end].inputs.lora_name).toBe(EXTRA);
      expect(wf[end].inputs.strength_model).toBe(1.2);
      expect(modelConsumersFrom(wf, end)).toBe(true);
    }
  });

  it("builders without a pick are unchanged by the patch", () => {
    const wf = buildLtx25AnimateWorkflow(pack("i2v"), photoRun(), 0, {
      seed: 7,
    }).workflow;
    expect(byClass(wf, "LoraLoaderModelOnly")).toEqual([]);
  });

  it("video-in VFX tools ignore the param", () => {
    const clip = {
      ...photoRun(),
      params: { video_seconds: 3 },
      jobs: [
        {
          ...photoRun().jobs[0],
          images: [],
          videos: [
            "http://127.0.0.1:8188/view?filename=s.mp4&subfolder=&type=input",
          ],
        },
      ],
    } as unknown as ImagineRun;
    const wf = buildLtxVfxWorkflow(pack("vfx_alpha"), clip, 0, {
      ...params,
      action: "ltx_alpha_matte",
    }).workflow;
    expect(byClass(wf, "LoraLoaderModelOnly")).toHaveLength(1);
  });

  it("requests carry ltxLora/ltxLoraStrength only when picked", () => {
    expect(ltxExtraLoraParams({})).toEqual({});
    expect(ltxExtraLoraParams({ [LTX_EXTRA_LORA_PICK.lora]: EXTRA })).toEqual({
      ltxLora: EXTRA,
      ltxLoraStrength: 1,
    });
    expect(ltxLoraStrength("9")).toBe(2);
    expect(ltxLoraStrength("-1")).toBe(0);
    for (const id of LTX_EXTRA_LORA_TOOLS) {
      const spec = getActionTool(id as never)!;
      const settings = defaultSettings(spec);
      settings.text = "the waterfall";
      const second = id === "ltx25_transition" ? "end.png [input]" : undefined;
      const without = buildActionRequest(spec, settings, null, second);
      expect(without.params).not.toHaveProperty("ltxLora");
      settings.picks = {
        ...settings.picks,
        ltxLora: EXTRA,
        ltxLoraStrength: "0.6",
      };
      const withIt = buildActionRequest(spec, settings, null, second);
      expect(withIt.params).toMatchObject({
        ltxLora: EXTRA,
        ltxLoraStrength: 0.6,
      });
    }
  });
});
