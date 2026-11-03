/**
 * Builds toolWeightClasses.json (see openWeights.ts) from the toolsDoc data:
 * MODEL_FAMILIES matched against the weight files of each tool's graph.
 * Test/server side only (toolsDoc pulls in editTools, which reads the disk).
 */

import { H3_MODEL_NAME } from "./h3License";
import {
  isRevenueCapLicense,
  sourceFor,
  worstBadge,
  bestBadge,
  type BadgeSource,
  type LicenseBadge,
} from "./licenseBadges";
import type { ActionToolSpec } from "./toolsPage";
import {
  EXTRA_FAMILIES,
  MODEL_FAMILIES,
  familyFor,
  workflowRelForAction,
  workflowWeightFiles,
  type LoadWorkflow,
  type ModelFamily,
  type ToolDocRow,
} from "./toolsDoc";

/** Region-restricted family: the MiniMax H3 Community License territory carve-out. */
export function isRegionRestrictedFamily(
  f: Pick<ModelFamily, "license">,
): boolean {
  return f.license.includes(H3_MODEL_NAME);
}

/**
 * Badge of one model family. "restricted" in the docs covers several
 * conditions: a revenue cap (Krea 2, FLUX.3 Klein, LTX, Stable Audio 3) is
 * "cap", the H3 territory carve-out is "region", and the rest (Gemma terms,
 * AGPL runtime) allow commercial use, so "open".
 */
export function familyBadge(
  f: Pick<ModelFamily, "license" | "commercial">,
): LicenseBadge {
  if (f.commercial === "no") return "nc";
  if (isRegionRestrictedFamily(f)) return "region";
  if (f.commercial === "unverified") return "check";
  if (f.commercial === "restricted" && isRevenueCapLicense(f.license))
    return "cap";
  return "open";
}

/** Badge of one toolsDoc row: the most limiting of its families. */
export function classifyDocRow(
  row: Pick<ToolDocRow, "commercial" | "families">,
): LicenseBadge {
  if (row.commercial === "no") return "nc";
  if (!row.families.length && row.commercial === "unverified") return "check";
  return classifyFamilies(row.families);
}

export function classifyFamilies(
  families: Pick<ModelFamily, "license" | "commercial">[],
): LicenseBadge {
  return worstBadge(families.map(familyBadge));
}

/** The licenses that put a tool on its badge (empty for open). */
export function badgeSources(
  badge: LicenseBadge,
  families: Pick<ModelFamily, "license" | "commercial" | "url">[],
): BadgeSource[] {
  if (badge === "open") return [];
  const out: BadgeSource[] = [];
  for (const f of families) {
    if (familyBadge(f) !== badge) continue;
    if (out.some((s) => s.license === f.license)) continue;
    out.push(sourceFor(f.license, f.url));
  }
  return out;
}

/**
 * Families an action card always loads: its own action and model-check
 * graphs plus EXTRA_FAMILIES, not the optional modes its pickers add (Motion
 * presets runs on Wan; a few presets route to the optional H3 pack). Null
 * when the card has no graph of its own (it resolves through other actions).
 */
export function requiredActionFamilies(
  spec: ActionToolSpec,
  load: LoadWorkflow,
): ModelFamily[] | null {
  const actions = [
    spec.id as string,
    ...(spec.modelCheck ? [spec.modelCheck.action] : []),
  ];
  const out: ModelFamily[] = [];
  let found = false;
  for (const action of new Set(actions)) {
    const rel = workflowRelForAction(action);
    const wf = rel ? load(rel) : null;
    if (!wf) continue;
    found = true;
    for (const file of workflowWeightFiles(wf)) {
      const fam = familyFor(file);
      if (fam && !out.includes(fam)) out.push(fam);
    }
  }
  if (!found) return null;
  for (const id of EXTRA_FAMILIES[spec.id] ?? []) {
    const fam = MODEL_FAMILIES.find((f) => f.id === id);
    if (fam && !out.includes(fam)) out.push(fam);
  }
  return out;
}

export interface WeightTable {
  classes: Record<string, LicenseBadge>;
  /** Non-open cards only: the licenses behind the badge (for its tooltip). */
  sources: Record<string, BadgeSource[]>;
}

/**
 * Card key -> badge for every toolsDoc row (sorted). Action cards with a
 * graph of their own use requiredActionFamilies; the rest use the whole row.
 * The folded Outpaint card runs the best installed backend, so it takes the
 * most permissive backend's badge.
 */
export function buildWeightTable(opts: {
  rows: Pick<ToolDocRow, "key" | "commercial" | "families">[];
  actionTools: ActionToolSpec[];
  load: LoadWorkflow;
  outpaintKeys?: string[];
  outpaintCardKey?: string;
}): WeightTable {
  const classes: Record<string, LicenseBadge> = {};
  const sources: Record<string, BadgeSource[]> = {};
  const set = (key: string, badge: LicenseBadge, fams: ModelFamily[]) => {
    classes[key] = badge;
    const src = badgeSources(badge, fams);
    if (src.length) sources[key] = src;
    else delete sources[key];
  };
  for (const row of opts.rows)
    set(row.key, classifyDocRow(row), row.families as ModelFamily[]);
  for (const spec of opts.actionTools) {
    const key = `action:${spec.id}`;
    if (!(key in classes)) continue;
    const fams = requiredActionFamilies(spec, opts.load);
    if (fams) set(key, classifyFamilies(fams), fams);
  }
  const backends = (opts.outpaintKeys ?? []).filter((k) => classes[k]);
  if (backends.length) {
    const best = bestBadge(backends.map((k) => classes[k]));
    const from = backends.find((k) => classes[k] === best)!;
    const card = opts.outpaintCardKey ?? "catalog:outpaint";
    classes[card] = best;
    if (sources[from]) sources[card] = sources[from];
    else delete sources[card];
  }
  const sorted = <T>(o: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(o).sort(([a], [b]) => a.localeCompare(b)),
    );
  return { classes: sorted(classes), sources: sorted(sources) };
}

/** Card key -> badge (see buildWeightTable). */
export function buildWeightClasses(
  opts: Parameters<typeof buildWeightTable>[0],
): Record<string, LicenseBadge> {
  return buildWeightTable(opts).classes;
}
