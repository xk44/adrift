import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  downloadCommand,
  fileStatus,
  normalizeListing,
  resolveToolSetup,
  setupTotals,
  type SetupFile,
  type SetupOption,
} from "@/lib/tools/setupRequirements";
import { MODEL_SIZES } from "@/lib/tools/modelsDoc";
import type { Workflow } from "@/types";

const WF = path.resolve(__dirname, "../../public/workflows");
const load = (rel: string): Workflow | null => {
  const p = path.join(WF, rel);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};

function only(key: string): SetupOption {
  const s = resolveToolSetup(key, load);
  expect(s, key).not.toBeNull();
  expect(s!.anyOf).toBe(false);
  expect(s!.options).toHaveLength(1);
  return s!.options[0];
}

function byFile(opt: SetupOption, file: string): SetupFile {
  const f = opt.files.find((x) => x.file === file);
  expect(f, `${file} in ${opt.id}`).toBeDefined();
  return f!;
}

/** Every resolved file carries its modelSizes.json size and a sane folder. */
function expectConsistent(opt: SetupOption) {
  expect(opt.files.length).toBeGreaterThan(0);
  for (const f of opt.files) {
    if (f.byName) continue;
    expect(f.bytes, f.file).toBe(MODEL_SIZES.files[f.file]?.bytes ?? null);
    if (f.folder) {
      expect(f.folder.endsWith("/")).toBe(true);
      expect(f.folder.startsWith(`${f.type}/`)).toBe(true);
      expect(`${f.type}/${f.name}`).toBe(`${f.folder}${f.file}`);
    }
    if (f.command) {
      expect(f.command).toContain("$COMFYUI/models");
      expect(f.command).not.toMatch(/\/\/|models\/[^"]*\/\/|undefined|null/);
    }
  }
  // Required files come first.
  const firstOptional = opt.files.findIndex((f) => f.optional);
  if (firstOptional >= 0)
    expect(opt.files.slice(firstOptional).every((f) => f.optional)).toBe(true);
}

describe("resolveToolSetup: pack -> files -> folders -> sizes", () => {
  it("action:wan_animate lists the Wan Animate graph's four weights", () => {
    const opt = only("action:wan_animate");
    expectConsistent(opt);
    expect(opt.workflows).toEqual(["packs/wan-animate/wan_animate.json"]);
    const folders = Object.fromEntries(
      opt.files.map((f) => [f.file, f.folder]),
    );
    expect(folders).toMatchObject({
      "clip_vision_h.safetensors": "clip_vision/",
      "wan_2.1_vae.safetensors": "vae/split_files/vae/",
      "wan_animate_2_distill_int8_convrot.safetensors": "diffusion_models/",
    });
    expect(opt.files.every((f) => !f.optional)).toBe(true);
    // The repo keeps clip_vision/ at its root: download straight into models/.
    expect(byFile(opt, "clip_vision_h.safetensors").command).toBe(
      'hf download Comfy-Org/Wan-Animate-2 clip_vision/clip_vision_h.safetensors --local-dir "$COMFYUI/models"',
    );
    // The graph's folder mirrors the repo sub-path: no move needed.
    expect(byFile(opt, "wan_2.1_vae.safetensors").command).toBe(
      'hf download Comfy-Org/Wan-2.2 split_files/vae/wan_2.1_vae.safetensors --local-dir "$COMFYUI/models/vae"',
    );
    const t = setupTotals(opt.files);
    expect(t.unknown).toBe(0);
    expect(t.requiredBytes).toBe(
      opt.files.reduce((n, f) => n + (f.bytes ?? 0), 0),
    );
    expect(opt.notes.join(" ")).toMatch(/wan-animate workflow pack/);
  });

  it("catalog:qwen21-remove-bg resolves the Qwen-Image 2.1 edit base", () => {
    const opt = only("catalog:qwen21-remove-bg");
    expectConsistent(opt);
    expect(opt.workflows).toEqual(["packs/qwen-image-21/edit.json"]);
    const dit = byFile(opt, "qwen_image_2.1_bf16.safetensors");
    expect(dit.folder).toBe("diffusion_models/");
    expect(dit.optional).toBe(false);
    expect(dit.license).toBe("Qwen Research License");
    expect(dit.nc).toBe(true);
    expect(dit.sourceUrl).toBe(
      "https://huggingface.co/Comfy-Org/Qwen-Image-2.1",
    );
    expect(byFile(opt, "qwen3vl_8b_bf16.safetensors").folder).toBe(
      "text_encoders/",
    );
  });

  it("catalog:outpaint offers each outpaint backend as an alternative", () => {
    const s = resolveToolSetup("catalog:outpaint", load, "qwen21-outpaint");
    expect(s?.anyOf).toBe(true);
    const ids = s!.options.map((o) => o.id);
    expect(ids).toEqual(
      expect.arrayContaining(["qwen21-outpaint", "flux3-outpaint"]),
    );
    for (const o of s!.options) expectConsistent(o);
    const qwen = s!.options.find((o) => o.id === "qwen21-outpaint")!;
    expect(qwen.model).toBe("Qwen-Image 2.1");
    // The tool's own LoRA is required; its speed LoRA is an optional toggle.
    const lora = byFile(qwen, "qwen-image-2.1-outpaint-v2.safetensors");
    expect(lora.folder).toBe("loras/edit_tools/");
    expect(lora.optional).toBe(false);
    expect(lora.command).toBe(
      'hf download ausboss/Qwen-Image-2.1-Outpaint-LoRA qwen-image-2.1-outpaint-v2.safetensors --local-dir "$COMFYUI/models/loras/edit_tools"',
    );
    expect(
      byFile(qwen, "qwen-image-2.1-lightning-4step.safetensors").optional,
    ).toBe(true);
    const t = setupTotals(qwen.files);
    expect(t.allBytes).toBeGreaterThan(t.requiredBytes);
  });

  it("template:remove_text lists one option per engine", () => {
    const s = resolveToolSetup("template:remove_text", load);
    expect(s?.anyOf).toBe(true);
    expect(s!.options.length).toBeGreaterThan(1);
    for (const o of s!.options) expectConsistent(o);
    const qwen = s!.options.find((o) => o.id === "qwen2511-remove")!;
    const dit = byFile(qwen, "qwen_image_edit_2511_bf16.safetensors");
    // Flat graph folder, nested repo path: download then move up.
    expect(dit.command).toBe(
      'hf download Comfy-Org/Qwen-Image-Edit split_files/diffusion_models/qwen_image_edit_2511_bf16.safetensors --local-dir "$COMFYUI/models/diffusion_models" && mv "$COMFYUI/models/diffusion_models/split_files/diffusion_models/qwen_image_edit_2511_bf16.safetensors" "$COMFYUI/models/diffusion_models/"',
    );
    expect(dit.pathGuessed).toBe(false);
  });

  it("special:dub_video walks every pipeline stage plus by-name models", () => {
    const opt = only("special:dub_video");
    expectConsistent(opt);
    expect(opt.workflows.length).toBeGreaterThan(3);
    const whisper = opt.files.find((f) => f.byName && /whisper/i.test(f.file));
    expect(whisper?.folder).toBe("stt/whisper/whisper-large-v3-turbo/");
    expect(whisper?.command).toBe(
      'hf download openai/whisper-large-v3-turbo --local-dir "$COMFYUI/models/stt/whisper/whisper-large-v3-turbo"',
    );
    // The Chatterbox engine is an alternate: its weights are optional.
    const chatterbox = opt.files.filter((f) =>
      f.folder?.startsWith("tts/chatterbox/"),
    );
    expect(chatterbox.length).toBeGreaterThan(0);
    expect(chatterbox.every((f) => f.optional)).toBe(true);
  });

  it("by-name models fetched by their node pack get no command", () => {
    const opt = only("action:make_3d");
    const tripo = opt.files.find((f) => f.byName);
    expect(tripo?.folder).toBeNull();
    expect(tripo?.command).toBeNull();
    expect(tripo?.note).toMatch(/node pack/);
  });

  it("unknown keys resolve to null", () => {
    expect(resolveToolSetup("action:nope", load)).toBeNull();
    expect(resolveToolSetup("placeholder:x", load)).toBeNull();
  });
});

describe("downloadCommand", () => {
  it("has no command for unknown or non-repo sources", () => {
    expect(
      downloadCommand("x.safetensors", "loras/", undefined).command,
    ).toBeNull();
    expect(
      downloadCommand("x.safetensors", "loras/", { source: "briaai" }).command,
    ).toBeNull();
    expect(
      downloadCommand("x.safetensors", null, { source: "a/b" }).command,
    ).toBeNull();
  });

  it("assumes the repo root for files not in modelRepoPaths.json", () => {
    expect(
      downloadCommand("zz.safetensors", "loras/x/", { source: "a/b" }),
    ).toEqual({
      command:
        'hf download a/b zz.safetensors --local-dir "$COMFYUI/models/loras/x"',
      pathGuessed: true,
    });
  });

  it("renames a file the repo publishes under another name", () => {
    expect(
      downloadCommand("krea2_selfie_v1.safetensors", "loras/", {
        source: "siraxe/krea2_to_selfie_edit",
      }),
    ).toEqual({
      command:
        'hf download siraxe/krea2_to_selfie_edit krea2_selfie_000005050.safetensors --local-dir "$COMFYUI/models/loras" && mv "$COMFYUI/models/loras/krea2_selfie_000005050.safetensors" "$COMFYUI/models/loras/krea2_selfie_v1.safetensors"',
      pathGuessed: false,
    });
    expect(
      downloadCommand(
        "flux3_image_klein_sd_bf16.safetensors",
        "diffusion_models/",
        {
          source: "black-forest-labs/flux-3-image-klein-comfy",
        },
      ).command,
    ).toBe(
      'hf download black-forest-labs/flux-3-image-klein-comfy diffusion_models/flux3-image-klein-bf16.safetensors --local-dir "$COMFYUI/models" && mv "$COMFYUI/models/diffusion_models/flux3-image-klein-bf16.safetensors" "$COMFYUI/models/diffusion_models/flux3_image_klein_sd_bf16.safetensors"',
    );
  });

  it("downloads a repo subfolder that matches the models folder in place", () => {
    expect(
      downloadCommand("ltx-2.5-video-vae-bf16.safetensors", "vae/", {
        source: "Lightricks/LTX-2.5",
      }).command,
    ).toBe(
      'hf download Lightricks/LTX-2.5 vae/ltx-2.5-video-vae-bf16.safetensors --local-dir "$COMFYUI/models"',
    );
  });

  it("has no command for files that need a key conversion", () => {
    expect(
      downloadCommand("x.safetensors", "loras/", {
        source: "a/b",
        convert: "scripts/convert_flux3_lora_keys.py",
      }).command,
    ).toBeNull();
  });

  it("turns a GitHub release page into its asset URL", () => {
    expect(
      downloadCommand("m.pth", "upscale_models/", {
        source: "https://github.com/o/r/releases/tag/v1.0",
      }).command,
    ).toBe(
      'curl -L --create-dirs -o "$COMFYUI/models/upscale_models/m.pth" https://github.com/o/r/releases/download/v1.0/m.pth',
    );
  });
});

describe("fileStatus", () => {
  const file = (over: Partial<SetupFile>): SetupFile => ({
    file: "a.safetensors",
    name: "sub/a.safetensors",
    folder: "loras/sub/",
    type: "loras",
    bytes: 1,
    source: null,
    sourceUrl: null,
    gated: false,
    license: "MIT",
    commercial: "yes",
    nc: false,
    command: null,
    pathGuessed: false,
    optional: false,
    ...over,
  });

  it("matches the exact name, or the same file in another subfolder", () => {
    expect(fileStatus(file({}), normalizeListing(["sub\\A.safetensors"]))).toBe(
      "installed",
    );
    expect(
      fileStatus(file({}), normalizeListing(["other/a.safetensors"])),
    ).toBe("installed");
    expect(fileStatus(file({}), normalizeListing(["b.safetensors"]))).toBe(
      "missing",
    );
    expect(fileStatus(file({}), null)).toBe("unknown");
  });

  it("treats by-name models as installed when their folder has files", () => {
    const f = file({
      byName: true,
      file: "M",
      name: "whisper/m/",
      type: "stt",
    });
    expect(
      fileStatus(f, normalizeListing(["whisper/m/model.safetensors"])),
    ).toBe("installed");
    expect(fileStatus(f, normalizeListing(["whisper/other/x.bin"]))).toBe(
      "missing",
    );
  });
});
