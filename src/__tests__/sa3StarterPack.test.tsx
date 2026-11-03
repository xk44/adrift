import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  COMFY_DIR_PLACEHOLDER,
  STARTER_PACKS,
  fetchCommand,
  resolveAllPacks,
  slotOptions,
  type Listings,
  type Tier,
} from "@/lib/onboarding/starterPacks";
import { profileFromSystemStats, type BackendProfile } from "@/lib/models/compat";
import { CIVITAI_DESTS } from "@/lib/civitaiFolders";
import { familyFor } from "@/lib/tools/toolsDoc";
import { SA3_MEDIUM_BASE_CKPT, SA3_MEDIUM_CKPT } from "@/lib/oj/sa3Params";
import {
  SA3_COMFY_PLACEHOLDER,
  SA3_PACK_BYTES,
  SA3_PACK_ID,
  SA3_QUALITY_DEST,
  SA3_QUALITY_MISSING_HINT,
  sa3EffectiveSpeed,
  sa3PackCommand,
  sa3PackFixes,
  sa3SpeedOptions,
} from "@/lib/tools/sa3Setup";
import { Sa3SpeedPicker } from "@/components/tools/Sa3AudioControls";
import { Sa3PackHint, sa3PackRequiredBytes } from "@/components/tools/Sa3PackHint";
import { licenseChipLabel } from "@/components/onboarding/PacksStep";
import { BRAND_LEAK } from "./brandLeak";

const GiB = 1024 ** 3;
function cuda(gb: number): BackendProfile {
  return profileFromSystemStats({
    system: { os: "linux", ram_total: 64 * GiB },
    devices: [{ name: "cuda:0 NVIDIA GeForce RTX 4080", type: "cuda", vram_total: gb * GiB }],
  })!;
}
const MAC = profileFromSystemStats({
  system: { os: "darwin", ram_total: 64 * GiB },
  devices: [{ name: "mps", type: "mps", vram_total: 64 * GiB }],
})!;

const pack = STARTER_PACKS.packs.find((p) => p.id === SA3_PACK_ID)!;
const files = pack.files.flatMap(slotOptions);

function listing(dests: string[]): Listings {
  const out: Listings = { checkpoints: new Set(), text_encoders: new Set() };
  for (const d of dests) out[d.split("/")[0]]!.add(d.split("/").slice(1).join("/"));
  return out;
}

describe("starter pack schema", () => {
  it("every tier id resolves, sizes are whole positive numbers, folders are allowlisted", () => {
    const ids = new Set(STARTER_PACKS.packs.map((p) => p.id));
    for (const list of Object.values(STARTER_PACKS.tiers)) for (const id of list) expect(ids.has(id), id).toBe(true);
    const folders = new Set<string>(CIVITAI_DESTS);
    for (const p of STARTER_PACKS.packs)
      for (const o of p.files.flatMap(slotOptions)) {
        expect(Number.isSafeInteger(o.bytes) && o.bytes > 0, o.dest).toBe(true);
        expect(folders.has(o.dest.split("/")[0]), o.dest).toBe(true);
        expect(o.dest.split("/")).not.toContain("..");
        if (o.optional !== undefined) expect(typeof o.optional).toBe("boolean");
      }
  });

  it("audio-music (mac tier) is a real pack", () => {
    expect(STARTER_PACKS.tiers.mac).toContain("audio-music");
    expect(STARTER_PACKS.packs.some((p) => p.id === "audio-music")).toBe(true);
  });
});

describe("Stable Audio 3 Medium pack", () => {
  it("has Medium + T5Gemma (sizes as on Hugging Face) and the optional Quality checkpoint", () => {
    expect(pack.kind).toBe("audio");
    const by = Object.fromEntries(files.map((f) => [f.dest, f]));
    expect(by[`checkpoints/${SA3_MEDIUM_CKPT}`]).toMatchObject({ bytes: 9222116660, repo: "Comfy-Org/stable-audio-3" });
    expect(by["text_encoders/t5gemma_b_b_ul2.safetensors"]).toMatchObject({ bytes: 1187264003 });
    expect(by[SA3_QUALITY_DEST]).toMatchObject({ bytes: 9222116660, optional: true });
    expect(SA3_QUALITY_DEST).toBe(`checkpoints/${SA3_MEDIUM_BASE_CKPT}`);
    for (const f of files) expect(f.gated, f.dest).toBeFalsy(); // Comfy-Org mirror is not gated
    expect(SA3_PACK_BYTES).toBe(files.filter((f) => !f.optional).reduce((s, f) => s + f.bytes, 0));
  });

  it("license: plain note, restricted (not non-commercial)", () => {
    expect(pack.licenseNote).toMatch(/Stability AI Community License/);
    expect(pack.licenseNote).toMatch(/\$1M/);
    for (const f of files) expect(familyFor(f.dest)?.commercial, f.dest).toBe("restricted");
    expect(licenseChipLabel([{ commercial: "restricted" }])).toBe("License limits");
    expect(licenseChipLabel([{ commercial: "restricted" }, { commercial: "no" }])).toBe("Non-commercial");
    expect(licenseChipLabel([{ commercial: "unverified" }])).toBe("Check license");
  });

  it("is offered on the tiers that can run it", () => {
    for (const t of ["12", "16", "24plus", "mac"] as Tier[]) expect(STARTER_PACKS.tiers[t], t).toContain(SA3_PACK_ID);
    expect(STARTER_PACKS.tiers.le8).not.toContain(SA3_PACK_ID);
    const verdict = (p: BackendProfile) => resolveAllPacks(p, null).find((x) => x.id === SA3_PACK_ID)!.verdict;
    expect(verdict(cuda(11.6))).toBe("tight");
    expect(verdict(cuda(15.6))).toBe("fits");
    expect(verdict(cuda(24))).toBe("fits");
    expect(verdict(MAC)).toBe("fits");
    expect(verdict(cuda(7.6))).toBe("too_big");
  });

  it("the optional file stays out of the size, 'done' and the download command", () => {
    const fresh = resolveAllPacks(cuda(24), listing([])).find((p) => p.id === SA3_PACK_ID)!;
    expect(fresh.totalBytes).toBe(SA3_PACK_BYTES);
    expect(fresh.optionalBytes).toBe(9222116660);
    expect(fresh.licenseNote).toBe(pack.licenseNote);
    const cmd = fetchCommand([fresh], "/c")!;
    expect(cmd).toBe("node scripts/fetch-models.mjs --pack audio-sa3 --comfy /c --yes");

    const core = resolveAllPacks(
      cuda(24),
      listing([`checkpoints/${SA3_MEDIUM_CKPT}`, "text_encoders/t5gemma_b_b_ul2.safetensors"]),
    ).find((p) => p.id === SA3_PACK_ID)!;
    expect(core.allInstalled).toBe(true);
    expect(core.needBytes).toBe(0);
    expect(fetchCommand([core])).toBeNull();
    expect(core.files.find((f) => f.optional)!.installed).toBe(false);

    const all = resolveAllPacks(cuda(24), listing(files.map((f) => f.dest))).find((p) => p.id === SA3_PACK_ID)!;
    expect(all.optionalBytes).toBe(0);
  });
});

