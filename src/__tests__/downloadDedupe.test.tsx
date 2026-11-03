import React from "react";
import { readFileSync } from "fs";
import path from "path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PacksStep } from "@/components/onboarding/PacksStep";
import type { PacksResponse, PackView } from "@/components/onboarding/api";
import { packTool } from "../../scripts/fetch-models.mjs";
import { profileFromSystemStats } from "@/lib/models/compat";
import { chosenFiles } from "@/lib/onboarding/packProgress";
import {
  fetchCommand,
  formatGb,
  resolveAllPacks,
  selectionDownload,
  STARTER_PACKS,
  type ResolvedPack,
} from "@/lib/onboarding/starterPacks";
import { sharedToolCounts } from "@/lib/tools/setupCommands";

const GiB = 1024 ** 3;
const SMALL_GPU = profileFromSystemStats({
  system: { os: "linux", ram_total: 32 * GiB },
  devices: [
    {
      name: "cuda:0 NVIDIA GeForce RTX 3060 Ti",
      type: "cuda",
      vram_total: 8 * GiB,
    },
  ],
})!;

const ENC_BF16 = "text_encoders/qwen3vl_4b_bf16.safetensors";
const ENC_FP8 = "text_encoders/qwen3vl_4b_fp8_scaled.safetensors";
const VAE = "vae/qwen_image_vae.safetensors";

function bytesOf(dest: string): number {
  for (const p of STARTER_PACKS.packs)
    for (const slot of p.files)
      for (const o of "options" in slot ? slot.options : [slot])
        if (o.dest === dest) return o.bytes;
  throw new Error(dest);
}

const pick = (packs: ResolvedPack[], ids: string[]) =>
  packs.filter((p) => ids.includes(p.id));

describe("selectionDownload", () => {
  it("counts files shared by Images + Draft once", () => {
    const packs = pick(resolveAllPacks(null, null), [
      "images-best",
      "images-draft",
    ]);
    const d = selectionDownload(packs);
    const dests = d.files.map((f) => f.dest);
    expect(dests).toContain(ENC_BF16);
    expect(dests).not.toContain(ENC_FP8);
    expect(dests.filter((x) => x === VAE)).toHaveLength(1);
    expect(d.files.find((f) => f.dest === VAE)!.packs).toEqual([
      "images-best",
      "images-draft",
    ]);
    expect(d.savedBytes).toBe(bytesOf(ENC_FP8) + bytesOf(VAE));
    expect(d.needBytes).toBe(
      packs.reduce((n, p) => n + p.needBytes, 0) - d.savedBytes,
    );
  });

  it("skips installed files and saves nothing for one pack", () => {
    const installed = resolveAllPacks(null, {
      text_encoders: new Set(["qwen3vl_4b_bf16.safetensors"]),
      vae: new Set(),
      diffusion_models: new Set(),
    });
    const d = selectionDownload(pick(installed, ["images-best"]));
    expect(d.savedBytes).toBe(0);
    expect(d.files.find((f) => f.dest === ENC_BF16)!.installed).toBe(true);
    expect(d.needBytes).toBe(pick(installed, ["images-best"])[0].needBytes);
  });

  // The wizard's numbers must describe what its command downloads.
  for (const [label, profile] of [
    ["no profile", null],
    ["8 GB GPU", SMALL_GPU],
  ] as const) {
    it(`matches fetch-models --pack for every pair of packs (${label})`, () => {
      const packs = resolveAllPacks(profile, null);
      for (const a of packs)
        for (const b of packs) {
          const chosen = a === b ? [a] : [a, b];
          const cmd = fetchCommand(chosen)!;
          const ids = /--pack (\S+)/.exec(cmd)![1];
          const uses = [...cmd.matchAll(/--use (\S+)/g)].map((m) => m[1]);
          expect(
            selectionDownload(chosen).files.map((f) => f.dest),
            cmd,
          ).toEqual(packTool(STARTER_PACKS, ids, uses).files);
        }
    });
  }
});

describe("chosenFiles", () => {
  it("lists each file once and leaves optional files out", () => {
    const packs = resolveAllPacks(null, null);
    const files = chosenFiles(packs, ["audio-sfx", "audio-sa3"]);
    const dests = files.map((f) => f.dest);
    expect(new Set(dests).size).toBe(dests.length);
    expect(dests).toContain("text_encoders/t5gemma_b_b_ul2.safetensors");
    expect(dests).not.toContain(
      "checkpoints/stable_audio_3_medium_base.safetensors",
    );
    expect(
      chosenFiles(packs, ["images-best", "images-draft"]).map((f) => f.dest),
    ).not.toContain(ENC_FP8);
  });
});

describe("PacksStep shared files", () => {
  function response(): PacksResponse {
    const packs: PackView[] = resolveAllPacks(null, null).map((p) => ({
      ...p,
      command: null,
      files: p.files.map((f) => ({ ...f, hfCommand: null })),
    }));
    return {
      ok: true,
      connected: true,
      profile: null,
      tier: null,
      tierLabel: null,
      installedKnown: false,
      comfyDir: "/path/to/ComfyUI",
      comfyDirKnown: false,
      preselected: [],
      packs,
    } as unknown as PacksResponse;
  }

  it("totals the deduped set and marks what is shared", () => {
    const data = response();
    const selected = ["images-best", "images-draft"];
    const html = renderToStaticMarkup(
      <PacksStep
        data={data}
        loading={false}
        onReload={() => {}}
        selected={selected}
        onSelect={() => {}}
      />,
    );
    const d = selectionDownload(
      data.packs.filter((p) => selected.includes(p.id)) as ResolvedPack[],
    );
    expect(html).toContain(`Download ${formatGb(d.needBytes)}`);
    expect(html).toContain('data-testid="packs-shared"');
    expect(html).toContain(`(${formatGb(d.savedBytes)} less)`);
    expect(html).toContain("Shared with 1 other pack<");
    expect(html).toContain(
      "Gets qwen3vl_4b_bf16.safetensors instead, shared with 1 other pack",
    );
  });

  it("says nothing about sharing for a single pack", () => {
    const html = renderToStaticMarkup(
      <PacksStep
        data={response()}
        loading={false}
        onReload={() => {}}
        selected={["images-best"]}
        onSelect={() => {}}
      />,
    );
    expect(html).not.toContain("packs-shared");
    expect(html).not.toContain("Shared with");
  });
});

describe("sharedToolCounts", () => {
  it("counts the other cards that load each file", () => {
    const map = {
      tools: [
        { kind: "action", id: "a", files: ["vae/v.st", "x/1.st"] },
        { kind: "action", id: "b", files: ["vae/v.st", "vae/v.st"] },
        { kind: "pipeline", id: "a", files: ["vae/v.st"] },
        { kind: "catalog", id: "c" },
      ],
    };
    const n = sharedToolCounts(map, "action:a");
    expect(n.get("vae/v.st")).toBe(2);
    expect(n.has("x/1.st")).toBe(false);
    expect(sharedToolCounts(null, "action:a").size).toBe(0);
  });

  it("the Qwen image VAE is shared by many committed tools", () => {
    const map = JSON.parse(
      readFileSync(
        path.resolve(__dirname, "../../docs/models-by-tool.json"),
        "utf8",
      ),
    );
    expect(
      sharedToolCounts(map, "action:edit_photo").get(VAE),
    ).toBeGreaterThanOrEqual(20);
  });
});
