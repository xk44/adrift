/**
 * Character swap readiness follows the graph each mode actually queues:
 * the card (default "full" mode -> action character_swap, bf16 Ref2VA) is
 * keyed to character_swap; "mannequin" (action character_swap_masked, int8
 * Ref2VA + SAM3) is gated per option through model-status
 * options.characterSwapMasked.
 */
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  CHARACTER_SWAP_MASKED_OPTION,
  actionAvailability,
  buildActionRequest,
  defaultSettings,
  getActionTool,
  optionBlocksFor,
  pickBlock,
  type ModelStatusResponse,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import { setupHint } from "@/lib/tools/setupHint";

const tmpRoot = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return mkdtempSync(
    require("path").join(require("os").tmpdir(), "cj-charswap-"),
  ) as string;
});
vi.mock("@/lib/env", () => ({
  env: { COMFY_ROOT: tmpRoot, ADMIN_API_KEY: "" },
}));
vi.mock("@/lib/auth", () => ({ requireAdmin: () => ({ ok: true }) }));
// No ComfyUI in tests: the default-backend check falls back to the disk.
vi.mock("@/lib/comfy/objectInfoCache", () => ({
  getObjectInfoCached: async () => null,
}));

const FULL_DIT = "minimax_h3_ref2va_pruned_bf16.safetensors";
const MASKED_DIT = "minimax_h3_ref2va_pruned_int8_convrot.safetensors";
const REF = "char.png [input]";
const PACKS = new Set(["minimax"]);

const spec = getActionTool("character_swap")!;
const withMode = (mode?: string): ToolSettings => ({
  ...defaultSettings(spec),
  ...(mode ? { picks: { ...defaultSettings(spec).picks, mode } } : {}),
});
const status = (
  cardMissing: string[],
  maskedMissing?: string[],
): ModelStatusResponse => ({
  tools: { character_swap: { missing: cardMissing } },
  options:
    maskedMissing === undefined
      ? {}
      : {
          [CHARACTER_SWAP_MASKED_OPTION]: {
            file: "packs/minimax/character_swap_masked.json",
            missing: maskedMissing,
          },
        },
});

describe("character_swap availability matches the queued action", () => {
  it("the card's model check is the default mode's action", () => {
    const sent = buildActionRequest(spec, withMode(), null, REF).action;
    expect(sent).toBe("character_swap");
    expect(spec.modelCheck).toEqual({ pack: "minimax", action: sent });
    expect(
      buildActionRequest(spec, withMode("mannequin"), null, REF).action,
    ).toBe("character_swap_masked");
    const mode = spec.pickers!.find((p) => p.key === "mode")!;
    expect(mode.options[0].id).toBe("full");
    expect(
      mode.options.find((o) => o.id === "mannequin")!.requiresOption,
    ).toEqual({ key: CHARACTER_SWAP_MASKED_OPTION, model: "Mannequin" });
  });

  it("full-mode weights missing: the card needs setup (mannequin present)", () => {
    const av = actionAvailability(
      spec,
      PACKS,
      null,
      status([`diffusion_models/${FULL_DIT}`], []),
    );
    expect(av.available).toBe(false);
    expect(av.reason).toContain(FULL_DIT);
    expect(setupHint(av.reason)).toBe("Needs minimax_h3_ref2va_pruned_bf16");
  });

  it("full ready + mannequin graph missing: card ready, only the masked modes blocked", () => {
    const ms = status([], [`diffusion_models/${MASKED_DIT}`]);
    expect(actionAvailability(spec, PACKS, null, ms).available).toBe(true);
    const blocks = optionBlocksFor(spec, PACKS, null, ms);
    expect(Object.keys(blocks?.mode ?? {})).toEqual(["mannequin", "exact"]);
    const card = { optionBlocks: blocks };
    const block = pickBlock(card, spec, withMode("mannequin"))!;
    expect(block.checking).toBe(false);
    expect(block.reason).toContain(MASKED_DIT);
    expect(pickBlock(card, spec, withMode())).toBeNull();
    expect(pickBlock(card, spec, withMode("full"))).toBeNull();
  });

  it("both installed: nothing blocks", () => {
    const ms = status([], []);
    expect(actionAvailability(spec, PACKS, null, ms).available).toBe(true);
    expect(optionBlocksFor(spec, PACKS, null, ms)).toBeUndefined();
  });
});

describe("GET /api/tools/model-status character_swap entries", () => {
  it("card entry = full graph; options.characterSwapMasked = masked graph", async () => {
    const prev = process.env.COMFY_VIDEO_HTTP_URL;
    delete process.env.COMFY_VIDEO_HTTP_URL;
    try {
      const { GET } = await import("@/app/api/tools/model-status/route");
      const body = await (
        await GET(new NextRequest("http://localhost/api/tools/model-status"))
      ).json();
      const card: string[] = body.tools.character_swap.missing;
      expect(card).toContain(`diffusion_models/${FULL_DIT}`);
      expect(card).not.toContain(`diffusion_models/${MASKED_DIT}`);
      const masked = body.options[CHARACTER_SWAP_MASKED_OPTION];
      expect(masked.file).toBe("packs/minimax/character_swap_masked.json");
      expect(masked.missing).toContain(`diffusion_models/${MASKED_DIT}`);
      expect(masked.missing).not.toContain(`diffusion_models/${FULL_DIT}`);
    } finally {
      if (prev !== undefined) process.env.COMFY_VIDEO_HTTP_URL = prev;
    }
  });
});
