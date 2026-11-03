import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  STARTER_PACKS,
  fetchCommand,
  hfCommand,
  isInstalled,
  missingRequirements,
  preselectPacks,
  resolveAllPacks,
  slotOptions,
  vramTier,
  type Listings,
  type Tier,
} from "@/lib/onboarding/starterPacks";
import {
  profileFromSystemStats,
  type BackendProfile,
} from "@/lib/models/compat";
import { familyFor } from "@/lib/tools/toolsDoc";
import modelSizes from "@/lib/tools/modelSizes.json";

const GiB = 1024 ** 3;

function cuda(name: string, gb: number): BackendProfile {
  return profileFromSystemStats({
    system: { os: "linux", ram_total: 64 * GiB },
    devices: [{ name: `cuda:0 ${name}`, type: "cuda", vram_total: gb * GiB }],
  })!;
}
const MAC = profileFromSystemStats({
  system: { os: "darwin", ram_total: 64 * GiB },
  devices: [{ name: "mps", type: "mps", vram_total: 64 * GiB }],
})!;
const P4090 = profileFromSystemStats({
  system: { os: "linux", ram_total: 100904390656 },
  devices: [
    {
      name: "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync",
      type: "cuda",
      vram_total: 25503596544,
    },
  ],
})!;

const allDests = STARTER_PACKS.packs.flatMap((p) =>
  p.files.flatMap((s) => slotOptions(s).map((o) => o.dest)),
);

function listingsWith(dests: string[]): Listings {
  const out: Listings = {};
  for (const d of allDests) out[d.split("/")[0]] ??= new Set();
  for (const d of dests)
    out[d.split("/")[0]]!.add(d.split("/").slice(1).join("/").toLowerCase());
  return out;
}

describe("vramTier", () => {
  it.each<[BackendProfile | null, Tier | null]>([
    [null, null],
    [cuda("NVIDIA GeForce RTX 3070", 7.6), "le8"],
    [cuda("NVIDIA GeForce RTX 3060", 11.6), "12"],
    [cuda("NVIDIA GeForce RTX 4080", 15.6), "16"],
    [P4090, "24plus"],
    [cuda("NVIDIA RTX PRO 6000 Blackwell", 95), "24plus"],
    [MAC, "mac"],
  ])("%#", (p, tier) => {
    expect(vramTier(p)).toBe(tier);
  });

  it("CPU only maps to the smallest tier", () => {
    const cpu = profileFromSystemStats({
      system: { ram_total: 64 * GiB },
      devices: [{ name: "cpu", type: "cpu", vram_total: 64 * GiB }],
    });
    expect(vramTier(cpu)).toBe("le8");
  });
});

