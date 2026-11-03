/**
 * Pika H3 Flex: opt-in FL2VA / Ref2VA fine-tune LoRA, picked from the graph
 * family and chained like the other H3 extras. Covers the graph edit, the CLI
 * flags, the missing-LoRA 409, model-status, the Tools pickers and the
 * license label.
 */
import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ImagineRun, Workflow } from "@/types";
import {
  H3_FLEX_DEFAULT_STRENGTH,
  H3_FLEX_LORAS,
  H3_FLEX_SUBTLE_STRENGTH,
  applyH3ExtraLoras,
  h3FlexLoraFor,
  requestedH3FlexStrength,
} from "@/lib/oj/h3Video";
import {
  H3_SIGMA_SHIFT_NODE,
  H3_TURBO_FL2V_8,
  H3_TURBO_REF2V_8,
  applyH3Speed,
} from "@/lib/oj/h3Speed";
import { buildOrbit360Workflow } from "@/lib/oj/h3ImageVideo";
import { buildRefVideoWorkflow } from "@/lib/oj/h3RefVideo";
import { requestedH3LoraFiles } from "@/lib/oj/mossImageDefaults";
import { parseImagineInput } from "@/lib/oj/parser";
import { familyFor } from "@/lib/tools/toolsDoc";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
  type ActionToolSpec,
} from "@/lib/tools/toolsPage";

const tmpRoot = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return mkdtempSync(
    require("path").join(require("os").tmpdir(), "cj-h3flex-"),
  ) as string;
});
vi.mock("@/lib/env", () => ({
  env: { COMFY_ROOT: tmpRoot, ADMIN_API_KEY: "" },
}));
vi.mock("@/lib/auth", () => ({ requireAdmin: () => ({ ok: true }) }));
vi.mock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
vi.mock("fs/promises", async (orig) => {
  const real = await orig<typeof import("fs/promises")>();
  return { ...real, default: real };
});
vi.mock("@/lib/comfy/http", () => ({
  queuePrompt: vi.fn(),
  fetchHistory: vi.fn(),
  extractImageUrls: vi.fn(() => []),
  ComfyAPIError: class ComfyAPIError extends Error {},
}));
vi.mock("@/lib/comfy/workflows", () => ({
  loadWorkflowFromSelection: vi.fn(),
}));
vi.mock("@/lib/comfy/runs", () => ({
  getActiveRun: vi.fn(),
  addActiveRun: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  insertPrompt: vi.fn(),
  insertRun: vi.fn(),
  insertJob: vi.fn(),
}));

import { queuePrompt } from "@/lib/comfy/http";
import { loadWorkflowFromSelection } from "@/lib/comfy/workflows";
import { getActiveRun } from "@/lib/comfy/runs";

const FL2VA = "pika_h3_flex_fl2va_v1_bf16.safetensors";
const REF2VA = "pika_h3_flex_ref2va_v1_bf16.safetensors";

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
const IMAGE_URL =
  "http://127.0.0.1:8188/view?filename=src.png&subfolder=cj&type=input";
const imageRun = (): ImagineRun =>
  ({
    run_id: "seed-img",
    prompt: "",
    parsedPrompt: "",
    width: 1024,
    height: 1024,
    createdAt: new Date().toISOString(),
    status: "done",
    jobs: [
      { seed: 0, index: 0, status: "done", progress: 100, images: [IMAGE_URL] },
    ],
    params: { seed_upload: true },
  }) as unknown as ImagineRun;

const idOf = (wf: Workflow, cls: string) =>
  Object.keys(wf).find((id) => wf[id].class_type === cls)!;
const loraEntries = (wf: Workflow) =>
  Object.values(wf)
    .filter((n) => n.class_type === "LoraLoaderModelOnly")
    .map((n) => [n.inputs.lora_name, n.inputs.strength_model]);
/** MODEL chain from the guider up to the UNET (LoRA files / class names, tail first). */
function guiderChain(wf: Workflow): string[] {
  const out: string[] = [];
  let cur: unknown = wf[idOf(wf, "BasicGuider")].inputs.model;
  while (Array.isArray(cur)) {
    const n = wf[String(cur[0])];
    out.push(
      n.class_type === "LoraLoaderModelOnly"
        ? String(n.inputs.lora_name)
        : n.class_type,
    );
    cur = n.inputs.model;
  }
  return out;
}
const put = (dir: string, file: string) => {
  const p = path.join(tmpRoot, "models", dir, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "x");
};
const clearModels = () =>
  fs.rmSync(path.join(tmpRoot, "models"), { recursive: true, force: true });

