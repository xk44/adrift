/**
 * LTX VFX shots: ready-made Boards that chain the LTX-2.5 tools so one run
 * gives a finished VFX shot. Every chained step is an LTX-2.5 tool
 * (ltx25_animate or an ltx_* VFX LoRA, src/lib/oj/ltxVfx.ts); the first step
 * is the user's own clip or photo. Each step is an ordinary Adrift run on
 * the previous step's output, executed by boardRunner.ts, so a shot can be
 * tweaked, re-run from any step or extended like any other board.
 *
 *   Night Rain Shot      clip  -> Day to Night -> Add Water
 *   Clean Plate + Matte  clip  -> Clean Plate   |  clip -> Alpha Matte
 *   Living Photo         photo -> Cinemagraph   |  photo -> Slow Motion
 *
 * Two-lane shots link their first step: one pick feeds both lanes, so the
 * outputs come from the same source. There is no core-node composite step
 * that takes two clips, so the plate and the matte are delivered as a pair.
 */
import type { HubCard } from "./hub";
import type { EngineContext } from "./templates";
import type { BadgeSource } from "./licenseBadges";
import weightClassesJson from "./toolWeightClasses.json";
import {
  BOARD_CLIP,
  BOARD_SOURCE,
  boardTool,
  isPickStep,
  stepIssue,
  type Board,
  type BoardLane,
  type BoardsState,
} from "./board";

export const LTX_SHOT_PACK = "ltx25";

export interface LtxShotStep {
  tool: string;
  /** Prefilled text (the user can edit it on the board). */
  text?: string;
}

export interface LtxShotLane {
  title: string;
  steps: LtxShotStep[];
}

export interface LtxShotRecipe {
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  model: string;
  aliases: string[];
  lanes: LtxShotLane[];
}

export const LTX_SHOT_RECIPES: readonly LtxShotRecipe[] = [
  {
    id: "night_rain",
    title: "Night Rain Shot",
    subtitle:
      "LTX VFX: a daytime clip relit as night, then rain and wet streets added, in one run",
    icon: "Moon",
    model: "LTX-2.5 22B + IC-LoRA Day-To-Night + Water-Simulation",
    aliases: ["rain", "night", "storm", "noir", "relight", "weather"],
    lanes: [
      {
        title: "Night rain",
        steps: [
          { tool: BOARD_CLIP },
          {
            tool: "ltx_day_to_night",
            text: "warm street lamps, lit windows, deep blue night sky",
          },
          {
            tool: "ltx_add_water",
            text: "heavy rain falls, puddles ripple on the wet ground and reflect the lights",
          },
        ],
      },
    ],
  },
  {
    id: "plate_matte",
    title: "Clean Plate + Matte",
    subtitle:
      "LTX VFX: the empty background plate and an alpha matte of the subject, both from one clip",
    icon: "Layers",
    model: "LTX-2.5 22B + IC-LoRA Clean-Plate + Alpha-Gen",
    aliases: [
      "compositing",
      "roto",
      "rotoscope",
      "key",
      "background plate",
      "luma matte",
    ],
    lanes: [
      {
        title: "Clean plate",
        steps: [{ tool: BOARD_CLIP }, { tool: "ltx_clean_plate" }],
      },
      {
        title: "Alpha matte",
        steps: [{ tool: BOARD_CLIP }, { tool: "ltx_alpha_matte" }],
      },
    ],
  },
  {
    id: "living_photo",
    title: "Living Photo",
    subtitle:
      "LTX VFX: one photo becomes a seamless cinemagraph loop and a slow-motion shot",
    icon: "Sparkles",
    model: "LTX-2.5 22B + LoRA Cinemagraph + Slow-Motion-Control",
    aliases: [
      "cinemagraph",
      "slow motion",
      "loop",
      "photo to video",
      "animate",
    ],
    lanes: [
      {
        title: "Cinemagraph loop",
        steps: [{ tool: BOARD_SOURCE }, { tool: "ltx_cinemagraph" }],
      },
      {
        title: "Slow motion",
        steps: [{ tool: BOARD_SOURCE }, { tool: "ltx_slow_motion" }],
      },
    ],
  },
];

