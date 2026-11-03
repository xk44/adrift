/**
 * h3Speed: lightx2v MiniMax-H3 Turbo LoRA + MiniMaxH3SigmaShift inserted into
 * H3 video graphs (src/lib/oj/h3Speed.ts).
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { Workflow } from "@/types";
import { applyH3ExtraLoras } from "@/lib/oj/h3Video";
import {
  FASTH3_FL2V_UNET,
  FASTH3_RECIPES,
  FASTH3_REF2V_UNET,
  H3_SIGMA_SHIFT_NODE,
  H3_TURBO_FL2V_4,
  H3_TURBO_FL2V_8,
  H3_TURBO_REF2V_4,
  H3_TURBO_REF2V_8,
  applyH3Speed,
  h3FastUnetFor,
  h3SpeedLoraFor,
  parseH3Speed,
  requestedH3Speed,
} from "@/lib/oj/h3Speed";
import {
  buildOrbit360Workflow,
  buildTransitionWorkflow,
} from "@/lib/oj/h3ImageVideo";
import { parseImagineInput } from "@/lib/oj/parser";
import type { ImagineRun } from "@/types";

const load = (dir: string, name: string): Workflow => {
  const wf = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "public/workflows/packs", dir, `${name}.json`),
      "utf-8",
    ),
  );
  delete wf._meta;
  return wf;
};
const h3 = (name: string) => load("minimax", name);

const idOf = (wf: Workflow, cls: string) =>
  Object.keys(wf).find((id) => wf[id].class_type === cls)!;
const inputsOf = (wf: Workflow, cls: string) =>
  wf[idOf(wf, cls)].inputs as Record<string, unknown>;
const ofClass = (wf: Workflow, cls: string) =>
  Object.keys(wf).filter((id) => wf[id].class_type === cls);
const loraFiles = (wf: Workflow) =>
  ofClass(wf, "LoraLoaderModelOnly").map((id) => wf[id].inputs.lora_name);

/** Walk the MODEL chain upstream from `id` to the UNET (ids, tail first). */
function chainFrom(wf: Workflow, id: string): string[] {
  const out: string[] = [];
  let cur: string | null = id;
  while (cur) {
    out.push(cur);
    const m: unknown = wf[cur].inputs.model;
    cur = Array.isArray(m) ? String(m[0]) : null;
  }
  return out;
}

describe("parseH3Speed", () => {
  it("accepts names and 8 / 4 aliases", () => {
    expect(parseH3Speed("turbo8")).toBe("turbo8");
    expect(parseH3Speed("8")).toBe("turbo8");
    expect(parseH3Speed(8)).toBe("turbo8");
    expect(parseH3Speed("turbo4")).toBe("turbo4");
    expect(parseH3Speed("4")).toBe("turbo4");
    expect(parseH3Speed("off")).toBe("off");
    expect(parseH3Speed(undefined)).toBeUndefined();
    expect(parseH3Speed("balanced")).toBeUndefined();
    expect(requestedH3Speed({})).toBe("off");
    // --speed (parsed as mossSpeed) works on H3 graphs too
    expect(requestedH3Speed({ mossSpeed: "4" })).toBe("turbo4");
    expect(requestedH3Speed({ mossSpeed: "balanced" })).toBe("off");
  });
  it("the --h3speed flag parses to h3Speed", () => {
    const parsed = parseImagineInput(
      "a cat --video --packId minimax --h3speed 4",
    );
    expect(parsed.params.h3Speed).toBe("4");
  });
});

