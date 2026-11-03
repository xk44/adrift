/**
 * Guided intro tour: the stops, when it starts, where its card sits.
 *
 * Pure module (no React, no store, no DOM access beyond guarded storage) so
 * the step list, the auto-start rule, keyboard mapping and card placement are
 * unit-testable. TourHost / TourOverlay render it.
 *
 * Starts on its own exactly once: right after a first-run setup wizard
 * (opened by OnboardingHost because nothing was onboarded yet) closes, and
 * only when the tour was never seen in this browser. A pre-set `onboardedAt`
 * never opens the wizard, so mock instances and tests are never interrupted.
 * `?tour=1` forces it (demos, screenshots); Help, Settings and the command
 * palette re-launch it.
 */
import type { NavKey } from "@/types";

/** Where a stop lives: a nav page, or an in-app path with its query. */
export type TourPage = { nav: NavKey } | { path: string; nav: NavKey };

/** Page set-up a stop needs (and undoes when you leave it). */
export type TourPrepare = "explore-models" | "prompt-settings";

export interface TourStep {
  id: string;
  /** Short chapter label shown above the title ("Create", "Tools"). */
  section: string;
  page: TourPage;
  /**
   * Element(s) to spotlight, tried in order; the first visible match wins.
   * None, or nothing visible after a short wait = centered card.
   */
  target?: string | readonly string[];
  title: string;
  body: string;
  prepare?: TourPrepare;
}

