import type { GalleryImage, ImageAttachment } from "@/types";

// Tunable prompt-bar image-prompt weights for remix composition.
export const REMIX_WEIGHT_SUBTLE = 2.0;
export const REMIX_WEIGHT_STRONG = 0.75;

export type RemixVariant = "subtle" | "strong";

export interface RemixComposition {
  prompt: string;
  attachments: ImageAttachment[];
}

interface BuildRemixCompositionOptions {
  createId?: () => string;
}

const createAttachmentId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `remix-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export const stripSeedFromPrompt = (prompt: string): string =>
  prompt
    .replace(/(^|\s)--seed\s+\d+\b/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

export const getRemixWeight = (variant: RemixVariant): number =>
  variant === "subtle" ? REMIX_WEIGHT_SUBTLE : REMIX_WEIGHT_STRONG;

export function buildRemixComposition(
  image: Pick<GalleryImage, "url" | "prompt" | "fullPrompt" | "sourceImages">,
  variant: RemixVariant,
  options: BuildRemixCompositionOptions = {},
): RemixComposition {
  const createId = options.createId ?? createAttachmentId;
  const outputUrl = image.url;
  const attachments: ImageAttachment[] = [];

  if (outputUrl) {
    attachments.push({
      id: createId(),
      url: outputUrl,
      mode: "image_prompt",
      weight: getRemixWeight(variant),
    });
  }

  for (const source of image.sourceImages ?? []) {
    if (!source.url || source.url === outputUrl) continue;
    attachments.push({
      ...source,
      id: createId(),
    });
  }

  return {
    prompt: stripSeedFromPrompt(image.fullPrompt || image.prompt),
    attachments,
  };
}
