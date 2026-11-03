/**
 * Product Studio: one product photo (or a text description) in, FLUX.3 hero
 * shots out in several looks (studio, lifestyle, billboard with a headline,
 * flat-lay), each one handed on to LTX-2.5 "Animate" when wanted.
 *
 * FLUX.3 Klein is the only image model here: every look is the flux3 pack's
 * reference edit (packs/flux3/edit.json, ReferenceMultiLatent) and the
 * prompt mode's packshot is the flux3 text-to-image graph. Base model at
 * 50 steps; the edit runs at CFG 1 (its guidance comes from the reference).
 *
 * FLUX.3 reads prompts as captions of the finished image, so each look is a
 * full scene description ("write the result, not the change") that names
 * the product as "the product from image 1" and quotes any headline exactly.
 */
import type { ImagineRun } from "@/types";
import type { HubCard } from "./hub";
import { EDIT_ENGINES, engineSources, type EngineContext } from "./templates";
import type { ToolHandoff } from "./toolHandoff";
import {
  ToolApiError,
  sourceRunFor,
  type FetchLike,
  type PreparedSource,
  type ToolImage,
} from "./runTool";
import { pickFinalOutput } from "./pickOutput";
import { promptIdOf, waitForOutputs, type RunnerDeps } from "./pipelineRunner";

export const PRODUCT_STUDIO_KEY = "special:product_studio";
export const PRODUCT_STUDIO_PACK_ID = "flux3";
/** Reference edit on the base FLUX.3 Klein model (packs/flux3/edit.json). */
export const PRODUCT_STUDIO_EDIT_ACTION = "edit_flux3";
/** Prompt mode's packshot (no photo): FLUX.3 Klein text-to-image. */
export const PRODUCT_STUDIO_T2I_WORKFLOW = "packs/flux3/t2i.json";
export const PRODUCT_STUDIO_MODEL_LINE = "FLUX.3 Klein (base, 50 steps)";
/** LTX-2.5 image-to-video card the result hands off to. */
export const PRODUCT_STUDIO_ANIMATE_KEY = "action:ltx25_animate";

/** KSampler "7" in both flux3 graphs: base model quality settings. */
export const PRODUCT_STUDIO_EDIT_OVERRIDES: Readonly<Record<string, number>> = {
  "7.steps": 50,
  "7.cfg": 1,
};
export const PRODUCT_STUDIO_T2I_OVERRIDES: Readonly<Record<string, number>> = {
  "7.steps": 50,
  "7.cfg": 3.5,
};

export type ProductLookId = "studio" | "lifestyle" | "billboard" | "flatlay";

export interface ProductLook {
  id: ProductLookId;
  label: string;
  blurb: string;
  /** Default motion text for the LTX hand-off. */
  motion: string;
}

export const PRODUCT_LOOKS: readonly ProductLook[] = [
  {
    id: "studio",
    label: "Studio",
    blurb: "Seamless backdrop, softbox light",
    motion:
      "Slow push-in on the product, soft light sweeps across its surface, the camera settles.",
  },
  {
    id: "lifestyle",
    label: "Lifestyle",
    blurb: "In use at home, window light",
    motion:
      "Gentle handheld drift, sunlight flickers through leaves outside the window, steam rises from the mug.",
  },
  {
    id: "billboard",
    label: "Billboard",
    blurb: "Street billboard with your headline",
    motion:
      "Slow upward tilt toward the billboard as clouds drift past and evening light warms the street.",
  },
  {
    id: "flatlay",
    label: "Flat-lay",
    blurb: "Top-down styled arrangement",
    motion:
      "Slow overhead rotation, soft shadows shift as light moves across the arrangement.",
  },
];

export const DEFAULT_HEADLINE = "Simply better.";
export const MAX_HEADLINE = 40;
export const MAX_PRODUCT_TEXT = 200;

export function productLook(id: string): ProductLook | undefined {
  return PRODUCT_LOOKS.find((l) => l.id === id);
}