export const TOUR_MAX_STEPS = 20;

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "prompt",
    section: "Create",
    page: { nav: "create" },
    target: "[data-prompt-card]",
    title: "Type a prompt",
    body: "Describe an image or a clip and press Enter. Flags such as --ar 16:9 or --seed 42 work inline, and the bar stays on every creative page.",
  },
  {
    id: "prompt-controls",
    section: "Create",
    page: { nav: "create" },
    target: "[data-prompt-controls]",
    title: "Styles, characters and references",
    body: "Styles adds a saved look, Character keeps one person consistent from run to run, and Images attaches reference pictures.",
  },
  {
    id: "params",
    section: "Create",
    page: { nav: "create" },
    target: ['[data-tour="prompt-settings"]', "[data-prompt-controls]"],
    prepare: "prompt-settings",
    title: "Aspect, model and speed",
    body: "Settings holds the aspect ratio, quality, model, speed and video engine. Changes apply to the next run and stay put.",
  },
  {
    id: "feed",
    section: "Create",
    page: { nav: "create" },
    target: ['[data-testid="live-preview"]', '[data-tour="create-feed"]'],
    title: "Live previews",
    body: "While ComfyUI renders, each tile sharpens from a rough preview and shows the node it is on. Finished images stay grouped by run.",
  },
  {
    id: "lightbox",
    section: "Create",
    page: { nav: "create" },
    target: ['[data-tour="gallery-tile"]', '[data-tour="create-feed"]'],
    title: "Open any result",
    body: "The lightbox has Vary, Upscale (faithful, creative or re-detail), Edit, Loop and Rerun with new parameters. It also reopens the recipe, runs any tool on the image and reads its style and palette.",
  },
  {
    id: "explore-models",
    section: "Explore",
    page: { nav: "explore" },
    target: '[data-tour="explore-models"]',
    prepare: "explore-models",
    title: "Find models",
    body: "Browse Civitai and Hugging Face checkpoints, LoRAs and workflows by base model, type and period. Fits my GPU hides files too big for your card, and downloads go straight into ComfyUI's folders.",
  },
  {
    id: "tools-featured",
    section: "Tools",
    page: { nav: "tools" },
    target: '[data-tour="tools-featured"]',
    title: "Tools",
    body: "Ready-made workflows for image, video, audio and 3D. Featured: LTX Day to Night and Cinemagraph, MiniMax H3 Reference to Video (a new shot with sound from cast photos) and FLUX.3 Product Studio.",
  },
  {
    id: "tools-flagship",
    section: "Tools",
    page: { nav: "tools" },
    target: [
      '[data-testid="tool-card-action:see_through"]',
      '[data-tour="tools-categories"]',
    ],
    title: "Flagship tools",
    body: "Layer Split cuts an illustration into about 24 depth-ordered layers with hidden areas filled in. H3 Character Sheet draws a turnaround from one image, Relight changes or matches the light, and Hair Cards turns a portrait into 3D hair. Upscale and Upscale video always use the upscaler you lock in Settings.",
  },
  {
    id: "tools-categories",
    section: "Tools",
    page: { nav: "tools" },
    target: '[data-tour="tools-categories"]',
    title: "Browse by category",
    body: "Image, Edit, Identity, Video, VFX, Enhance and Audio, plus one-click apps for ads, portraits and scenes. Each card shows whether its models are installed.",
  },
  {
    id: "import-workflow",
    section: "Tools",
    page: { nav: "tools" },
    target: '[data-testid="tools-import-workflow"]',
    title: "Bring your own workflows",
    body: "Import a ComfyUI workflow from a file, a link or a Civitai listing in Explore. Adrift reads its inputs and turns it into a tool with a simple form.",
  },
  {
    id: "editor",
    section: "Edit",
    page: { nav: "edit" },
    target: ['[data-tour="editor"]', '[data-testid="video-editor"]'],
    title: "Image editor",
    body: "Paint a mask to change part of an image, extend it past its edges, or enhance it. Tools you run from its panel come back as layers.",
  },
  {
    id: "video-editor",
    section: "Edit",
    page: { nav: "edit" },
    target: [
      '[data-testid="video-editor"]',
      '[data-testid="editor-video-start"]',
    ],
    title: "Video editor",
    body: "Open a clip to trim it on a timeline, run video tools on it and export. Any video in the lightbox opens here too.",
  },
  {
    id: "styles",
    section: "Styles",
    page: { nav: "styles" },
    target: '[data-tour="styles-views"]',
    title: "Styles",
    body: "Save a look from any image or LoRA and call it up in a prompt by name. Datasets collect references for training a style LoRA, and Personalize learns your taste from image pairs.",
  },
  {
    id: "characters",
    section: "Styles",
    page: { nav: "characters" },
    target: '[data-testid="characters-hero"]',
    title: "Characters",
    body: "Make a board for each recurring person or figure, caption it, and train a LoRA that keeps them on-model from scene to scene.",
  },
  {
    id: "setup",
    section: "Workflows",
    page: { nav: "setup", path: "/setup?tab=workflows" },
    target: '[data-tour="setup-tabs"]',
    title: "Workflows and pipelines",
    body: "Saved workflows, button routing (which workflow or pipeline each button runs), node packs and model downloads all live in Setup.",
  },
  {
    id: "machines",
    section: "Settings",
    page: { nav: "account-settings" },
    target: ['[data-tour="settings-machines"]', '[data-tour="settings-connection"]'],
    title: "ComfyUI connection",
    body: "Check the ComfyUI link, add more machines such as a second PC or a rented GPU, and choose which runs images and which runs video. AI agents can also drive Adrift through its MCP server.",
  },
  {
    id: "upscaler",
    section: "Settings",
    page: { nav: "account-settings" },
    target: '[data-tour="settings-upscaler"]',
    title: "Upscaler of choice",
    body: "Pick the default upscaler for photos, illustrations and video frames, then lock it. Every tool, workflow and lightbox upscale uses that model from then on.",
  },
  {
    id: "training",
    section: "Settings",
    page: { nav: "account-settings" },
    target: '[data-tour="settings-training"]',
    title: "LoRA training",
    body: "Point Adrift at a local trainer such as AI Toolkit or musubi-tuner. It writes the config, runs one job at a time and links finished LoRAs into ComfyUI.",
  },
  {
    id: "queue",
    section: "Queue",
    page: { nav: "create" },
    target: '[data-testid="queue-badge"]',
    title: "Job queue",
    body: "Once something runs, a badge by the logo opens the queue: progress per job, cancel, retry, and a jump to the result. On phones it sits in the menu.",
  },
  {
    id: "done",
    section: "Tour",
    page: { nav: "create" },
    title: "You're set",
    body: "Take the tour again from Help, the account menu or the command palette (Ctrl+K or ⌘K). What's on this page, in the same places, tours just the page you are on, and ? lists keyboard shortcuts.",
  },
];

/** A stop's selectors in the order they are tried. */
export function stepTargets(step: Pick<TourStep, "target">): string[] {
  if (!step.target) return [];
  return typeof step.target === "string" ? [step.target] : [...step.target];
}

/** Anything with a box: a DOM element, or a stand-in in tests. */
export interface Measurable {
  getBoundingClientRect(): { width: number; height: number };
}

/**
 * First visible element for a stop's selector chain. A selector that throws
 * (bad syntax) or matches nothing visible falls through to the next; null
 * means "no anchor" and the card is centered.
 */
