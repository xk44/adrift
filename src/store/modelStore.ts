/**
 * Model Store
 * Manages model/lora/vae aliases and available options from ComfyUI
 */

import { STORAGE_KEYS, legacyAwareJSONStorage } from "@/lib/storageKeys";
import { createWithEqualityFn } from "zustand/traditional";
import { persist } from "zustand/middleware";
import type { ModelAlias, LoraWeight } from "@/types";
import {
  createRequestSequence,
  isAbortError,
} from "@/lib/util/requestSequence";

interface ComfyModelInfo {
  checkpoints: string[];
  loras: string[];
  vaes: string[];
  controlnet: string[];
  upscale_models: string[];
  clip: string[];
  unet: string[];
  ipadapter: string[];
  embeddings: string[];
  gligen: string[];
  hypernetworks: string[];
  animatediff_models: string[];
  diffusers: string[];
  style_models: string[];
  video_models: string[];
  samplers: string[];
  schedulers: string[];
  /** Runtime enum options from ComfyUI object_info, keyed by class_type then input name. */
  enumOptions: Record<string, Record<string, string[]>>;
  /** Input image files from ComfyUI's input folder */
  input_images: string[];
  /** Input video files from ComfyUI's input folder */
  input_videos: string[];
  /** Input audio files from ComfyUI's input folder */
  input_audios: string[];
  lastFetched: number;
}

interface ModelState {
  // Available models from ComfyUI
  available: ComfyModelInfo;
  isLoading: boolean;
  error: string | null;
  
  // User-defined aliases
  aliases: ModelAlias[];
  
  // Default selections
  defaultModel: string | null;
  defaultVae: string | null;
  defaultLoras: LoraWeight[];
}

interface ModelActions {
  // Fetch available models from ComfyUI
  fetchAvailable: (force?: boolean) => Promise<void>;
  
  // Alias management
  addAlias: (alias: ModelAlias) => void;
  removeAlias: (aliasName: string) => void;
  updateAlias: (aliasName: string, update: Partial<ModelAlias>) => void;
  
  // Resolve alias to filename
  resolveAlias: (alias: string, type: "checkpoint" | "lora" | "vae") => string | null;
  
  // Default selections
  setDefaultModel: (model: string | null) => void;
  setDefaultVae: (vae: string | null) => void;
  setDefaultLoras: (loras: LoraWeight[]) => void;
  
  // Error handling
  setError: (error: string | null) => void;
}

type ModelStoreState = ModelState & ModelActions;

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const fetchAvailableSequence = createRequestSequence();

export const useModelStore = createWithEqualityFn<ModelState & ModelActions>()(
  persist(
    (set, get) => ({
      available: {
        checkpoints: [],
        loras: [],
        vaes: [],
        controlnet: [],
        upscale_models: [],
        clip: [],
        unet: [],
        ipadapter: [],
        embeddings: [],
        gligen: [],
        hypernetworks: [],
        animatediff_models: [],
        diffusers: [],
        style_models: [],
        video_models: [],
        samplers: [],
        schedulers: [],
        enumOptions: {},
        input_images: [],
        input_videos: [],
        input_audios: [],
        lastFetched: 0,
      },
      isLoading: false,
      error: null,
      aliases: [],
      defaultModel: null,
      defaultVae: null,
      defaultLoras: [],

      fetchAvailable: async (force = false) => {
        const state = get();
        const now = Date.now();
        
        if (!force && now - state.available.lastFetched < CACHE_DURATION && state.available.checkpoints.length > 0) {
          return;
        }

        const request = fetchAvailableSequence.begin();
        set({ isLoading: true, error: null });

        try {
          const response = await fetch("/api/comfy/models", {
            signal: request.signal,
          });
          const data = await response.json();
          if (!request.isCurrent()) return;

          if (!data.ok) {
            throw new Error(data.error ?? "Failed to fetch models");
          }

          set({
            available: {
              checkpoints: data.checkpoints ?? [],
              loras: data.loras ?? [],
              vaes: data.vaes ?? [],
              controlnet: data.controlnet ?? [],
              upscale_models: data.upscale_models ?? [],
              clip: data.clip ?? [],
              unet: data.unet ?? [],
              ipadapter: data.ipadapter ?? [],
              embeddings: data.embeddings ?? [],
              gligen: data.gligen ?? [],
              hypernetworks: data.hypernetworks ?? [],
              animatediff_models: data.animatediff_models ?? [],
              diffusers: data.diffusers ?? [],
              style_models: data.style_models ?? [],
              video_models: data.video_models ?? [],
              samplers: data.samplers ?? [],
              schedulers: data.schedulers ?? [],
              enumOptions: data.enumOptions ?? {},
              input_images: data.input_images ?? [],
              input_videos: data.input_videos ?? [],
              input_audios: data.input_audios ?? [],
              lastFetched: now,
            },
          });
        } catch (error) {
          if (!request.isCurrent() || isAbortError(error)) return;
          const message = error instanceof Error ? error.message : "Unknown error";
          console.error("[ModelStore] Fetch error:", message);
          set({ error: message });
        } finally {
          if (request.isCurrent()) {
            set({ isLoading: false });
          }
        }
      },

      addAlias: (alias) =>
        set((state) => {
          if (state.aliases.some((a) => a.alias === alias.alias)) {
            return state;
          }
          return { aliases: [...state.aliases, alias] };
        }),

      removeAlias: (aliasName) =>
        set((state) => ({
          aliases: state.aliases.filter((a) => a.alias !== aliasName),
        })),

      updateAlias: (aliasName, update) =>
        set((state) => ({
          aliases: state.aliases.map((a) =>
            a.alias === aliasName ? { ...a, ...update } : a
          ),
        })),

      resolveAlias: (alias, type) => {
        const state = get();
        
        // Check user aliases first
        const userAlias = state.aliases.find(
          (a) => a.alias.toLowerCase() === alias.toLowerCase() && a.type === type
        );
        if (userAlias) {
          return userAlias.filename;
        }

        // Check if it's already a valid filename
        const list = type === "checkpoint" 
          ? state.available.checkpoints 
          : type === "lora"
          ? state.available.loras
          : state.available.vaes;

        // Exact match
        if (list.includes(alias)) {
          return alias;
        }

        // Partial match (case insensitive)
        const match = list.find(
          (f) => f.toLowerCase().includes(alias.toLowerCase())
        );
        
        return match ?? null;
      },

      setDefaultModel: (model) => set({ defaultModel: model }),
      setDefaultVae: (vae) => set({ defaultVae: vae }),
      setDefaultLoras: (loras) => set({ defaultLoras: loras }),
      setError: (error) => set({ error }),
    }),
    {
      name: STORAGE_KEYS.models,
      storage: legacyAwareJSONStorage(),
      partialize: (state) => ({
        aliases: state.aliases,
        defaultModel: state.defaultModel,
        defaultVae: state.defaultVae,
        defaultLoras: state.defaultLoras,
      }),
    }
  )
);