describe("sa3Setup helpers", () => {
  it("pack command, with and without Quality", () => {
    expect(SA3_COMFY_PLACEHOLDER).toBe(COMFY_DIR_PLACEHOLDER);
    expect(sa3PackCommand()).toBe("node scripts/fetch-models.mjs --pack audio-sa3 --comfy /path/to/ComfyUI --yes");
    expect(sa3PackCommand({ quality: true, comfyDir: "/home/me/Comfy UI" })).toBe(
      "node scripts/fetch-models.mjs --pack audio-sa3 --use checkpoints/stable_audio_3_medium_base.safetensors --comfy '/home/me/Comfy UI' --yes",
    );
  });

  it("Quality is disabled and falls back to Fast without its model", () => {
    expect(sa3SpeedOptions(false).find((o) => o.id === "quality")!.disabled).toBe(true);
    expect(sa3SpeedOptions(true).find((o) => o.id === "quality")!.disabled).toBeUndefined();
    expect(sa3EffectiveSpeed("quality", false)).toBe("fast");
    expect(sa3EffectiveSpeed("quality", true)).toBe("quality");
    expect(sa3EffectiveSpeed(undefined, true)).toBe("fast");
  });

  it("sa3PackFixes: only missing SA3 models, not offline or node problems", () => {
    expect(sa3PackFixes("Model not installed: stable_audio_3_medium.safetensors, t5gemma_b_b_ul2.safetensors. Download them.")).toBe(true);
    expect(sa3PackFixes("Model not installed: t5gemma_b_b_ul2.safetensors. Download it.")).toBe(true);
    expect(sa3PackFixes("Model not installed: other.safetensors. Download it.")).toBe(false);
    expect(sa3PackFixes("ComfyUI is not reachable.")).toBe(false);
    expect(sa3PackFixes(null)).toBe(false);
  });
});

describe("audio UI", () => {
  it("Speed picker: Quality disabled with a one-line install hint when its model is missing", () => {
    const html = renderToStaticMarkup(
      <Sa3SpeedPicker quality={false} speed="quality" onChange={() => {}} />,
    );
    expect(html).toContain(SA3_QUALITY_MISSING_HINT);
    expect(html).toMatch(/aria-checked="true"[^>]*>Fast</);
    expect(html).toMatch(/aria-checked="false"[^>]*disabled=""[^>]*>Best quality/);
    expect(html).toContain("--use checkpoints/stable_audio_3_medium_base.safetensors");
    expect(html).not.toMatch(BRAND_LEAK);
  });

  it("Speed picker: both choices when Quality is installed", () => {
    const html = renderToStaticMarkup(
      <Sa3SpeedPicker quality speed="quality" onChange={() => {}} />,
    );
    expect(html).not.toContain(SA3_QUALITY_MISSING_HINT);
    expect(html).not.toContain('disabled=""');
    expect(html).toMatch(/aria-checked="true"[^>]*>Best quality/);
  });

  it("missing-model hint links to the starter pack and its command", () => {
    const html = renderToStaticMarkup(<Sa3PackHint />);
    expect(html).toContain("Open starter packs");
    expect(html).toContain("--pack audio-sa3");
    expect(html).toContain("(10 GB)");
    expect(html).not.toMatch(BRAND_LEAK);
    expect(html).toContain("/path/to/ComfyUI");
  });

  it("missing-model hint uses the real ComfyUI folder when known", () => {
    const html = renderToStaticMarkup(<Sa3PackHint comfyDir="/srv/comfy" />);
    expect(html).toContain("--comfy /srv/comfy");
    expect(html).not.toContain("/path/to/ComfyUI");
    expect(html).not.toContain("in place of the example path");
  });

  it("pack size shown in the hint is derived from the pack definition", () => {
    expect(sa3PackRequiredBytes()).toBe(SA3_PACK_BYTES);
  });
});