export function resolveTourTarget<E extends Measurable>(
  selectors: readonly string[],
  query: (selector: string) => Iterable<E>,
): { el: E; selector: string } | null {
  for (const selector of selectors) {
    let found: Iterable<E>;
    try {
      found = query(selector);
    } catch {
      continue;
    }
    for (const el of found) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return { el, selector };
    }
  }
  return null;
}

// Tours: the intro, and a short one per page

export type TourId = "intro" | `page:${NavKey}`;

/** Stops that only make sense in the full walk-through. */
const INTRO_ONLY = new Set(["queue", "done"]);

/**
 * "What's on this page": the intro stops that live on `nav`, in order. A page
 * the intro never visits gets one centered card from its nav hint.
 */
export function pageTourSteps(
  nav: NavKey,
  fallback?: { label: string; hint: string },
): TourStep[] {
  const steps = TOUR_STEPS.filter(
    (s) => s.page.nav === nav && !INTRO_ONLY.has(s.id),
  );
  if (steps.length > 0) return steps;
  if (!fallback) return [];
  return [
    {
      id: `page-${nav}`,
      section: fallback.label,
      page: { nav },
      title: fallback.label,
      body: fallback.hint,
    },
  ];
}

export function tourSteps(
  tour: TourId,
  fallback?: { label: string; hint: string },
): readonly TourStep[] {
  if (tour === "intro") return TOUR_STEPS;
  return pageTourSteps(tour.slice("page:".length) as NavKey, fallback);
}

// State machine

export interface TourMachine {
  open: boolean;
  tour: TourId;
  index: number;
}

export type TourEvent =
  | { type: "start"; tour?: TourId; index?: number }
  | { type: "next" }
  | { type: "back" }
  | { type: "goto"; index: number }
  | { type: "skip" };

export const TOUR_CLOSED: TourMachine = { open: false, tour: "intro", index: 0 };

/**
 * Pure transitions for a tour of `count` stops. Next past the last stop and
 * skip both close it; goto and start clamp into range; a tour with no stops
 * never opens. Events on a closed tour (other than start) do nothing.
 */
export function tourReducer(
  state: TourMachine,
  event: TourEvent,
  count: number,
): TourMachine {
  const clamp = (i: number) =>
    Math.max(0, Math.min(Number.isFinite(i) ? Math.trunc(i) : 0, count - 1));
  if (event.type === "start") {
    if (count <= 0) return { ...TOUR_CLOSED };
    return { open: true, tour: event.tour ?? "intro", index: clamp(event.index ?? 0) };
  }
  if (!state.open) return state;
  switch (event.type) {
    case "next":
      return state.index >= count - 1
        ? { ...TOUR_CLOSED, tour: state.tour }
        : { ...state, index: state.index + 1 };
    case "back":
      return { ...state, index: clamp(state.index - 1) };
    case "goto":
      return { ...state, index: clamp(event.index) };
    case "skip":
      return { ...TOUR_CLOSED, tour: state.tour };
  }
}

// Persistence

/** localStorage flag: the tour was started once in this browser. */
export const TOUR_SEEN_KEY = "adrift.tourSeen";