describe("starterPacks.json", () => {
  it("is well formed: unique ids, tiers point at real packs, requires resolve", () => {
    const ids = STARTER_PACKS.packs.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const list of Object.values(STARTER_PACKS.tiers))
      for (const id of list) expect(ids).toContain(id);
    for (const p of STARTER_PACKS.packs)
      for (const r of p.requires ?? []) expect(ids).toContain(r);
    expect(Object.keys(STARTER_PACKS.tiers).sort()).toEqual(
      ["12", "16", "24plus", "le8", "mac"].sort(),
    );
  });

  it("every file has a pinned source and a positive size", () => {
    for (const p of STARTER_PACKS.packs)
      for (const s of p.files)
        for (const o of slotOptions(s)) {
          expect(o.bytes, o.dest).toBeGreaterThan(0);
          if (o.repo) {
            expect(o.repoPath, o.dest).toBeTruthy();
            expect(o.revision, o.dest).toMatch(/^[0-9a-f]{40}$/);
          } else {
            expect(o.page, o.dest).toMatch(/^https:\/\//);
          }
        }
  });

  it("sizes agree with modelSizes.json where it knows the file", () => {
    const files = (
      modelSizes as { files: Record<string, { bytes: number | null }> }
    ).files;
    for (const d of allDests) {
      const known = files[d.split("/").pop()!]?.bytes;
      const def = STARTER_PACKS.packs
        .flatMap((p) => p.files.flatMap(slotOptions))
        .find((o) => o.dest === d)!;
      if (typeof known === "number") expect(def.bytes, d).toBe(known);
    }
  });

  // The public download list (models/download-list.json) is generated at
  // export time; a monorepo checkout reads the TSVs it is generated from.
  // With neither present the test is skipped.
  const LIST_JSON = path.resolve(__dirname, "../../models/download-list.json");
  const LIST_SRC = path.resolve(__dirname, "../../models");
  type HfRow = { repo: string; path: string; revision: string; size: number };
  function loadList(): {
    hf: Map<string, HfRow>;
    other: Map<string, number>;
  } | null {
    const hf = new Map<string, HfRow>();
    const other = new Map<string, number>();
    if (existsSync(LIST_JSON)) {
      const doc = JSON.parse(readFileSync(LIST_JSON, "utf8")) as {
        files: (HfRow & { dest: string; also?: string[] })[];
        other: { dest: string; size: number }[];
      };
      for (const f of doc.files)
        for (const d of [f.dest, ...(f.also ?? [])]) hf.set(d, f);
      for (const o of doc.other) other.set(o.dest, o.size);
      return { hf, other };
    }
    const tsv = path.join(LIST_SRC, "download_list.tsv");
    if (!existsSync(tsv)) return null;
    const lines = (file: string) =>
      existsSync(file)
        ? readFileSync(file, "utf8")
            .split("\n")
            .filter((l) => l.trim() && !l.startsWith("#"))
            .map((l) => l.split("\t"))
        : [];
    for (const c of lines(tsv))
      hf.set(c[6], { repo: c[2], path: c[3], revision: c[4], size: Number(c[5]) });
    for (const c of lines(path.join(LIST_SRC, "download_list_extra.tsv")))
      other.set(c[1], Number(c[4]));
    return { hf, other };
  }
  const list = loadList();
  it.skipIf(!list)(
    "uses only files from the download list, with matching repo/revision/size",
    () => {
      const { hf, other } = list!;
      for (const p of STARTER_PACKS.packs)
        for (const o of p.files.flatMap(slotOptions)) {
          if (!o.repo) {
            expect(other.get(o.dest), o.dest).toBe(o.bytes);
            continue;
          }
          const r = hf.get(o.dest);
          expect(r, o.dest).toBeTruthy();
          expect(r!.repo).toBe(o.repo);
          expect(r!.path).toBe(o.repoPath);
          expect(r!.revision).toBe(o.revision);
          expect(r!.size).toBe(o.bytes);
        }
    },
  );

  it("every file has a known license family", () => {
    for (const d of allDests) expect(familyFor(d), d).toBeTruthy();
  });
});

describe("resolvePack / installed filtering", () => {
  it("isInstalled: exact path, same name in another subfolder, unknown", () => {
    const l = listingsWith(["loras/other/x.safetensors"]);
    expect(isInstalled("loras/edit_tools/x.safetensors", l)).toBe(true);
    expect(isInstalled("loras/y.safetensors", l)).toBe(false);
    expect(isInstalled("loras/y.safetensors", null)).toBeNull();
    expect(isInstalled("nosuchfolder/y.safetensors", l)).toBeNull();
  });

  it("4090 gets Krea 2 fp8 (bf16 is tight) and qwen bf16", () => {
    const best = resolveAllPacks(P4090, listingsWith([])).find(
      (p) => p.id === "images-best",
    )!;
    const krea = best.files.find((f) => f.dest.includes("krea2"))!;
    expect(krea.dest).toMatch(/fp8_scaled/);
    expect(krea.alternative).toBe(true);
    expect(best.verdict).toBe("fits");
  });

  it("Mac never gets an fp8 file; fp8-only packs are unsupported there", () => {
    for (const p of resolveAllPacks(MAC, listingsWith([]))) {
      const fp8 = p.files.some((f) => /fp8/.test(f.dest));
      if (fp8) {
        expect(p.verdict, p.id).toBe("unsupported");
        expect(STARTER_PACKS.tiers.mac).not.toContain(p.id);
      }
    }
    const best = resolveAllPacks(MAC, listingsWith([])).find(
      (p) => p.id === "images-best",
    )!;
    for (const f of best.files) expect(f.dest).not.toMatch(/fp8/);
  });

  it("an installed alternative wins and is not downloaded again", () => {
    const krea = STARTER_PACKS.packs
      .find((p) => p.id === "images-best")!
      .files.flatMap(slotOptions)
      .find((o) => /krea2.*bf16/.test(o.dest))!;
    const best = resolveAllPacks(P4090, listingsWith([krea.dest])).find(
      (p) => p.id === "images-best",
    )!;
    const f = best.files.find((x) => x.dest === krea.dest)!;
    expect(f.installed).toBe(true);
    expect(best.needBytes).toBe(best.totalBytes - krea.bytes);
  });

  it("allInstalled when every chosen file is present", () => {
    const pack = STARTER_PACKS.packs.find((p) => p.id === "images-fast")!;
    const r = resolveAllPacks(
      P4090,
      listingsWith(pack.files.map((s) => slotOptions(s)[0].dest)),
    ).find((p) => p.id === "images-fast")!;
    expect(r.allInstalled).toBe(true);
    expect(r.needBytes).toBe(0);
    expect(fetchCommand([r])).toBeNull();
  });

  it("flags non-commercial licenses", () => {
    const packs = resolveAllPacks(P4090, null, (d) => {
      const f = familyFor(d);
      return f ? { license: f.license, commercial: f.commercial } : undefined;
    });
    expect(packs.some((p) => p.nonCommercial)).toBe(true);
    for (const p of packs)
      expect(p.nonCommercial).toBe(
        p.licenses.some((l) => l.commercial !== "yes"),
      );
  });
});

