/**
 * Client side of Reproduce: fetch / check a recipe, then reopen its tool or
 * Create with the settings filled. Nothing is submitted.
 */

import type { GalleryImage } from "@/types";
import { navigateTo } from "@/hooks/useNavSync";
import { fetchRunImages } from "@/lib/sourceRun";
import { handoffFromGalleryItem } from "@/lib/tools/toolHandoff";
import { useOverlayToolsStore } from "@/store/overlayToolsStore";
import { useToolHandoffStore } from "@/store/toolHandoffStore";
import { useUIStore } from "@/store";
import type { RecipeOffer } from "@/store/recipeStore";
import type { ParsedRecipe } from "./recipe";
import type { ReproducePlan } from "./reproduce";

type ApiReply = Omit<RecipeOffer, "origin" | "fileName"> & {
  ok: boolean;
  error?: string;
};

async function readReply(res: Response): Promise<ApiReply> {
  const d = (await res.json().catch(() => ({}))) as Partial<ApiReply>;
  if (!res.ok || !d.ok || !d.recipe) {
    throw new Error(typeof d.error === "string" ? d.error : `HTTP ${res.status}`);
  }
  return {
    ok: true,
    recipe: d.recipe,
    warnings: Array.isArray(d.warnings) ? d.warnings : [],
    missing: d.missing ?? null,
  };
}

/** Recipe of a library output (stored, or rebuilt from the run's params). */
export async function fetchRunRecipe(
  runId: string,
  jobIndex = 0,
): Promise<Omit<RecipeOffer, "origin">> {
  const q = new URLSearchParams({ run: runId, job: String(jobIndex) });
  const { recipe, warnings, missing } = await readReply(
    await fetch(`/api/recipe?${q}`, { cache: "no-store" }),
  );
  return { recipe, warnings, missing };
}

/** Server check of a recipe read from a file (re-scrubbed, missing models). */
export async function checkRecipe(
  parsed: Extract<ParsedRecipe, { ok: true }>,
): Promise<Omit<RecipeOffer, "origin">> {
  const { recipe, warnings, missing } = await readReply(
    await fetch("/api/recipe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipe: parsed.recipe }),
    }),
  );
  return { recipe, warnings: [...new Set([...parsed.warnings, ...warnings])], missing };
}

/** Open what the plan points at, filled in but not run. */
export async function applyPlan(plan: ReproducePlan): Promise<void> {
  if (plan.kind === "prompt") {
    useUIStore.getState().setPromptValue(plan.prompt);
    navigateTo("create");
    return;
  }
  if (plan.kind !== "tool") return;
  const store = useToolHandoffStore.getState();
  store.offerPrefill(
    Object.keys(plan.prefill).length
      ? { toolKey: plan.toolKey, settings: plan.prefill, at: Date.now() }
      : null,
  );
  if (plan.sourceRunId) {
    const source = await Promise.race([
      fetchRunImages(plan.sourceRunId).catch(() => [] as GalleryImage[]),
      new Promise<GalleryImage[]>((r) => setTimeout(() => r([]), 2000)),
    ]);
    const pick =
      source.find((img) => img.jobIndex === plan.sourceJobIndex) ??
      (source.length === 1 ? source[0] : undefined);
    const handoff = pick ? handoffFromGalleryItem(pick, plan.toolKey, Date.now()) : null;
    if (handoff) store.offer(handoff);
  }
  useOverlayToolsStore.getState().openToolFromLauncher(plan.toolKey, false);
  navigateTo("tools");
}