describe("applyH3Speed", () => {
  it("t2v: Turbo LoRA -> SigmaShift tail, 8 steps simple, euler", () => {
    const wf = h3("t2v");
    const ids = applyH3Speed(wf, { h3Speed: "turbo8" });
    expect(ids).toHaveLength(2);
    const [lora, shift] = ids;
    expect(wf[lora].class_type).toBe("LoraLoaderModelOnly");
    expect(wf[lora].inputs).toMatchObject({
      model: ["1", 0],
      lora_name: H3_TURBO_FL2V_8,
      strength_model: 1,
    });
    expect(wf[shift]).toMatchObject({
      class_type: H3_SIGMA_SHIFT_NODE,
      inputs: { model: [lora, 0], shift_video: 6, shift_audio: 3 },
    });
    expect(inputsOf(wf, "BasicGuider").model).toEqual([shift, 0]);
    const sched = inputsOf(wf, "BasicScheduler");
    expect(sched.model).toEqual([shift, 0]);
    expect(sched.steps).toBe(8);
    expect(sched.scheduler).toBe("simple");
    expect(inputsOf(wf, "KSamplerSelect").sampler_name).toBe("euler");
  });
  it("turbo4 on i2v uses the fl2v 4-step file and 4 steps", () => {
    const wf = h3("i2v");
    applyH3Speed(wf, { h3Speed: "4" });
    expect(loraFiles(wf)).toEqual([H3_TURBO_FL2V_4]);
    expect(inputsOf(wf, "BasicScheduler").steps).toBe(4);
  });
  it("r2v picks the ref2v files (8-step v1.0)", () => {
    const wf = h3("r2v");
    applyH3Speed(wf, { h3Speed: "turbo8" });
    expect(loraFiles(wf)).toEqual([H3_TURBO_REF2V_8]);
    expect(H3_TURBO_REF2V_8).toMatch(/_v1\.0_/);
    const wf4 = h3("r2v");
    applyH3Speed(wf4, { h3Speed: "turbo4" });
    expect(loraFiles(wf4)).toEqual([H3_TURBO_REF2V_4]);
  });
  it("keeps graph LoRAs ahead of the Turbo LoRA (orbit_360)", () => {
    const wf = h3("orbit_360");
    const [lora, shift] = applyH3Speed(wf, { h3Speed: "turbo8" });
    expect(chainFrom(wf, shift)).toEqual([shift, lora, "16", "1"]);
  });
  it("character_swap / face_swap (graph-pinned Turbo LoRA) are untouched", () => {
    for (const name of ["character_swap", "face_swap"]) {
      const wf = h3(name);
      const before = JSON.stringify(wf);
      expect(h3SpeedLoraFor(wf, { h3Speed: "turbo8" }), name).toBeNull();
      expect(applyH3Speed(wf, { h3Speed: "turbo8" }), name).toEqual([]);
      expect(JSON.stringify(wf), name).toBe(before);
    }
  });
  it("non-H3 graphs are untouched", () => {
    const wf = load("moss-image", "t2i");
    const before = JSON.stringify(wf);
    expect(applyH3Speed(wf, { h3Speed: "turbo8" })).toEqual([]);
    expect(JSON.stringify(wf)).toBe(before);
  });
  it("off / unset is a no-op", () => {
    const wf = h3("t2v");
    const before = JSON.stringify(wf);
    expect(applyH3Speed(wf, {})).toEqual([]);
    expect(applyH3Speed(wf, { h3Speed: "off" })).toEqual([]);
    expect(JSON.stringify(wf)).toBe(before);
  });
  it("is idempotent", () => {
    const wf = h3("t2v");
    applyH3Speed(wf, { h3Speed: "turbo8" });
    const once = JSON.stringify(wf);
    expect(applyH3Speed(wf, { h3Speed: "turbo8" })).toEqual([]);
    expect(JSON.stringify(wf)).toBe(once);
    expect(ofClass(wf, H3_SIGMA_SHIFT_NODE)).toHaveLength(1);
  });
  it("an explicit numeric steps param wins", () => {
    const wf = h3("t2v");
    applyH3Speed(wf, { h3Speed: "turbo8", steps: 12 });
    expect(inputsOf(wf, "BasicScheduler").steps).toBe(20);
    expect(inputsOf(wf, "KSamplerSelect").sampler_name).toBe("euler");
  });
  it("reuses an existing SigmaShift and sets CFGGuider cfg to 1", () => {
    const wf = h3("t2v");
    wf["30"] = {
      class_type: H3_SIGMA_SHIFT_NODE,
      inputs: { model: ["1", 0], shift_video: 12, shift_audio: 3 },
    } as Workflow[string];
    wf["9"] = {
      class_type: "CFGGuider",
      inputs: {
        model: ["30", 0],
        positive: ["5", 0],
        negative: ["5", 0],
        cfg: 4,
      },
    } as Workflow[string];
    inputsOf(wf, "BasicScheduler").model = ["30", 0];
    const ids = applyH3Speed(wf, { h3Speed: "turbo8" });
    expect(ids).toHaveLength(1);
    expect(ofClass(wf, H3_SIGMA_SHIFT_NODE)).toEqual(["30"]);
    expect(wf["30"].inputs).toMatchObject({
      model: [ids[0], 0],
      shift_video: 6,
      shift_audio: 3,
    });
    expect(wf[ids[0]].inputs.model).toEqual(["1", 0]);
    expect(inputsOf(wf, "CFGGuider").cfg).toBe(1);
    expect(inputsOf(wf, "CFGGuider").model).toEqual(["30", 0]);
  });
});