/** One line, no prompt flags ("--ar"), no quotes that would break quoting. */
function clean(text: string | undefined, max: number): string {
  return (text ?? "")
    .replace(/-{2,}/g, " ")
    .replace(/["“”]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

export function cleanHeadline(text: string | undefined): string {
  return clean(text, MAX_HEADLINE) || DEFAULT_HEADLINE;
}

/** How each look names the product: the reference, plus what it is. */
function productPhrase(product: string): string {
  const what = clean(product, MAX_PRODUCT_TEXT);
  return what
    ? `the exact product from image 1 (${what})`
    : "the exact product from image 1";
}

const IDENTITY =
  "Keep the product identical to image 1: same shape, proportions, colors, materials, label artwork and printed text, nothing added to or removed from it.";

/** Full-caption FLUX.3 prompt for one look. */
export function compileLookPrompt(
  look: ProductLookId,
  opts: { product?: string; headline?: string } = {},
): string {
  const p = productPhrase(opts.product ?? "");
  switch (look) {
    case "studio":
      return [
        `A high-end studio product photograph of ${p}, standing upright and centered on a seamless warm light-gray paper backdrop that curves smoothly into the floor.`,
        "Large softbox key light from the upper left, a subtle rim light outlining its edges, a soft natural contact shadow beneath it.",
        "Crisp focus across the whole product, clean commercial catalog packshot, 85mm lens, eye-level camera, generous empty space around it.",
        IDENTITY,
      ].join(" ");
    case "lifestyle":
      return [
        `A lifestyle photograph of ${p} in everyday use, resting on a light oak table in a bright, airy home beside a ceramic mug, a folded linen napkin and a small green plant.`,
        "Warm morning sunlight through a nearby window, soft shadows, shallow depth of field with the room softly blurred behind.",
        "The product is the sharp focal point in the foreground, natural editorial magazine photography.",
        IDENTITY,
      ].join(" ");
    case "billboard": {
      // Curly quotes: the prompt parser drops straight ones around a token.
      const headline = cleanHeadline(opts.headline);
      return [
        "A photograph of a large roadside billboard at golden hour, seen straight on and filling most of the frame.",
        `The billboard is a clean advertisement on a solid deep navy-blue background. Across the top, one line of large bold white sans-serif text reads \u201c${headline}\u201d, perfectly legible and spelled exactly. Below the text, ${p} stands centered, large and sharply printed.`,
        "Warm evening light, a few soft clouds in the sky above a city street.",
        IDENTITY,
      ].join(" ");
    }
    case "flatlay":
      return [
        `A top-down flat-lay photograph shot directly from above of ${p} lying in the center of a smooth pastel sand-colored surface.`,
        "Around it, neatly arranged complementary props with plenty of space between them: a sprig of dried eucalyptus, a folded cotton cloth, two smooth pebbles and a small ceramic dish.",
        "Even soft daylight, gentle shadows, balanced minimalist styling, sharp focus, overhead commercial product photography.",
        IDENTITY,
      ].join(" ");
  }
}

/** Prompt mode: the packshot every look is built from (text-to-image). */
export function compilePackshotPrompt(description: string): string {
  const what = clean(description, MAX_PRODUCT_TEXT);
  if (!what) throw new ToolApiError("Describe the product first.");
  return [
    `A clean studio product photograph of ${what}, the entire product visible, standing upright and centered on a plain seamless off-white backdrop.`,
    "Soft even lighting, a gentle contact shadow, sharp focus on every detail, label and printed text crisp and legible, commercial packshot.",
    "--ar 4:5",
  ].join(" ");
}

/** POST /api/jobs/action body (minus run/client) for one look. */
export function productLookRequest(
  look: ProductLookId,
  opts: { product?: string; headline?: string } = {},
): {
  action: string;
  params: { pack_id: string; prompt: string };
  workflow_control_overrides: Record<string, number>;
} {
  return {
    action: PRODUCT_STUDIO_EDIT_ACTION,
    params: {
      pack_id: PRODUCT_STUDIO_PACK_ID,
      prompt: compileLookPrompt(look, opts),
    },
    workflow_control_overrides: { ...PRODUCT_STUDIO_EDIT_OVERRIDES },
  };
}

/** POST /api/jobs/imagine body for the prompt-mode packshot. */
export function packshotRequest(
  description: string,
  clientId: string,
): {
  prompt: string;
  client_id: string;
  workflow_path: string;
  batch_size: number;
  workflow_control_overrides: Record<string, number>;
} {
  return {
    prompt: compilePackshotPrompt(description),
    client_id: clientId,
    workflow_path: PRODUCT_STUDIO_T2I_WORKFLOW,
    batch_size: 1,
    workflow_control_overrides: { ...PRODUCT_STUDIO_T2I_OVERRIDES },
  };
}

export function productStudioCard(ctx: EngineContext): HubCard {
  const known = !!ctx.packIds;
  const ok = known && ctx.packIds!.has(PRODUCT_STUDIO_PACK_ID);
  return {
    key: PRODUCT_STUDIO_KEY,
    kind: "special",
    id: "product_studio",
    title: "Product Studio",
    subtitle:
      "FLUX 3 hero shots of one product: studio, lifestyle, headline billboard, flat-lay",
    icon: "Camera",
    hubCategory: "Ads",
    available: ok,
    unavailableReason:
      known && !ok
        ? "The flux3 (FLUX.3 Klein) pack isn't installed on this server."
        : null,
    licenseNote: null,
    checking: !known,
    model: PRODUCT_STUDIO_MODEL_LINE,
    nc: false,
    weights: "cap",
    // FLUX Kommunity License (same terms as the FLUX.3 edit engine).
    weightSources: engineSources(EDIT_ENGINES.flux3),
    aliases: [
      "flux 3",
      "flux3",
      "product photo",
      "packshot",
      "hero shot",
      "ad stills",
      "billboard",
      "flat lay",
      "ecommerce",
    ],
  };
}

/** Hand a finished look to the LTX-2.5 Animate card. */
export function animateHandoff(args: {
  runId: string;
  jobIndex: number;
  url: string;
  label: string;
  width: number;
  height: number;
  now: number;
}): ToolHandoff {
  return {
    toolKey: PRODUCT_STUDIO_ANIMATE_KEY,
    media: "image",
    itemId: `product-studio-${args.runId}-${args.jobIndex}`,
    url: args.url,
    label: args.label,
    width: args.width,
    height: args.height,
    runId: args.runId,
    jobIndex: args.jobIndex,
    at: args.now,
  };
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: Record<string, unknown> = {};
  try {
    data = ((await res.json()) ?? {}) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok || data.ok === false) {
    throw new ToolApiError(
      typeof data.error === "string" && data.error
        ? data.error
        : `Request failed (${res.status})`,
      res.status,
    );
  }
  return data;
}

/**
 * Prompt mode step 1: render the packshot and wait for it, then return it
 * as a gallery source image for the looks.
 */
export async function generatePackshot(
  deps: RunnerDeps,
  description: string,
): Promise<ToolImage> {
  const data = await postJson(
    deps.fetchImpl,
    "/api/jobs/imagine",
    packshotRequest(description, deps.clientId),
  );
  const run = (data.runs as ImagineRun[] | undefined)?.[0];
  if (!run) throw new ToolApiError("Server returned no run");
  deps.onRun?.(run);
  const out = await waitForOutputs(deps, promptIdOf(run));
  const file = pickFinalOutput(out.images);
  if (!file) throw new ToolApiError("The packshot finished without an image.");
  return {
    id: `packshot-${run.run_id}`,
    source: "gallery",
    previewUrl: file.url,
    label: "Packshot",
    width: run.width ?? 896,
    height: run.height ?? 1120,
    runId: run.run_id,
    jobIndex: run.jobs[0]?.index ?? 0,
  };
}

/** Queue one look as a FLUX.3 reference edit of the (shared) source run. */
export async function submitProductLook(args: {
  fetchImpl: FetchLike;
  image: ToolImage;
  look: ProductLookId;
  product?: string;
  headline?: string;
  clientId: string;
  prepared: PreparedSource;
}): Promise<ImagineRun> {
  if (!args.prepared.run) {
    args.prepared.run = await sourceRunFor(
      args.fetchImpl,
      args.image,
      "Product Studio",
    );
  }
  const req = productLookRequest(args.look, {
    product: args.product,
    headline: args.headline,
  });
  const data = await postJson(args.fetchImpl, "/api/jobs/action", {
    run_id: args.prepared.run.runId,
    job_index: args.prepared.run.jobIndex,
    action: req.action,
    client_id: args.clientId,
    params: req.params,
    workflow_control_overrides: req.workflow_control_overrides,
  });
  if (!data.run) throw new ToolApiError("Server returned no run");
  return data.run as ImagineRun;
}
