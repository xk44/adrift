/**
 * Pose character (krea2-edit edit_pose): the character photo is the source
 * (node 5 = ref B, identity), the pose photo the second reference (node 14 =
 * ref A, layout + DA3 depth -> depth-control LoRA). The canvas follows the
 * pose photo through linked latent dims, which --ar must not overwrite.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { ImagineRun, Workflow } from "@/types";
import { resolveWorkflow } from "@/lib/oj/packs";
import {
  buildActionWorkflow,
  restoreLinkedLatentDims,
  snapshotLinkedLatentDims,
} from "@/lib/oj/engine";
import { getBuiltinEditLoras, preferEditLora } from "@/lib/krea2/editLoras";
import { familyFor } from "@/lib/tools/toolsDoc";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
  pickEditLora,
  poseCharacterPrompt,
  POSE_CHARACTER_ACTION,
  type EditLoraListResponse,
} from "@/lib/tools/toolsPage";

type G = Record<
  string,
  { class_type: string; inputs: Record<string, unknown> }
>;

const REL = "packs/krea2-edit/pose_character.json";
const load = (): G =>
  JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "public/workflows", REL), "utf-8"),
  );

function danglingRefs(graph: G): string[] {
  const ids = new Set(Object.keys(graph));
  const bad: string[] = [];
  for (const [nodeId, node] of Object.entries(graph))
    for (const val of Object.values(node.inputs ?? {}))
      if (Array.isArray(val) && typeof val[0] === "string" && !ids.has(val[0]))
        bad.push(`${nodeId} -> ${val[0]}`);
  return bad;
}

function imageRun(): ImagineRun {
  return {
    run_id: "seed-img",
    prompt: "",
    parsedPrompt: "",
    width: 1024,
    height: 1024,
    createdAt: new Date().toISOString(),
    status: "done",
    jobs: [
      {
        seed: 3,
        index: 0,
        status: "done",
        progress: 100,
        images: [
          "http://127.0.0.1:8188/view?filename=char.png&subfolder=&type=input",
        ],
      },
    ],
    params: { seed_upload: true, ar: "1:1" },
  } as ImagineRun;
}

const installed = (ids: string[]): EditLoraListResponse =>
  ({
    families: { krea2edit: { label: "Grounded Edit" } },
    loras: getBuiltinEditLoras()
      .filter((l) => l.family === "krea2edit")
      .map((l) => ({ ...l, installed: ids.includes(l.id) })),
  }) as unknown as EditLoraListResponse;

describe("pose_character.json graph", () => {
  const g = load();

  it("has no dangling refs; character loads first, pose second", () => {
    expect(danglingRefs(g)).toEqual([]);
    const loads = Object.entries(g)
      .filter(([, n]) => n.class_type === "LoadImage")
      .map(([id]) => id);
    expect(loads).toEqual(["5", "14"]);
  });

  it("patch: A = pose photo (scaled), B = character; depth from the pose", () => {
    expect(g["7"].inputs).toMatchObject({
      model: ["22", 0],
      source_image: ["40", 0],
      source_latent: ["50", 0],
      source_image_b: ["5", 0],
      source_latent_b: ["6", 0],
    });
    expect(g["40"].inputs.image).toEqual(["14", 0]);
    expect(g["16"].inputs.image).toEqual(["40", 0]);
    expect(g["21"].inputs).toMatchObject({
      control_image: ["17", 0],
      channel_mode: "grayscale",
      normalize: "per_image_minmax",
    });
    expect(g["8"].inputs).toMatchObject({
      image: ["40", 0],
      image_b: ["5", 0],
    });
    expect(g["9"].inputs).not.toHaveProperty("image_b");
  });

  it("model chain: edit LoRA 2 -> stack slot 30 (off) -> control 20 -> 22", () => {
    expect(g["2"].inputs.lora_name).toBe(
      "krea2_identity_edit_v1_2.safetensors",
    );
    expect(g["30"].inputs).toMatchObject({
      model: ["2", 0],
      strength_model: 0,
    });
    expect(g["20"].inputs.model).toEqual(["30", 0]);
    expect(g["22"].inputs.model).toEqual(["20", 0]);
    expect(g["10"].inputs).toMatchObject({
      width: ["41", 0],
      height: ["41", 1],
    });
  });
});

describe("edit_pose resolution + build", () => {
  it("krea2-edit resolves edit_pose to the pack graph", () => {
    expect(
      resolveWorkflow({ templateOrAction: "edit_pose", packId: "krea2-edit" })
        .workflowPath,
    ).toBe(REL);
  });

  it("character -> node 5, pose -> node 14, latent stays linked under --ar", () => {
    const { workflow, slots } = buildActionWorkflow(
      load() as unknown as Workflow,
      POSE_CHARACTER_ACTION,
      imageRun(),
      0,
      {
        prompt: poseCharacterPrompt("At night"),
        secondRefImage: "cj/pose.png [input]",
        ar: "16:9",
      },
    );
    const w = workflow as unknown as G;
    expect((slots as { imageInputId?: string }).imageInputId).toBe("5");
    expect(w["5"].inputs.image).toBe("char.png [input]");
    expect(w["14"].inputs.image).toBe("cj/pose.png [input]");
    expect(slots.posTextId).toBe("8");
    expect(w["8"].inputs.prompt).toBe(poseCharacterPrompt("At night"));
    expect(w["9"].inputs.prompt).toBe("");
    expect(w["10"].inputs.width).toEqual(["41", 0]);
    expect(w["10"].inputs.height).toEqual(["41", 1]);
    expect(slots.loraLoaderIds).toEqual(["30"]);
  });

  it("snapshot/restore only touches linked dims", () => {
    const wf = {
      a: {
        class_type: "EmptySD3LatentImage",
        inputs: { width: ["x", 0], height: 768 },
      },
    } as unknown as Workflow;
    const snap = snapshotLinkedLatentDims(wf, "a");
    expect(snap).toEqual({ width: ["x", 0] });
    (wf.a.inputs as Record<string, unknown>).width = 1024;
    (wf.a.inputs as Record<string, unknown>).height = 512;
    restoreLinkedLatentDims(wf, "a", snap);
    expect(wf.a.inputs).toEqual({ width: ["x", 0], height: 512 });
    expect(snapshotLinkedLatentDims(wf, undefined)).toEqual({});
  });
});

describe("Pose character tool", () => {
  const spec = getActionTool("pose_character")!;

  it("is a grounded edit tool with Character + Pose pickers", () => {
    expect(spec).toMatchObject({
      usesEditLora: true,
      firstImage: "Character",
      secondImage: "Pose",
      requiredPack: "krea2-edit",
      modelCheck: { pack: "krea2-edit", action: "edit_pose" },
    });
  });

  it("prompt: fixed instruction plus optional style", () => {
    expect(poseCharacterPrompt("  ")).not.toMatch(/\s$/);
    expect(poseCharacterPrompt("on a beach")).toMatch(
      /image 2\. On a beach\.$/,
    );
    expect(poseCharacterPrompt("At dusk!")).toMatch(/At dusk!$/);
  });

  it("needs the pose photo and an installed edit LoRA", () => {
    const s = { ...defaultSettings(), text: "" };
    expect(() => buildActionRequest(spec, s, installed([]), "p.png")).toThrow(
      /LoRA/,
    );
    expect(() =>
      buildActionRequest(spec, s, installed(["identity-edit"])),
    ).toThrow(/pose photo/i);
    const req = buildActionRequest(
      spec,
      s,
      installed(["identity-edit"]),
      "p.png [input]",
    );
    expect(req.action).toBe("edit_pose");
    expect(req.params).toMatchObject({
      pack_id: "krea2-edit",
      secondRefImage: "p.png [input]",
    });
    expect(req.overrides["2.lora_name"]).toBe(
      "krea2_identity_edit_v1_2.safetensors",
    );
  });

  it("defaults to v1.2 even with v2 installed; v2 is selectable", () => {
    const resp = installed([
      "identity-edit",
      "identity-edit-v2",
      "identity-edit-v2-r128",
    ]);
    expect(pickEditLora(spec, defaultSettings(), resp)?.id).toBe(
      "identity-edit",
    );
    expect(
      pickEditLora(
        spec,
        { ...defaultSettings(), editLoraId: "identity-edit-v2-r128" },
        resp,
      )?.file,
    ).toBe("krea2_identity_edit_v2_r128.safetensors");
  });
});

describe("identity edit v2 licensing + default override", () => {
  it("v2 files are flagged non-commercial; v1.2 stays Krea 2 Community", () => {
    for (const f of [
      "krea2_identity_edit_v2.safetensors",
      "krea2_identity_edit_v2_r128.safetensors",
    ])
      expect(familyFor(f)).toMatchObject({ commercial: "no" });
    expect(familyFor("krea2_identity_edit_v1_2.safetensors")?.id).toBe("krea2");
  });

  it("registry names say non-commercial", () => {
    for (const l of getBuiltinEditLoras().filter(
      (x) => /v2/.test(x.id) && /identity/.test(x.id),
    ))
      expect(l.name).toMatch(/non-commercial/);
  });

  it("preferEditLora moves the chosen id first, ignores unknown ids", () => {
    const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(preferEditLora(list, "c").map((l) => l.id)).toEqual(["c", "a", "b"]);
    expect(preferEditLora(list, "zz")).toBe(list);
    expect(preferEditLora(list, undefined)).toBe(list);
    expect(preferEditLora(list, " ")).toBe(list);
  });
});