describe("h3Speed fast8 (FastH3 distilled DiT)", () => {
  const seedRun = {
    run_id: "seed-img",
    prompt: "",
    parsedPrompt: "",
    width: 1024,
    height: 1024,
    createdAt: new Date().toISOString(),
    status: "done",
    jobs: [
      {
        seed: 0,
        index: 0,
        status: "done",
        progress: 100,
        images: [
          "http://127.0.0.1:8188/view?filename=src.png&subfolder=cj&type=input",
        ],
      },
    ],
    params: { seed_upload: true },
  } as ImagineRun;

  /** Model chain (class names, tail first) feeding the guider. */
  const guiderChain = (wf: Workflow) =>
    chainFrom(
      wf,
      String((inputsOf(wf, "BasicGuider").model as unknown[])[0]),
    ).map((id) => wf[id].class_type);
  const FAST_CHAIN = [
    "BlockSparseAttention",
    "ModelAttentionBackend",
    H3_SIGMA_SHIFT_NODE,
    "UNETLoader",
  ];

  it("parses fast8 aliases, but never from a bare MOSS --speed fast", () => {
    for (const v of ["fast8", "fast-8", "FastH3", "fast_h3"])
      expect(parseH3Speed(v), v).toBe("fast8");
    expect(parseH3Speed("fast")).toBeUndefined();
    expect(requestedH3Speed({ mossSpeed: "fast" })).toBe("off");
    expect(requestedH3Speed({ h3Speed: "fast8" })).toBe("fast8");
  });

  it("t2v / i2v / transition: fastvideo DiT + the core fl2v template recipe", () => {
    const transition = buildTransitionWorkflow(h3("transition"), seedRun, 0, {
      secondRefImage: "end.png [input]",
      h3Speed: "fast8",
    }).workflow;
    const t2v = h3("t2v");
    const i2v = h3("i2v");
    expect(applyH3Speed(t2v, { h3Speed: "fast8" })).toHaveLength(3);
    expect(applyH3Speed(i2v, { h3Speed: "fast8" })).toHaveLength(3);
    for (const [name, wf] of Object.entries({ t2v, i2v, transition })) {
      expect(inputsOf(wf, "UNETLoader").unet_name, name).toBe(FASTH3_FL2V_UNET);
      expect(guiderChain(wf), name).toEqual(FAST_CHAIN);
      expect(inputsOf(wf, H3_SIGMA_SHIFT_NODE), name).toMatchObject({
        shift_video: 10,
        shift_audio: 3,
      });
      expect(inputsOf(wf, "ModelAttentionBackend").attention, name).toBe(
        "comfy kitchen attention",
      );
      expect(inputsOf(wf, "BlockSparseAttention"), name).toMatchObject({
        selection: "vsa",
        "selection.keep_percent": 10,
        start_percent: 0.2,
        end_percent: 1,
        min_tokens: 12288,
        extra_tokens: 256,
        sink_conditioning: "exact_kv_and_rows",
      });
      const vsa = idOf(wf, "BlockSparseAttention");
      const sched = inputsOf(wf, "BasicScheduler");
      expect(sched, name).toMatchObject({
        model: [vsa, 0],
        steps: 8,
        scheduler: "simple",
        denoise: 1,
      });
      expect(inputsOf(wf, "KSamplerSelect").sampler_name, name).toBe(
        "res_multistep",
      );
      expect(loraFiles(wf), name).toEqual([]);
    }
  });

  it("r2v: OmniRef DiT + the core ref2v template recipe", () => {
    const wf = h3("r2v");
    expect(h3FastUnetFor(wf, { h3Speed: "fast8" })).toBe(FASTH3_REF2V_UNET);
    applyH3Speed(wf, { h3Speed: "fast8" });
    expect(inputsOf(wf, "UNETLoader").unet_name).toBe(FASTH3_REF2V_UNET);
    expect(guiderChain(wf)).toEqual(FAST_CHAIN);
    expect(inputsOf(wf, H3_SIGMA_SHIFT_NODE)).toMatchObject({
      shift_video: 12,
      shift_audio: 3,
    });
    expect(inputsOf(wf, "BlockSparseAttention").start_percent).toBe(0);
    expect(inputsOf(wf, "KSamplerSelect").sampler_name).toBe("euler");
    expect(inputsOf(wf, "BasicScheduler").steps).toBe(8);
    expect(FASTH3_RECIPES.ref2v.unet).toBe(FASTH3_REF2V_UNET);
  });

  it("character_swap / face_swap (pinned Turbo LoRA) are untouched", () => {
    for (const name of ["character_swap", "face_swap"]) {
      const wf = h3(name);
      const before = JSON.stringify(wf);
      expect(h3FastUnetFor(wf, { h3Speed: "fast8" }), name).toBeNull();
      expect(applyH3Speed(wf, { h3Speed: "fast8" }), name).toEqual([]);
      expect(JSON.stringify(wf), name).toBe(before);
    }
  });

  it("adds no Turbo LoRA, is idempotent, honours explicit steps", () => {
    const wf = h3("t2v");
    expect(h3SpeedLoraFor(wf, { h3Speed: "fast8" })).toBeNull();
    applyH3Speed(wf, { h3Speed: "fast8" });
    const once = JSON.stringify(wf);
    expect(applyH3Speed(wf, { h3Speed: "fast8" })).toEqual([]);
    expect(JSON.stringify(wf)).toBe(once);
    const stepped = h3("t2v");
    applyH3Speed(stepped, { h3Speed: "fast8", steps: 12 });
    expect(inputsOf(stepped, "BasicScheduler").steps).toBe(20);
  });

  it("Quality (off) leaves the pack recipe alone", () => {
    for (const name of ["t2v", "i2v", "r2v", "transition"]) {
      const wf = h3(name);
      const before = JSON.stringify(wf);
      expect(applyH3Speed(wf, { h3Speed: "off" }), name).toEqual([]);
      expect(JSON.stringify(wf), name).toBe(before);
    }
  });

  it("extras then fast8: UNET -> repair LoRA -> SigmaShift -> backend -> VSA", () => {
    const wf = h3("i2v");
    applyH3ExtraLoras(wf, { motionRepair: true });
    applyH3Speed(wf, { h3Speed: "fast8" });
    expect(guiderChain(wf)).toEqual([
      "BlockSparseAttention",
      "ModelAttentionBackend",
      H3_SIGMA_SHIFT_NODE,
      "LoraLoaderModelOnly",
      "UNETLoader",
    ]);
  });

  it("the --h3speed fast8 flag reaches params", () => {
    const parsed = parseImagineInput(
      "a cat --video --packId minimax --h3speed fast8",
    );
    expect(requestedH3Speed(parsed.params)).toBe("fast8");
  });
});

