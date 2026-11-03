/**
 * Prompt-bar control group state: the labeled `Styles | Images | Settings`
 * pills and the "…" overflow menu.
 *
 * Styles and Settings are two tabs of one right-side drawer (the settings
 * panel). Its open flag stays in the UI store (`settingsOpen`) so Ctrl+S,
 * Escape, the command palette and the editor bar keep working unchanged;
 * only the active tab lives here. Images toggles the inline image-prompt
 * sections under the bar.
 */

import { create } from "zustand";
import { useUIStore } from "@/store";

export type PromptDrawerTab = "styles" | "settings";
export type PromptControl = "styles" | "images" | "settings";

export interface PromptControlState {
  drawerOpen: boolean;
  drawerTab: PromptDrawerTab;
  imagesOpen: boolean;
}

/**
 * Next state after a pill click. Clicking the pill for the tab that is
 * already showing closes the drawer; any other drawer pill opens (or
 * switches) to its tab. Images is an independent toggle.
 */
export function applyPromptControl(
  state: PromptControlState,
  control: PromptControl,
): PromptControlState {
  if (control === "images") {
    return { ...state, imagesOpen: !state.imagesOpen };
  }
  if (state.drawerOpen && state.drawerTab === control) {
    return { ...state, drawerOpen: false };
  }
  return { ...state, drawerOpen: true, drawerTab: control };
}

/** Whether a pill renders as pressed for the given state. */
export function isPromptControlActive(
  state: PromptControlState,
  control: PromptControl,
): boolean {
  if (control === "images") return state.imagesOpen;
  return state.drawerOpen && state.drawerTab === control;
}

/** Compact count badge text: hidden at 0, capped at 9+. */
export function formatControlCount(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 9 ? "9+" : String(Math.floor(count));
}

export type PromptOverflowItemId =
  "history" | "import" | "library" | "run-next" | "nevo";

export interface PromptOverflowItem {
  id: PromptOverflowItemId;
  label: string;
  hint: string;
  /** Present for toggle items (rendered as menuitemcheckbox). */
  checked?: boolean;
  /** Item opens something whose mode is currently on (accent icon). */
  active?: boolean;
}

/** Ordered "…" menu entries. History only appears once there is some. */
export function buildPromptOverflowItems(opts: {
  hasHistory: boolean;
  runNext: boolean;
  nevoEnabled: boolean;
  /** NEvo needs NEVO_BACKEND_URL; without it the item is left out. */
  nevoAvailable?: boolean;
}): PromptOverflowItem[] {
  const items: PromptOverflowItem[] = [];
  if (opts.hasHistory) {
    items.push({
      id: "history",
      label: "Prompt history",
      hint: "Recent and saved prompts",
    });
  }
  items.push(
    {
      id: "import",
      label: "Import workflow…",
      hint: "Workflow JSON or an Adrift PNG",
    },
    {
      id: "library",
      label: "ComfyUI library…",
      hint: "Load a workflow saved in ComfyUI",
    },
    {
      id: "run-next",
      label: "Run next",
      hint: "Queue the next prompt at the front",
      checked: opts.runNext,
    },
  );
  if (opts.nevoAvailable !== false) {
    items.push({
      id: "nevo",
      label: "Evolve mode (NEvo)…",
      hint: opts.nevoEnabled ? "On — open to adjust" : "Neural evolution search",
      active: opts.nevoEnabled,
    });
  }
  return items;
}

/** True when the "…" button should carry a dot (some hidden mode is on). */
export function overflowHasActiveMode(opts: {
  runNext: boolean;
  nevoEnabled: boolean;
}): boolean {
  return opts.runNext || opts.nevoEnabled;
}

interface PromptDrawerStore {
  tab: PromptDrawerTab;
  setTab: (tab: PromptDrawerTab) => void;
}

/**
 * Active drawer tab. Reset to "settings" whenever the drawer closes so
 * Ctrl+S / the command palette always land on Settings, while a "styles"
 * open (pill, sref chip) keeps its tab for as long as the drawer is open.
 *
 * The reset is driven by the open flag, not by SettingsPanel unmounting:
 * React StrictMode double-mounts in dev, and an unmount cleanup reset the
 * tab right after the Styles pill set it.
 */
export const usePromptDrawerStore = create<PromptDrawerStore>((set) => ({
  tab: "settings",
  setTab: (tab) => set({ tab }),
}));

useUIStore.subscribe((state, prev) => {
  if (prev.settingsOpen && !state.settingsOpen) {
    usePromptDrawerStore.getState().setTab("settings");
  }
});
