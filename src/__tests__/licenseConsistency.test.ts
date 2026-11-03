/**
 * License single source of truth: MODEL_FAMILIES (toolsDoc.ts) says which
 * weights are non-commercial. Every other license signal must agree with the
 * models the tool's ComfyUI graphs actually load:
 *
 *   - hub cards: nc badge <=> some loaded model is commercial "no"
 *   - catalog registry: license.commercial === false <=> same
 *   - edit engines (templates / apps / pipelines): license <=> worst family
 *
 * "restricted" (revenue cap, territory, copyleft) is NOT nc: Krea 2, FLUX.3
 * Klein, Stable Audio 3, MiniMax H3 and LTXV 0.9.8 carry no nc badge.
 * Catalog tools count their own run-time LoRAs too (the Krea 2 V2 edit
 * LoRA is non-commercial on a revenue-capped base).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  buildToolDocRows,
  familyFor,
  workflowRelForAction,
  workflowWeightFiles,
  worstCommercial,
  type Commercial,
  type ModelFamily,
} from "@/lib/tools/toolsDoc";
import { CARD_OVERRIDES, toHubCard } from "@/lib/tools/hub";
import { EDIT_ENGINES, type EngineLicense } from "@/lib/tools/templates";
import {
  STATIC_WORKFLOWS,
  getEditTools,
  toolLicense,
} from "@/lib/tools/editTools";
import { getPack } from "@/lib/oj/packs";
import type { CatalogTool, ToolCard } from "@/lib/tools/toolsPage";
import type { Workflow } from "@/types";

const WF_DIR = path.resolve(__dirname, "../../public/workflows");
const PACKS_DIR = path.join(WF_DIR, "packs");

function loadWorkflow(rel: string): Workflow | null {
  const p = path.join(WF_DIR, rel);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Workflow;
}

function walkJson(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return walkJson(p);
    return p.endsWith(".json") ? [p] : [];
  });
}

/** Weight files plus loaders that take a model directory (SeFi). */
function packModelRefs(wf: Workflow): string[] {
  const refs = workflowWeightFiles(wf);
  for (const node of Object.values(wf)) {
    const dir = node?.inputs?.model_dir;
    if (typeof dir === "string") refs.push(dir);
  }
  return refs;
}

function isWorkflow(v: unknown): v is Workflow {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.values(v).some(
      (n) => !!n && typeof n === "object" && "class_type" in n,
    )
  );
}

function familiesOf(rel: string): ModelFamily[] {
  const wf = loadWorkflow(rel);
  if (!wf) throw new Error(`missing workflow ${rel}`);
  const out: ModelFamily[] = [];
  for (const file of workflowWeightFiles(wf)) {
    const fam = familyFor(file);
    if (fam && !out.includes(fam)) out.push(fam);
  }
  return out;
}

/** Base-graph families plus the catalog tool's own (run-time) LoRAs. */
function withLoras(
  fams: ModelFamily[],
  loras: { file: string }[],
): ModelFamily[] {
  const out = [...fams];
  for (const l of loras) {
    const fam = familyFor(l.file);
    if (fam && !out.includes(fam)) out.push(fam);
  }
  return out;
}

const worst = (fams: ModelFamily[]): Commercial =>
  worstCommercial(fams.map((f) => f.commercial));

const built = buildToolDocRows(loadWorkflow);

describe("every pack model has a license", () => {
  it("each weight file / model dir under packs/** maps to a MODEL_FAMILIES entry", () => {
    const unmapped: string[] = [];
    let graphs = 0;
    for (const file of walkJson(PACKS_DIR)) {
      const json: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!isWorkflow(json)) continue;
      graphs++;
      for (const ref of packModelRefs(json))
        if (!familyFor(ref))
          unmapped.push(`${path.relative(PACKS_DIR, file)}: ${ref}`);
    }
    expect(graphs).toBeGreaterThan(50);
    expect(unmapped).toEqual([]);
  });

  it("the tools doc resolves every tool graph", () => {
    expect(built.unmapped).toEqual([]);
    expect(built.missingWorkflows).toEqual([]);
  });
});

function fakeCard(key: string): ToolCard {
  const [kind, id] = key.split(":") as ["action" | "catalog", string];
  return {
    key,
    kind,
    id,
    title: id,
    subtitle: "",
    category: "Edit",
    icon: "Wand",
    available: true,
    unavailableReason: null,
    licenseNote: null,
    checking: false,
  };
}

const CATALOG = getEditTools().map(
  (t) =>
    ({
      id: t.id,
      base: t.base,
      baseLabel: t.base,
      license: toolLicense(t),
    }) as unknown as CatalogTool,
);

describe("hub nc badge matches the models the tool loads", () => {
  for (const row of built.rows) {
    const fams = row.families.map((f) => `${f.id}:${f.commercial}`);
    it(`${row.key} [${fams.join(", ") || "no graph models"}]`, () => {
      const card = toHubCard(fakeCard(row.key), CATALOG);
      expect(card.nc).toBe(worst(row.families) === "no");
    });
  }

  it("no nc override names a card the doc does not know", () => {
    const keys = new Set(built.rows.map((r) => r.key));
    const stale = Object.entries(CARD_OVERRIDES)
      .filter(([, o]) => o.nc !== undefined)
      .map(([k]) => k)
      .filter((k) => !keys.has(k));
    expect(stale).toEqual([]);
  });
});

describe("catalog registry licenses match the base graph", () => {
  for (const tool of getEditTools()) {
    it(`catalog:${tool.id}`, () => {
      const rel =
        STATIC_WORKFLOWS[tool.packAction] ??
        workflowRelForAction(tool.packAction);
      expect(rel, `no workflow for ${tool.packAction}`).toBeTruthy();
      const nc = worst(withLoras(familiesOf(rel!), tool.loras)) === "no";
      expect(toolLicense(tool).commercial === false).toBe(nc);
    });
  }
});

const ENGINE_STATUS: Record<EngineLicense, Commercial> = {
  apache: "yes",
  nc: "no",
  cap: "restricted",
  check: "unverified",
};

describe("edit engine licenses match their graphs", () => {
  for (const engine of Object.values(EDIT_ENGINES)) {
    it(engine.id, () => {
      let rel: string | undefined;
      let loras: { file: string }[] = [];
      if (engine.run.kind === "catalog") {
        const id = engine.run.toolId;
        const tool = getEditTools().find((t) => t.id === id);
        expect(tool, `catalog tool ${id}`).toBeTruthy();
        loras = tool!.loras;
        rel =
          STATIC_WORKFLOWS[tool!.packAction] ??
          workflowRelForAction(tool!.packAction);
      } else {
        rel =
          getPack(engine.run.pack)?.workflows[engine.run.action] ??
          workflowRelForAction(engine.run.action);
      }
      expect(rel, `no workflow for engine ${engine.id}`).toBeTruthy();
      expect(ENGINE_STATUS[engine.license]).toBe(
        worst(withLoras(familiesOf(rel!), loras)),
      );
    });
  }
});
