/**
 * State for the NEvo neural-guided evolutionary synthesis mode — a separate
 * mode from the normal prompt bar, driven by its own button/menu next to the
 * prompt bar (NOT the settings panel).
 *
 * NEvo evolves images (krea2) and short videos (LTX/Wan) to maximally match a
 * chosen objective (default: a brain-region "target" via the vJEPA2→fMRI
 * encoder). The heavy search runs in the Python nevo-backend; this store talks
 * to it through /api/nevo/*.
 */

import { createWithEqualityFn } from "zustand/traditional";
import { persist } from "zustand/middleware";

export type NevoObjective = "brain" | "aesthetic" | "clip";
export type NevoDevice = "auto" | "cuda" | "mps" | "cpu";
export type NevoMode = "t2i" | "t2v";

export interface NevoConfig {
  objective: NevoObjective;
  roi: string; // brain-ROI token, e.g. "FFA"
  i2vFamily: string; // "ltx" | "wan21" | "wan22"
  device: NevoDevice;
  mode: NevoMode;
  imageMaxEvals: number;
  videoMaxEvals: number;
  populationSize: number;
  width: number;
  height: number;
  numFrames: number;
  seed: number | null;
}

export interface NevoOptions {
  objectives: string[];
  rois: string[];
  i2vFamilies: string[];
}

interface NevoProgress {
  bestScore: number | null;
  thumb: string | null; // base64 JPEG
}

interface NevoResult {
  bestPrompt: string;
  bestScore: number | null;
  image: string | null; // base64
  videoThumb?: string | null;
}

export const DEFAULT_NEVO_CONFIG: NevoConfig = {
  objective: "brain",
  roi: "FFA",
  i2vFamily: "ltx",
  device: "auto",
  mode: "t2v",
  imageMaxEvals: 80,
  videoMaxEvals: 40,
  populationSize: 8,
  width: 512,
  height: 512,
  numFrames: 25,
  seed: null,
};

interface NevoState {
  // UI
  menuOpen: boolean;
  enabled: boolean; // the mode toggle inside the menu
  toggleMenu: () => void;
  setMenuOpen: (open: boolean) => void;
  setEnabled: (on: boolean) => void;

  // config
  config: NevoConfig;
  setConfig: (patch: Partial<NevoConfig>) => void;
  resetConfig: () => void;

  // backend options
  options: NevoOptions | null;
  fetchOptions: () => Promise<void>;

  // run state
  running: boolean;
  jobId: string | null;
  status: string;
  progress: NevoProgress;
  result: NevoResult | null;
  error: string | null;

  startSearch: () => Promise<void>;
  cancel: () => Promise<void>;
}

export const useNevoStore = createWithEqualityFn<NevoState>()(
  persist(
    (set, get) => ({
      menuOpen: false,
      enabled: false,
      toggleMenu: () => set((s) => ({ menuOpen: !s.menuOpen })),
      setMenuOpen: (open) => set({ menuOpen: open }),
      setEnabled: (on) => set({ enabled: on }),

      config: DEFAULT_NEVO_CONFIG,
      setConfig: (patch) => set((s) => ({ config: { ...s.config, ...patch } })),
      resetConfig: () => set({ config: DEFAULT_NEVO_CONFIG }),

      options: null,
      fetchOptions: async () => {
        try {
          const r = await fetch("/api/nevo/options");
          if (!r.ok) return;
          const opts = (await r.json()) as NevoOptions;
          set({ options: opts });
          // clamp config to what the backend actually offers
          const { config } = get();
          const patch: Partial<NevoConfig> = {};
          if (
            opts.i2vFamilies?.length &&
            !opts.i2vFamilies.includes(config.i2vFamily)
          ) {
            patch.i2vFamily = opts.i2vFamilies[0];
          }
          if (opts.rois?.length && !opts.rois.includes(config.roi)) {
            patch.roi = opts.rois[0];
          }
          if (Object.keys(patch).length)
            set((s) => ({ config: { ...s.config, ...patch } }));
        } catch {
          /* backend offline — menu still renders, run will error clearly */
        }
      },

      running: false,
      jobId: null,
      status: "",
      progress: { bestScore: null, thumb: null },
      result: null,
      error: null,

      startSearch: async () => {
        if (get().running) return;
        set({
          running: true,
          error: null,
          result: null,
          status: "starting…",
          progress: { bestScore: null, thumb: null },
          jobId: null,
        });
        const { config } = get();
        try {
          const res = await fetch("/api/nevo/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              objective: config.objective,
              roi: config.objective === "brain" ? config.roi : null,
              i2v_family: config.i2vFamily,
              device: config.device,
              mode: config.mode,
              image_max_evals: config.imageMaxEvals,
              video_max_evals: config.videoMaxEvals,
              population_size: config.populationSize,
              width: config.width,
              height: config.height,
              num_frames: config.numFrames,
              seed: config.seed,
            }),
          });
          if (!res.ok || !res.body) {
            throw new Error(
              `backend ${res.status}: ${await res.text().catch(() => "")}`,
            );
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const parts = buf.split("\n\n");
            buf = parts.pop() ?? "";
            for (const part of parts) {
              const line = part.replace(/^data:\s?/, "").trim();
              if (!line) continue;
              let msg: Record<string, unknown>;
              try {
                msg = JSON.parse(line);
              } catch {
                continue;
              }
              handleEvent(set, get, msg);
            }
          }
        } catch (e) {
          set({ error: e instanceof Error ? e.message : String(e) });
        } finally {
          set({ running: false });
        }
      },

      cancel: async () => {
        const { jobId } = get();
        if (!jobId) {
          set({ running: false });
          return;
        }
        try {
          await fetch(`/api/nevo/cancel/${jobId}`, { method: "POST" });
        } catch {
          /* ignore */
        }
        set({ status: "cancelling…" });
      },
    }),
    {
      name: "nevo-store",
      // only persist user prefs, not transient run state
      partialize: (s) => ({ enabled: s.enabled, config: s.config }),
    },
  ),
);

function handleEvent(
  set: (partial: Partial<NevoState>) => void,
  get: () => NevoState,
  msg: Record<string, unknown>,
) {
  const type = msg.type as string;
  switch (type) {
    case "job":
      set({ jobId: String(msg.job_id) });
      break;
    case "status":
      set({ status: String(msg.message ?? "") });
      break;
    case "progress":
      set({
        status: "searching…",
        progress: {
          bestScore:
            typeof msg.best_score === "number"
              ? msg.best_score
              : get().progress.bestScore,
          thumb: (msg.thumb as string | null) ?? get().progress.thumb,
        },
      });
      break;
    case "result":
      set({
        status: "done",
        result: {
          bestPrompt: String(msg.best_prompt ?? ""),
          bestScore: typeof msg.best_score === "number" ? msg.best_score : null,
          image: (msg.image as string | null) ?? null,
          videoThumb: (msg.video_thumb as string | null) ?? null,
        },
      });
      break;
    case "cancelled":
      set({ status: "cancelled" });
      break;
    case "error":
      set({ error: String(msg.message ?? "unknown error"), status: "error" });
      break;
    case "done":
      break;
    default:
      break;
  }
}
