/**
 * The recipe the Reproduce panel shows (from a lightbox output or a dropped
 * file), with the server's missing-model check.
 */

import { createWithEqualityFn } from "zustand/traditional";
import type { AdriftRecipe } from "@/lib/recipe/recipe";
import type { MissingModels } from "@/lib/recipe/reproduce";

export interface RecipeOffer {
  recipe: AdriftRecipe;
  warnings: string[];
  /** null = the model list could not be checked (ComfyUI unreachable). */
  missing: MissingModels | null;
  origin: "lightbox" | "file";
  fileName?: string;
}

interface RecipeState {
  offer: RecipeOffer | null;
  show: (offer: RecipeOffer) => void;
  close: () => void;
}

export const useRecipeStore = createWithEqualityFn<RecipeState>((set) => ({
  offer: null,
  show: (offer) => set({ offer }),
  close: () => set({ offer: null }),
}));