export const selectAvailableCheckpoints = (state: ModelStoreState) =>
  state.available.checkpoints;
export const selectAvailableLoras = (state: ModelStoreState) =>
  state.available.loras;
export const selectAvailableVaes = (state: ModelStoreState) =>
  state.available.vaes;
export const selectAvailableControlnet = (state: ModelStoreState) =>
  state.available.controlnet;
export const selectAvailableUpscaleModels = (state: ModelStoreState) =>
  state.available.upscale_models;
export const selectAvailableClip = (state: ModelStoreState) =>
  state.available.clip;
export const selectAvailableUnet = (state: ModelStoreState) =>
  state.available.unet;
export const selectAvailableIpadapter = (state: ModelStoreState) =>
  state.available.ipadapter;
export const selectAvailableEmbeddings = (state: ModelStoreState) =>
  state.available.embeddings;
export const selectAvailableGligen = (state: ModelStoreState) =>
  state.available.gligen;
export const selectAvailableHypernetworks = (state: ModelStoreState) =>
  state.available.hypernetworks;
export const selectAvailableDiffusers = (state: ModelStoreState) =>
  state.available.diffusers;
export const selectAvailableAnimatediffModels = (state: ModelStoreState) =>
  state.available.animatediff_models;
export const selectAvailableVideoModels = (state: ModelStoreState) =>
  state.available.video_models;
export const selectAvailableStyleModels = (state: ModelStoreState) =>
  state.available.style_models;
export const selectAvailableSamplers = (state: ModelStoreState) =>
  state.available.samplers;
export const selectAvailableSchedulers = (state: ModelStoreState) =>
  state.available.schedulers;
export const selectAvailableEnumOptions = (state: ModelStoreState) =>
  state.available.enumOptions;
export const selectAvailableInputImages = (state: ModelStoreState) =>
  state.available.input_images;
export const selectAvailableInputVideos = (state: ModelStoreState) =>
  state.available.input_videos;
export const selectAvailableInputAudios = (state: ModelStoreState) =>
  state.available.input_audios;

/**
 * Parse --lora parameter string into LoraWeight array
 * Format: "alias::weight" or "alias" (default weight 1.0)
 * Example: "anime::0.55 90smanga::-0.1 aesthetic::1.2"
 */
export function parseLoraString(loraStr: string): LoraWeight[] {
  const loras: LoraWeight[] = [];
  
  const parts = loraStr.trim().split(/\s+/);
  
  for (const part of parts) {
    if (!part) continue;
    
    // Check for weight separator (::)
    const [name, weightStr] = part.split("::");
    const weight = weightStr ? parseFloat(weightStr) : 1.0;
    
    if (name && !isNaN(weight)) {
      loras.push({
        name: name.trim(),
        strength: Math.max(-2, Math.min(2, weight)),
      });
    }
  }
  
  return loras;
}

/**
 * Format LoraWeight array back to parameter string
 */
export function formatLoraString(loras: LoraWeight[]): string {
  return loras
    .map((l) => {
      if (l.strength === 1.0) {
        return l.name;
      }
      return `${l.name}::${l.strength}`;
    })
    .join(" ");
}

/**
 * Merge new loras with existing (appending or updating weights)
 */
export function mergeLoraWeights(
  existing: LoraWeight[],
  incoming: LoraWeight[]
): LoraWeight[] {
  const result = [...existing];
  
  for (const newLora of incoming) {
    const existingIndex = result.findIndex(
      (l) => l.name.toLowerCase() === newLora.name.toLowerCase()
    );
    
    if (existingIndex >= 0) {
      result[existingIndex] = newLora;
    } else {
      result.push(newLora);
    }
  }
  
  return result;
}

export default useModelStore;