describe("h3FlexLoraFor", () => {
  it("picks the file from the graph family", () => {
    expect(H3_FLEX_LORAS).toEqual({ fl2v: FL2VA, ref2v: REF2VA });
    for (const name of ["i2v", "t2v", "orbit_360", "camera_move", "transition"])
      expect(h3FlexLoraFor(h3(name), { h3Flex: true })?.file, name).toBe(FL2VA);
    // person_remove has no ReferenceToVideo node but loads the Ref2VA DiT.
    for (const name of [
      "r2v",
      "multiframe_ref",
      "character_swap",
      "face_swap",
      "person_remove",
    ])
      expect(h3FlexLoraFor(h3(name), { h3Flex: true })?.file, name).toBe(
        REF2VA,
      );
  });
  it("defaults to strength 1, clamps, and is off unless asked", () => {
    expect(H3_FLEX_DEFAULT_STRENGTH).toBe(1);
    expect(requestedH3FlexStrength({ h3Flex: true })).toBe(1);
    expect(requestedH3FlexStrength({ h3Flex: "on", h3FlexStrength: 0.6 })).toBe(
      0.6,
    );
    expect(requestedH3FlexStrength({ h3Flex: true, h3FlexStrength: 9 })).toBe(
      1.5,
    );
    expect(requestedH3FlexStrength({ h3Flex: true, h3FlexStrength: 0 })).toBe(
      null,
    );
    expect(requestedH3FlexStrength({})).toBe(null);
    expect(requestedH3FlexStrength({ h3Flex: false })).toBe(null);
    // strength alone does not turn it on
    expect(requestedH3FlexStrength({ h3FlexStrength: 0.8 })).toBe(null);
    const moss = load("moss-image", "t2i");
    expect(h3FlexLoraFor(moss, { h3Flex: true })).toBeNull();
  });
});

describe("applyH3ExtraLoras with h3Flex", () => {
  it("is a no-op by default", () => {
    const wf = h3("i2v");
    const before = JSON.stringify(wf);
    expect(applyH3ExtraLoras(wf, {})).toEqual([]);
    expect(JSON.stringify(wf)).toBe(before);
  });
  it("chains Flex first, then the other extras; idempotent", () => {
    const wf = h3("orbit_360");
    const ids = applyH3ExtraLoras(wf, { h3Flex: true, motionRepair: true });
    expect(ids).toHaveLength(2);
    expect(guiderChain(wf)).toEqual([
      "Motion_Repair_V2.safetensors",
      FL2VA,
      "minimax_h3_flf2v_lora_v1.safetensors",
      "UNETLoader",
    ]);
    expect(applyH3ExtraLoras(wf, { h3Flex: true, motionRepair: true })).toEqual(
      [],
    );
  });
  it("Ref2VA graph + Turbo: UNET -> Flex -> Turbo, strength forwarded", () => {
    const wf = h3("r2v");
    applyH3ExtraLoras(wf, { h3Flex: true, h3FlexStrength: 0.6 });
    applyH3Speed(wf, { h3Speed: "turbo8" });
    expect(loraEntries(wf)).toContainEqual([REF2VA, 0.6]);
    const chain = guiderChain(wf).filter((c) => c !== H3_SIGMA_SHIFT_NODE);
    expect(chain.slice(0, 2)).toEqual([H3_TURBO_REF2V_8, REF2VA]);
    expect(chain[chain.length - 1]).toBe("UNETLoader");
  });
  it("swap graphs keep the SigmaShift tail", () => {
    const wf = h3("character_swap");
    applyH3ExtraLoras(wf, { h3Flex: true });
    const chain = guiderChain(wf);
    expect(chain[0]).toBe(H3_SIGMA_SHIFT_NODE);
    expect(chain[1]).toBe(REF2VA);
  });
  it("applies through the orbit and ref_video builders", () => {
    const orbit = buildOrbit360Workflow(h3("orbit_360"), imageRun(), 0, {
      h3Flex: true,
      h3Speed: "turbo8",
    }).workflow;
    expect(guiderChain(orbit)).toEqual([
      H3_SIGMA_SHIFT_NODE,
      H3_TURBO_FL2V_8,
      FL2VA,
      "minimax_h3_flf2v_lora_v1.safetensors",
      "UNETLoader",
    ]);
    const ref = buildRefVideoWorkflow(h3("r2v"), imageRun(), 0, {
      h3Flex: true,
    }).workflow;
    expect(loraEntries(ref)).toContainEqual([REF2VA, 1]);
  });
});

