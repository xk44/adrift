/**
 * Recipe -> where "Reproduce" sends the user. Never submits: Create gets
 * the prompt (seed pinned), Tools cards open with their settings filled.
 * Pure (no React, no store).
 */

import { PROVENANCE_PARAM_KEY, type RunProvenance } from "@/lib/runProvenance";
import {
  provenancePrefill,
  provenanceToolKey,
  type ToolPrefillSettings,
} from "@/lib/tools/provenanceTool";
import type { AdriftRecipe } from "./recipe";

export type ReproducePlan =
  | { kind: "prompt"; prompt: string; notes: string[] }
  | {
      kind: "tool";
      toolKey: string;
      prefill: ToolPrefillSettings;
      sourceRunId?: string;
      sourceJobIndex?: number;
      notes: string[];
    }
  | { kind: "unsupported"; reason: string };

const SEED_FLAG_RE = /(^|\s)--seed\s+\S+/gi;

/** Prompt with `--seed` pinned to `seed` (replacing any existing flag). */
export function withSeed(prompt: string, seed: number | undefined): string {
  const base = prompt.trim();
  if (seed === undefined) return base;
  const stripped = base
    .replace(SEED_FLAG_RE, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return `${stripped} --seed ${seed}`.trim();
}

function inputNote(recipe: AdriftRecipe): string[] {
  const n = recipe.inputs.length;
  if (!n) return [];
  return [
    n === 1
      ? "It used 1 input file; attach it again before running."
      : `It used ${n} input files; attach them again before running.`,
  ];
}

export function reproducePlan(recipe: AdriftRecipe): ReproducePlan {
  const { tool } = recipe;
  if (tool.kind === "create") {
    if (!recipe.prompt) {
      return { kind: "unsupported", reason: "The recipe has no prompt." };
    }
    return {
      kind: "prompt",
      prompt: withSeed(recipe.prompt, recipe.seeds[0]),
      notes: inputNote(recipe),
    };
  }
  if (tool.kind === "tool" || tool.kind === "action") {
    const provenance: RunProvenance = {
      kind: tool.kind,
      id: tool.id,
      label: tool.label ?? tool.id,
    };
    const params: Record<string, unknown> = {
      ...recipe.params,
      [PROVENANCE_PARAM_KEY]: {
        kind: tool.kind,
        id: tool.id,
        ...(tool.via ? { via: tool.via } : {}),
      },
    };
    const toolKey = provenanceToolKey(provenance, params);
    if (!toolKey) {
      return {
        kind: "unsupported",
        reason: `${tool.label ?? tool.id} runs from the lightbox; open the source image and use it there.`,
      };
    }
    const notes: string[] = [];
    if (!recipe.sourceRunId) notes.push(...inputNote(recipe));
    return {
      kind: "tool",
      toolKey,
      prefill: provenancePrefill(provenance, params, recipe.prompt),
      ...(recipe.sourceRunId ? { sourceRunId: recipe.sourceRunId } : {}),
      ...(recipe.sourceJobIndex !== undefined
        ? { sourceJobIndex: recipe.sourceJobIndex }
        : {}),
      notes,
    };
  }
  const reasons: Record<string, string> = {
    inpaint:
      "Inpaint needs its mask redrawn; open the source image and inpaint it.",
    user_tool: "Custom tools can't be refilled yet; run it again from Tools.",
    video_editor: "Video editor renders are reproduced from their project.",
    workflow: "This output came from a raw workflow, not an Adrift tool.",
  };
  return {
    kind: "unsupported",
    reason: reasons[tool.kind] ?? "This recipe can't be reopened.",
  };
}

/** Names the recipe needs that are not in the local lists. */
export interface MissingModels {
  models: string[];
  loras: string[];
}

function norm(name: string): string {
  return name.replace(/\\/g, "/").toLowerCase();
}

function baseName(name: string): string {
  return norm(name).split("/").pop() ?? "";
}

/**
 * Compare recipe models / LoRAs with what ComfyUI lists. A subfolder change
 * still counts as present (same file name).
 */
export function missingModels(
  recipe: AdriftRecipe,
  available: { models: Iterable<string>; loras: Iterable<string> },
): MissingModels {
  const have = new Set<string>();
  const haveBase = new Set<string>();
  for (const n of [...available.models, ...available.loras]) {
    have.add(norm(n));
    haveBase.add(baseName(n));
  }
  const isMissing = (n: string) =>
    !have.has(norm(n)) && !haveBase.has(baseName(n));
  return {
    models: [...new Set(recipe.models.map((m) => m.name).filter(isMissing))],
    loras: [...new Set(recipe.loras.map((l) => l.name).filter(isMissing))],
  };
}
