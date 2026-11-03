/**
 * Assignable workflow sources for the Pipelines slot dropdowns.
 *
 * One typed list merges every graph a slot can be bound to:
 *   - "saved": workflows saved in ComfyUI's user library (`saved:<file>`)
 *   - "pack":  built-in pack graphs (path under public/workflows)
 *   - "user":  imported tools (added by the workflow-import feature via
 *              `registerWorkflowSourceProvider` or the `extra` argument)
 *
 * `workflowPath` is exactly what the job routes accept as `workflow_path`.
 */
import { getAllPacks, type WorkflowPack } from "@/lib/oj/packs";
import type { WorkflowAssignmentSlot } from "@/lib/workflowAssignments";

export type AssignableKind = NonNullable<
  WorkflowAssignmentSlot["recommendedKind"]
>;

export type WorkflowSourceKind = AssignableKind | "unknown";

export type WorkflowSourceOrigin = "saved" | "pack" | "user";

export interface WorkflowSourceEntry {
  /** Stable id, unique across origins (e.g. "pack:krea2:i2i") */
  id: string;
  source: WorkflowSourceOrigin;
  /** Human label shown in the dropdown */
  label: string;
  kind: WorkflowSourceKind;
  /** Value stored in the assignment and sent as workflow_path */
  workflowPath: string;
  packId?: string;
  /** Missing node count, when a runtime check ran */
  missingCount?: number;
}

/** Minimal shape of a saved workflow row from /api/comfy/workflows. */
export interface SavedWorkflowLike {
  name: string;
  file: string;
  kind?: string;
  runtime?: { checked?: boolean; missingCount?: number };
}

/** Pack workflow keys that map cleanly onto an assignable slot kind. */
const PACK_KEY_KIND: Record<string, AssignableKind> = {
  t2i: "t2i",
  t2i_fast: "t2i",
  i2i: "i2i",
  vary_subtle: "i2i",
  vary_strong: "i2i",
  remix_subtle: "i2i",
  remix_strong: "i2i",
  upscale_subtle: "upscale",
  upscale_creative: "upscale",
  inpaint: "inpaint",
  outpaint: "outpaint",
  pan_up: "outpaint",
  pan_down: "outpaint",
  pan_left: "outpaint",
  pan_right: "outpaint",
  zoom_1_5x: "outpaint",
  zoom_2x: "outpaint",
  t2v: "t2v",
  t2v_fast: "t2v",
  i2v: "i2v",
  i2v_fast: "i2v",
  ltx25_animate: "i2v",
  t23d: "t23d",
  i23d: "i23d",
  make_3d_trellis: "i23d",
  t2a: "t2a",
};

export function packKeyToKind(key: string): AssignableKind | undefined {
  return PACK_KEY_KIND[key];
}

const ASSIGNABLE_KINDS = new Set<string>(Object.values(PACK_KEY_KIND));

function toSourceKind(kind: string | undefined): WorkflowSourceKind {
  return kind && ASSIGNABLE_KINDS.has(kind)
    ? (kind as AssignableKind)
    : "unknown";
}

/** One entry per distinct (pack, graph file, kind). */
export function packWorkflowSources(
  packs: readonly WorkflowPack[] = getAllPacks(),
): WorkflowSourceEntry[] {
  const out: WorkflowSourceEntry[] = [];
  for (const pack of packs) {
    const seen = new Set<string>();
    for (const [key, file] of Object.entries(pack.workflows)) {
      const kind = packKeyToKind(key);
      if (!kind || typeof file !== "string" || !file) continue;
      const dedupe = `${file}::${kind}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({
        id: `pack:${pack.id}:${key}`,
        source: "pack",
        label: `${pack.name} · ${key.replace(/_/g, " ")}`,
        kind,
        workflowPath: file,
        packId: pack.id,
      });
    }
  }
  return out;
}

export function savedWorkflowSources(
  saved: readonly SavedWorkflowLike[],
): WorkflowSourceEntry[] {
  return saved.map((wf) => ({
    id: `saved:${wf.file}`,
    source: "saved" as const,
    label: wf.name,
    kind: toSourceKind(wf.kind),
    workflowPath: `saved:${wf.file}`,
    ...(wf.runtime?.checked && typeof wf.runtime.missingCount === "number"
      ? { missingCount: wf.runtime.missingCount }
      : {}),
  }));
}

/** Extension point: extra source providers (e.g. imported user tools). */
export type WorkflowSourceProvider = () => WorkflowSourceEntry[];

const providers = new Set<WorkflowSourceProvider>();

/** Register a provider; returns an unregister function. */
export function registerWorkflowSourceProvider(
  provider: WorkflowSourceProvider,
): () => void {
  providers.add(provider);
  return () => {
    providers.delete(provider);
  };
}

/** Every assignable source: saved, then user, then built-in packs. */
export function listWorkflowSources({
  saved = [],
  packs,
  extra = [],
}: {
  saved?: readonly SavedWorkflowLike[];
  packs?: readonly WorkflowPack[];
  extra?: readonly WorkflowSourceEntry[];
} = {}): WorkflowSourceEntry[] {
  const fromProviders: WorkflowSourceEntry[] = [];
  for (const provider of providers) {
    try {
      fromProviders.push(...provider());
    } catch {
      // A broken provider must not empty the dropdown.
    }
  }
  const all = [
    ...savedWorkflowSources(saved),
    ...extra,
    ...fromProviders,
    ...packWorkflowSources(packs),
  ];
  const seen = new Set<string>();
  return all.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}

export interface SlotSourceGroups {
  /** Sources whose kind matches the slot */
  matching: WorkflowSourceEntry[];
  /** Saved/user sources with no detected kind (user may still pick) */
  unknown: WorkflowSourceEntry[];
}

/**
 * Sources offered for a slot of `kind`. Mismatched kinds are dropped
 * (a text-to-image graph has no image input for an image action), unknown
 * kinds go in their own group. Without a slot kind everything matches.
 */
export function filterSourcesForSlot(
  entries: readonly WorkflowSourceEntry[],
  kind: AssignableKind | undefined,
): SlotSourceGroups {
  if (!kind) return { matching: [...entries], unknown: [] };
  const matching: WorkflowSourceEntry[] = [];
  const unknown: WorkflowSourceEntry[] = [];
  for (const e of entries) {
    if (e.kind === kind) matching.push(e);
    else if (e.kind === "unknown") unknown.push(e);
  }
  return { matching, unknown };
}

/** Whether a workflow of `wfKind` may fill a slot of `slotKind`. */
export function kindFitsSlot(
  wfKind: string | undefined,
  slotKind: AssignableKind | undefined,
): boolean {
  if (!slotKind) return true;
  return wfKind === slotKind;
}

export function findSourceByPath(
  entries: readonly WorkflowSourceEntry[],
  workflowPath: string | null | undefined,
): WorkflowSourceEntry | undefined {
  if (!workflowPath) return undefined;
  return entries.find((e) => e.workflowPath === workflowPath);
}
