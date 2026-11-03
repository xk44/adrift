/**
 * Apply a run's values to a user tool's saved graph (pure).
 *
 *  - Only exposed params take user values; others keep the graph value.
 *  - Numbers are clamped to the input's min/max; steps/seed/size are ints.
 *  - Seeds left empty (or -1) are randomized so each run makes something new;
 *    seeds the user did not expose are randomized too.
 *  - Media params take an already-uploaded ComfyUI file name; every exposed
 *    media param must get one (the graph's own file is not on this machine).
 */

import type { Workflow } from "@/types";
import { MAX_RANDOM_SEED } from "@/lib/oj/inputSpec";
import {
  MEDIA_PARAM_KINDS,
  type UserToolParam,
  type UserToolRecord,
} from "./types";

export class UserToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserToolInputError";
  }
}

const MAX_TEXT = 20_000;
const INT_KINDS = new Set(["seed", "steps", "width", "height"]);

function clamp(n: number, min?: number, max?: number): number {
  let v = n;
  if (typeof min === "number") v = Math.max(min, v);
  if (typeof max === "number") v = Math.min(max, v);
  return v;
}

export function randomSeed(rand: () => number = Math.random): number {
  return Math.floor(rand() * MAX_RANDOM_SEED);
}

function coerceValue(
  p: UserToolParam,
  raw: unknown,
  rand: () => number,
): string | number | undefined {
  switch (p.kind) {
    case "prompt":
    case "negative": {
      if (raw === undefined || raw === null) return undefined;
      if (typeof raw !== "string")
        throw new UserToolInputError(`${p.label} must be text`);
      if (raw.length > MAX_TEXT)
        throw new UserToolInputError(`${p.label} is too long`);
      return raw;
    }
    case "seed": {
      if (raw === undefined || raw === null || raw === "" || raw === -1)
        return randomSeed(rand);
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n))
        throw new UserToolInputError(`${p.label} must be a number`);
      return Math.trunc(clamp(n, 0, p.max ?? Number.MAX_SAFE_INTEGER));
    }
    default: {
      if (raw === undefined || raw === null || raw === "") return undefined;
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n))
        throw new UserToolInputError(`${p.label} must be a number`);
      const v = clamp(n, p.min, p.max);
      return INT_KINDS.has(p.kind) ? Math.round(v) : v;
    }
  }
}

export interface ApplyOptions {
  /** param key -> value (exposed text/number params). */
  values?: Record<string, unknown>;
  /** param key -> uploaded ComfyUI file name (exposed media params). */
  media?: Record<string, string>;
  rand?: () => number;
}

export interface AppliedTool {
  workflow: Workflow;
  /** The values actually used (for run metadata). */
  used: Record<string, string | number>;
}

export function applyUserToolParams(
  tool: Pick<UserToolRecord, "workflow" | "params">,
  opts: ApplyOptions = {},
): AppliedTool {
  const rand = opts.rand ?? Math.random;
  const values = opts.values ?? {};
  const media = opts.media ?? {};
  const workflow = structuredClone(tool.workflow) as Workflow;
  const used: Record<string, string | number> = {};

  for (const p of tool.params) {
    const node = workflow[p.nodeId];
    if (!node || !node.inputs) continue;
    if (MEDIA_PARAM_KINDS.has(p.kind)) {
      if (!p.exposed) continue;
      const ref = media[p.key];
      if (typeof ref !== "string" || !ref) {
        throw new UserToolInputError(
          `Choose a file for "${p.label}" first`,
        );
      }
      node.inputs[p.input] = ref;
      used[p.key] = ref;
      continue;
    }
    if (!p.exposed) {
      if (p.kind === "seed") {
        const s = randomSeed(rand);
        node.inputs[p.input] = s;
        used[p.key] = s;
      }
      continue;
    }
    const v = coerceValue(p, values[p.key], rand);
    if (v === undefined) continue;
    node.inputs[p.input] = v;
    used[p.key] = v;
  }
  return { workflow, used };
}

/** The first exposed prompt value, for the run's prompt line. */
export function promptLine(
  tool: Pick<UserToolRecord, "params" | "name">,
  used: Record<string, string | number>,
): string {
  const p = tool.params.find((x) => x.exposed && x.kind === "prompt");
  const v = p ? used[p.key] : undefined;
  return typeof v === "string" && v.trim() ? v.trim() : tool.name;
}