describe("h3Speed + motionRepair", () => {
  const check = (wf: Workflow) => {
    const shift = idOf(wf, H3_SIGMA_SHIFT_NODE);
    expect(inputsOf(wf, "BasicGuider").model).toEqual([shift, 0]);
    expect(inputsOf(wf, "BasicScheduler").model).toEqual([shift, 0]);
    const chain = chainFrom(wf, shift).map((id) =>
      wf[id].class_type === "LoraLoaderModelOnly"
        ? wf[id].inputs.lora_name
        : wf[id].class_type,
    );
    return chain;
  };
  it("extras then speed: UNET -> repair -> Turbo -> SigmaShift", () => {
    const wf = h3("t2v");
    applyH3ExtraLoras(wf, { motionRepair: true });
    applyH3Speed(wf, { h3Speed: "turbo8", motionRepair: true });
    expect(check(wf)).toEqual([
      H3_SIGMA_SHIFT_NODE,
      H3_TURBO_FL2V_8,
      "Motion_Repair_V2.safetensors",
      "UNETLoader",
    ]);
  });
  it("speed then extras: SigmaShift stays the tail", () => {
    const wf = h3("t2v");
    applyH3Speed(wf, { h3Speed: "turbo8" });
    applyH3ExtraLoras(wf, { motionRepair: true });
    const chain = check(wf);
    expect(chain[0]).toBe(H3_SIGMA_SHIFT_NODE);
    expect(chain).toContain("Motion_Repair_V2.safetensors");
    expect(chain).toContain(H3_TURBO_FL2V_8);
    expect(ofClass(wf, H3_SIGMA_SHIFT_NODE)).toHaveLength(1);
  });
  it("applies through the orbit builder", () => {
    const run = {
      run_id: "seed-img",
      prompt: "",
      parsedPrompt: "",
      width: 1024,
      height: 1024,
      createdAt: new Date().toISOString(),
      status: "done",
      jobs: [
        {
          seed: 0,
          index: 0,
          status: "done",
          progress: 100,
          images: [
            "http://127.0.0.1:8188/view?filename=src.png&subfolder=cj&type=input",
          ],
        },
      ],
      params: { seed_upload: true },
    } as ImagineRun;
    const { workflow } = buildOrbit360Workflow(h3("orbit_360"), run, 0, {
      motionRepair: true,
      h3Speed: "turbo4",
    });
    expect(check(workflow)).toEqual([
      H3_SIGMA_SHIFT_NODE,
      H3_TURBO_FL2V_4,
      "Motion_Repair_V2.safetensors",
      "minimax_h3_flf2v_lora_v1.safetensors",
      "UNETLoader",
    ]);
    expect(inputsOf(workflow, "BasicScheduler").steps).toBe(4);
  });
});

describe("Settings: H3 Speed -> --h3speed", () => {
  it("emits --h3speed fast8 only for the H3 Audio video model", async () => {
    const { selectSettingsString, useUIStore } = await import("@/store");
    const base = useUIStore.getState();
    const str = (patch: Record<string, unknown>) =>
      selectSettingsString({
        ...base,
        settings: { ...base.settings, ...patch },
      } as typeof base);
    expect(base.settings.h3Speed).toBe("off");
    expect(str({ videoModel: "minimax" })).toBe("--vmodel minimax");
    expect(str({ videoModel: "minimax", h3Speed: "fast8" })).toBe(
      "--vmodel minimax --h3speed fast8",
    );
    expect(str({ videoModel: "wan", h3Speed: "fast8" })).toBe("--vmodel wan");
  });
});