describe("flags + requested files", () => {
  it("--h3-flex / --h3-flex-strength parse to params", () => {
    const p = parseImagineInput(
      "a dancer spins --video --packId minimax --h3-flex --h3-flex-strength 0.7",
    ).params;
    expect(p.h3Flex).toBe(true);
    expect(p.h3FlexStrength).toBe(0.7);
    expect(
      parseImagineInput("a cat --video --packId minimax").params.h3Flex,
    ).toBeUndefined();
  });
  it("requestedH3LoraFiles adds the family file only with a workflow", () => {
    expect(requestedH3LoraFiles({ h3Flex: true })).toEqual([]);
    expect(requestedH3LoraFiles({ h3Flex: true }, h3("i2v"))).toEqual([FL2VA]);
    expect(
      requestedH3LoraFiles({ h3Flex: true, h3Speed: "turbo8" }, h3("r2v")),
    ).toEqual([REF2VA, H3_TURBO_REF2V_8]);
    expect(requestedH3LoraFiles({}, h3("r2v"))).toEqual([]);
  });
});

describe("routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearModels();
    vi.mocked(queuePrompt).mockResolvedValue({ prompt_id: "pid" } as never);
  });
  const req = (body: Record<string, unknown>) =>
    new NextRequest("http://localhost/api/jobs/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "cid", ...body }),
    });

  it("action route 409s on a missing Flex LoRA, queues once installed", async () => {
    vi.mocked(getActiveRun).mockReturnValue(imageRun());
    vi.mocked(loadWorkflowFromSelection).mockImplementation(
      async () => h3("orbit_360") as never,
    );
    const { POST } = await import("@/app/api/jobs/action/route");
    const body = {
      run_id: "seed-img",
      job_index: 0,
      action: "orbit_360",
      params: { pack_id: "minimax", h3Flex: true },
    };
    const miss = await POST(req(body));
    expect(miss.status).toBe(409);
    expect((await miss.json()).error).toMatch(
      /loras\/pika_h3_flex_fl2va_v1_bf16\.safetensors/,
    );
    expect(queuePrompt).not.toHaveBeenCalled();

    put("loras", FL2VA);
    const ok = await POST(req(body));
    expect(ok.status).toBe(200);
    const queued = vi.mocked(queuePrompt).mock.calls[0][0] as Workflow;
    expect(loraEntries(queued)).toContainEqual([FL2VA, 1]);
  });

  it("model-status reports both Flex files under options.h3Flex", async () => {
    const { GET } = await import("@/app/api/tools/model-status/route");
    const get = async () =>
      (
        await GET(new NextRequest("http://localhost/api/tools/model-status"))
      ).json();
    let body = await get();
    expect(body.options.h3Flex).toEqual({
      file: FL2VA,
      missing: [`loras/${FL2VA}`, `loras/${REF2VA}`],
    });
    put("loras", FL2VA);
    put("loras", REF2VA);
    body = await get();
    expect(body.options.h3Flex.missing).toEqual([]);
  });
});

describe("Tools tab Flex picker", () => {
  const tool = (id: string) => getActionTool(id) as ActionToolSpec;
  const request = (
    id: string,
    picks: Record<string, string>,
    second?: string,
  ) => {
    const spec = tool(id);
    const d = defaultSettings(spec);
    return buildActionRequest(
      spec,
      { ...d, text: "a scene", picks: { ...d.picks, ...picks } },
      null,
      second,
    ).params;
  };
  const TOOLS: [string, string | undefined][] = [
    ["orbit_360", undefined],
    ["camera_move", undefined],
    ["transition", "end.png [input]"],
    ["ref_video", undefined],
    ["multiframe_ref", "qa/k2.png [input]"],
  ];

  it.each(TOOLS)("%s offers Flex, default off", (id, second) => {
    const picker = tool(id).pickers?.find((p) => p.key === "h3Flex");
    expect(picker?.options.map((o) => o.id)).toEqual(["off", "on", "subtle"]);
    expect(defaultSettings(tool(id)).picks?.h3Flex ?? "off").toBe("off");
    const p = request(id, {}, second);
    expect(p.h3Flex).toBeUndefined();
    expect(p.h3FlexStrength).toBeUndefined();
  });

  it.each(TOOLS)("%s forwards on / subtle", (id, second) => {
    expect(request(id, { h3Flex: "on" }, second)).toMatchObject({
      h3Flex: true,
    });
    expect(
      request(id, { h3Flex: "on" }, second).h3FlexStrength,
    ).toBeUndefined();
    expect(request(id, { h3Flex: "subtle" }, second)).toMatchObject({
      h3Flex: true,
      h3FlexStrength: H3_FLEX_SUBTLE_STRENGTH,
    });
  });
});

describe("license label", () => {
  it("Flex LoRAs carry the MiniMax H3 Community License (restricted)", () => {
    for (const f of [FL2VA, REF2VA])
      expect(familyFor(f)).toMatchObject({
        id: "pika-h3-flex",
        license: "MiniMax H3 Community License",
        commercial: "restricted",
      });
  });
});