export function readTourSeen(): boolean {
  try {
    return window.localStorage.getItem(TOUR_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markTourSeen(): void {
  try {
    window.localStorage.setItem(TOUR_SEEN_KEY, "1");
  } catch {
    // private mode / blocked storage: worst case it offers itself once more
  }
}

/** localStorage: id of the intro stop the tour was skipped at (resume point). */
export const TOUR_PROGRESS_KEY = "adrift.tourProgress";

export function readTourProgress(): string | null {
  try {
    return window.localStorage.getItem(TOUR_PROGRESS_KEY);
  } catch {
    return null;
  }
}

export function writeTourProgress(stepId: string | null): void {
  try {
    if (stepId) window.localStorage.setItem(TOUR_PROGRESS_KEY, stepId);
    else window.localStorage.removeItem(TOUR_PROGRESS_KEY);
  } catch {
    // blocked storage: resume just starts from the top
  }
}

/**
 * Where "Take the tour" picks up: the saved stop, unless it is the first or
 * last one or no longer exists (renamed in an update), then 0.
 */
export function resumeIndex(
  steps: readonly Pick<TourStep, "id">[],
  savedId: string | null,
): number {
  if (!savedId) return 0;
  const i = steps.findIndex((s) => s.id === savedId);
  return i > 0 && i < steps.length - 1 ? i : 0;
}

// Start rules

/** `?tour=1` (or `?tour=true`) forces the tour; anything else does not. */
export function forcedTour(search: string): boolean {
  const v = new URLSearchParams(search).get("tour");
  return v === "1" || v === "true";
}

/** `search` without the `tour` key, as "?…" or "" (so Back / reload don't replay it). */
export function stripTourParam(search: string): string {
  const sp = new URLSearchParams(search);
  sp.delete("tour");
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

export interface WizardTransition {
  /** The wizard was open before this store change. */
  wasOpen: boolean;
  /** …and was opened by the first-run check (not Help / Settings / ?setup=). */
  wasFirstRun: boolean;
  /** The wizard is open after this store change. */
  isOpen: boolean;
}

/**
 * Auto-start rule: the first-run wizard just closed (finished or skipped)
 * and this browser has not seen the tour. A wizard re-opened by hand, a
 * forced `?setup=` wizard, or no wizard at all (already onboarded) never
 * starts it.
 */
export function shouldAutoStartTour(
  t: WizardTransition,
  tourSeen: boolean,
): boolean {
  return t.wasOpen && t.wasFirstRun && !t.isOpen && !tourSeen;
}

// Keyboard

export type TourKeyAction = "next" | "back" | "first" | "last" | "skip" | null;

/** ←/→ step (→ on the last stop finishes), Home/End jump, Esc skips. Enter/Space stay with the focused button. */
export function tourKeyAction(
  e: {
    key: string;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    isComposing?: boolean;
  },
  index: number,
): TourKeyAction {
  if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.key === "Escape") return "skip";
  if (e.key === "ArrowRight") return "next";
  if (e.key === "ArrowLeft") return index > 0 ? "back" : null;
  if (e.key === "Home") return index > 0 ? "first" : null;
  if (e.key === "End") return "last";
  return null;
}

// Card placement

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CardPlacement {
  left: number;
  top: number;
  /** Side of the target the card sits on; "center" without a target. */
  side: "bottom" | "top" | "right" | "left" | "center";
}

/**
 * Where the card goes beside a spotlight (desktop). Below if it fits, then
 * above, right, left; centered otherwise. Always clamped inside the viewport
 * with `margin` to spare.
 */
export function placeTourCard(
  target: Rect | null,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 14,
  margin = 16,
): CardPlacement {
  const clampX = (x: number) =>
    Math.max(margin, Math.min(x, viewport.width - card.width - margin));
  const clampY = (y: number) =>
    Math.max(margin, Math.min(y, viewport.height - card.height - margin));
  const centered: CardPlacement = {
    left: clampX((viewport.width - card.width) / 2),
    top: clampY((viewport.height - card.height) / 2),
    side: "center",
  };
  if (!target) return centered;

  const below = target.top + target.height + gap;
  const above = target.top - gap - card.height;
  const right = target.left + target.width + gap;
  const left = target.left - gap - card.width;
  const alignX = clampX(target.left + target.width / 2 - card.width / 2);
  const alignY = clampY(target.top + target.height / 2 - card.height / 2);

  if (below + card.height <= viewport.height - margin)
    return { left: alignX, top: below, side: "bottom" };
  if (above >= margin) return { left: alignX, top: above, side: "top" };
  if (right + card.width <= viewport.width - margin)
    return { left: right, top: alignY, side: "right" };
  if (left >= margin) return { left, top: alignY, side: "left" };
  // Target fills the screen (a long feed): sit inside it, near the bottom.
  return {
    left: alignX,
    top: clampY(viewport.height - card.height - margin * 2),
    side: "center",
  };
}

/** Phones: the card is a sheet; dock it away from the spotlight. */
export function sheetDock(
  target: Rect | null,
  viewportHeight: number,
): "bottom" | "top" {
  if (!target) return "bottom";
  const mid = target.top + target.height / 2;
  return mid > viewportHeight * 0.55 ? "top" : "bottom";
}

/** Spotlight rect: target plus padding, clipped to the viewport. Null when off-screen or empty. */
export function spotlightRect(
  r: Rect,
  viewport: { width: number; height: number },
  pad = 6,
): Rect | null {
  if (r.width <= 0 || r.height <= 0) return null;
  const left = Math.max(4, r.left - pad);
  const top = Math.max(4, r.top - pad);
  const right = Math.min(viewport.width - 4, r.left + r.width + pad);
  const bottom = Math.min(viewport.height - 4, r.top + r.height + pad);
  if (right - left < 8 || bottom - top < 8) return null;
  return { left, top, width: right - left, height: bottom - top };
}