export const LTX_SHOT_KEY_PREFIX = "special:ltx_shot_";

export function ltxShotKey(id: string): string {
  return `${LTX_SHOT_KEY_PREFIX}${id}`;
}

export function ltxShotForKey(key: string): LtxShotRecipe | undefined {
  if (!key.startsWith(LTX_SHOT_KEY_PREFIX)) return undefined;
  const id = key.slice(LTX_SHOT_KEY_PREFIX.length);
  return LTX_SHOT_RECIPES.find((r) => r.id === id);
}

/** LTX-2 Community License sources (the VFX LoRAs share them). */
function ltxSources(): BadgeSource[] {
  const file = weightClassesJson as unknown as {
    sources?: Record<string, BadgeSource[]>;
  };
  return file.sources?.["action:ltx_day_to_night"] ?? [];
}

/** Hub cards: "LTX VFX" section, gated on the LTX-2.5 pack. */
export function ltxShotCards(ctx: EngineContext): HubCard[] {
  const packsKnown = !!ctx.packIds;
  const has = packsKnown && ctx.packIds!.has(LTX_SHOT_PACK);
  return LTX_SHOT_RECIPES.map((r) => ({
    key: ltxShotKey(r.id),
    kind: "special",
    id: `ltx_shot_${r.id}`,
    title: r.title,
    subtitle: r.subtitle,
    icon: r.icon,
    hubCategory: "VFX",
    available: has,
    unavailableReason:
      packsKnown && !has ? "The LTX-2.5 pack is not installed." : null,
    licenseNote: null,
    checking: !packsKnown,
    model: r.model,
    nc: false,
    weights: "cap",
    weightSources: ltxSources(),
    aliases: [...r.aliases, "ltx", "vfx", "pipeline", "chain", "shot"],
  }));
}

/** Media typing of a recipe lane: per-step placement issues (pick steps ignored). */
export function recipeLaneIssues(lane: LtxShotLane): (string | null)[] {
  const board: BoardLane = {
    id: "check",
    title: lane.title,
    steps: lane.steps.map((s, i) => ({
      id: `s${i}`,
      tool: s.tool,
      text: s.text ?? "",
      status: "idle",
      // Pretend the pick is made: only typing and text are checked here.
      ...(i === 0 ? { runId: "picked" } : {}),
    })),
  };
  return board.steps.map((_, i) => {
    if (!boardTool(board.steps[i].tool)) return "Unknown tool";
    return stepIssue(board, i);
  });
}

/** A fresh board for the recipe (ids from `makeId`, all steps idle). */
export function boardFromRecipe(
  recipe: LtxShotRecipe,
  makeId: (prefix: string) => string,
  now: number,
): Board {
  return {
    id: makeId("board"),
    title: recipe.title,
    recipe: recipe.id,
    ...(recipe.lanes.length > 1 ? { linkedSource: true } : {}),
    updatedAt: now,
    lanes: recipe.lanes.map((l) => ({
      id: makeId("lane"),
      title: l.title,
      steps: l.steps.map((s) => ({
        id: makeId("step"),
        tool: s.tool,
        text: s.text ?? "",
        status: "idle" as const,
      })),
    })),
  };
}

/**
 * Board to open for a recipe card: the newest board made from it that has
 * not run yet (reopening the card does not pile up empty boards), or null
 * when a new one should be made.
 */
export function reusableRecipeBoard(
  state: BoardsState,
  recipeId: string,
): string | null {
  const fresh = state.boards.filter(
    (b) =>
      b.recipe === recipeId &&
      b.lanes.every((l) =>
        l.steps.every(
          (s, i) => (i === 0 && isPickStep(s.tool)) || s.status === "idle",
        ),
      ),
  );
  if (!fresh.length) return null;
  return fresh.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)).id;
}
