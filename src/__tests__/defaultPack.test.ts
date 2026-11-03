/**
 * Cold-install default engine: Krea 2 unless CJ_DEFAULT_PACK (or its browser
 * mirror) says otherwise, plus the first-run starter-pack hint for it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_DEFAULT_PACK_ID,
  STARTER_PACK_FOR_ENGINE,
  resolveDefaultPackId,
} from "@/lib/oj/defaultPack";
import { STARTER_PACKS } from "@/lib/onboarding/starterPacks";
import { starterPackHint } from "@/lib/setup/starterPackHint";

describe("resolveDefaultPackId", () => {
  it("defaults to krea2 when nothing is configured", () => {
    expect(BUILTIN_DEFAULT_PACK_ID).toBe("krea2");
    expect(resolveDefaultPackId(undefined, undefined)).toBe("krea2");
    expect(resolveDefaultPackId("", "  ")).toBe("krea2");
  });

  it("CJ_DEFAULT_PACK wins, then the browser mirror", () => {
    expect(resolveDefaultPackId(" sdxl ", "flux")).toBe("sdxl");
    expect(resolveDefaultPackId("", "sdxl")).toBe("sdxl");
  });
});

describe("getDefaultPack with env", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load() {
    vi.resetModules();
    return import("@/lib/oj/packs");
  }

  it("unset env: Krea 2 pack, flagged as the default", async () => {
    vi.stubEnv("CJ_DEFAULT_PACK", "");
    vi.stubEnv("NEXT_PUBLIC_CJ_DEFAULT_PACK", "");
    const m = await load();
    const pack = m.getDefaultPack();
    expect(pack.id).toBe("krea2");
    expect(pack.isDefault).toBe(true);
    expect(m.detectModelFamily("")).toBe("krea2");
  });

  it("CJ_DEFAULT_PACK=sdxl still overrides", async () => {
    vi.stubEnv("CJ_DEFAULT_PACK", "sdxl");
    const m = await load();
    expect(m.getDefaultPack().id).toBe("sdxl");
    expect(m.detectModelFamily("")).toBe("sdxl");
  });

  it("exactly one built-in pack is flagged isDefault, and it is krea2", async () => {
    const m = await load();
    const flagged = m.getAllPacks().filter((p) => p.isDefault);
    expect(flagged.map((p) => p.id)).toEqual(["krea2"]);
  });
});

describe("starter packs for the default engine", () => {
  it("every mapped starter pack exists", () => {
    for (const id of Object.values(STARTER_PACK_FOR_ENGINE))
      expect(STARTER_PACKS.packs.some((p) => p.id === id)).toBe(true);
  });

  it("krea2 maps to the best-quality image pack with a fetch command", () => {
    const hint = starterPackHint("krea2", "/srv/ComfyUI")!;
    expect(hint.id).toBe("images-best");
    expect(hint.title).toBe("Images: best quality");
    expect(hint.command).toBe(
      "node scripts/fetch-models.mjs --pack images-best --comfy /srv/ComfyUI --yes",
    );
    // First option of each slot: bf16 Krea 2 + bf16 encoder + VAE.
    expect(hint.sizeBytes).toBe(26283332608 + 8875719384 + 253806246);
  });

  it("quotes the folder and falls back to the placeholder", () => {
    expect(starterPackHint("krea2", "/My Comfy")!.command).toContain(
      "--comfy '/My Comfy'",
    );
    expect(starterPackHint("krea2")!.command).toContain(
      "--comfy /path/to/ComfyUI",
    );
  });

  it("no hint for engines without a starter pack", () => {
    expect(starterPackHint("ideogram4")).toBeUndefined();
  });

  it("big-GPU and Mac tiers lead with the Krea 2 pack, not SDXL", () => {
    for (const tier of ["24plus", "mac"] as const)
      expect(STARTER_PACKS.tiers[tier][0]).toBe("images-best");
    for (const tier of ["12", "16", "24plus", "mac"] as const)
      expect(STARTER_PACKS.tiers[tier][0]).not.toBe("images-fast");
  });
});