describe("preselectPacks", () => {
  it("not connected: nothing ticked", () => {
    expect(preselectPacks(null, resolveAllPacks(null, null))).toEqual([]);
  });

  it("4090: only recommended packs that fit, edit kept with its base", () => {
    const packs = resolveAllPacks(P4090, listingsWith([]));
    const picked = preselectPacks("24plus", packs);
    expect(picked).toContain("images-best");
    for (const id of picked) {
      expect(STARTER_PACKS.tiers["24plus"]).toContain(id);
      expect(packs.find((p) => p.id === id)!.verdict).toBe("fits");
    }
    if (picked.includes("edit")) expect(picked).toContain("images-best");
  });

  it("skips packs that are already installed", () => {
    const pack = STARTER_PACKS.packs.find((p) => p.id === "images-fast")!;
    const packs = resolveAllPacks(
      cuda("NVIDIA GeForce RTX 3070", 7.6),
      listingsWith(pack.files.map((s) => slotOptions(s)[0].dest)),
    );
    expect(preselectPacks("le8", packs)).not.toContain("images-fast");
  });

  it("always offers an image pack when one at least runs", () => {
    const p = cuda("NVIDIA GeForce RTX 3070", 7.6);
    const picked = preselectPacks("le8", resolveAllPacks(p, listingsWith([])));
    expect(
      picked.some(
        (id) => STARTER_PACKS.packs.find((x) => x.id === id)!.kind === "image",
      ),
    ).toBe(true);
  });

  it("missingRequirements: edit needs images-best unless installed", () => {
    const packs = resolveAllPacks(P4090, listingsWith([]));
    expect(missingRequirements(["edit"], packs)).toEqual(["images-best"]);
    expect(missingRequirements(["edit", "images-best"], packs)).toEqual([]);
  });
});

describe("commands", () => {
  it("fetchCommand passes --use for alternatives and quotes the folder", () => {
    const packs = resolveAllPacks(P4090, listingsWith([]));
    const best = packs.find((p) => p.id === "images-best")!;
    const cmd = fetchCommand([best], "/home/me/Comfy UI")!;
    expect(cmd).toMatch(/^node scripts\/fetch-models\.mjs --pack images-best /);
    expect(cmd).toContain("--use diffusion_models/");
    expect(cmd).toContain("fp8_scaled");
    expect(cmd).toContain("--comfy '/home/me/Comfy UI'");
    expect(cmd.endsWith("--yes")).toBe(true);
  });

  it("fetchCommand joins several packs and skips installed ones", () => {
    const fast = STARTER_PACKS.packs.find((p) => p.id === "images-fast")!;
    const packs = resolveAllPacks(
      P4090,
      listingsWith(fast.files.map((s) => slotOptions(s)[0].dest)),
    );
    const sel = packs.filter((p) =>
      ["images-fast", "upscale", "audio-sfx"].includes(p.id),
    );
    expect(fetchCommand(sel, "/c")).toContain("--pack upscale,audio-sfx ");
    expect(fetchCommand([])).toBeNull();
  });

  it("hfCommand pins the revision; null for non-HF files", () => {
    const files = STARTER_PACKS.packs.flatMap((p) =>
      p.files.flatMap(slotOptions),
    );
    const hf = files.find((f) => f.repo)!;
    expect(hfCommand(hf)).toContain(`--revision ${hf.revision}`);
    const manual = files.find((f) => !f.repo)!;
    expect(hfCommand(manual)).toBeNull();
  });
});
