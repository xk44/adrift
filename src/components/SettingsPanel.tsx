"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useUIStore } from "@/store";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useModelStore } from "@/store/modelStore";
import type { LoraWeight } from "@/types";
import { SettingCard } from "@/components/settings/SettingCard";
import { MJSlider } from "@/components/settings/MJSlider";
import { PillToggle } from "@/components/settings/PillToggle";
import { SettingLabel } from "@/components/settings/SettingLabel";
import {
  X,
  Plus,
  Trash2,
  ChevronDown,
  Loader2,
  AlertCircle,
  Dices,
  Palette,
  SlidersHorizontal,
  LayoutGrid,
  Compass,
} from "lucide-react";
import { SystemCard } from "@/components/settings/SystemCard";
import { H3Attribution } from "@/components/tools/H3Notice";
import { H3_IMAGE_ENGINE, H3_IMAGE_WORKFLOW } from "@/lib/oj/h3Image";
import { FoldersEditor } from "@/components/onboarding/FoldersEditor";
import {
  AppearanceSettings,
  useAppearanceSummary,
} from "@/components/settings/AppearanceSettings";
import { openOnboarding } from "@/store/onboardingStore";
import { startTour } from "@/store/tourStore";
import { LoraMetaInfo } from "@/components/settings/LoraMetaInfo";
import {
  usePromptDrawerStore,
  type PromptDrawerTab,
} from "@/components/settings/promptControls";
import { StyleReferencePanel } from "@/components/style/StyleReferencePanel";
import { startVisibleInterval } from "@/lib/ui/visibleInterval";
import {
  settingsVideoModel,
  VIDEO_BATCH_OPTIONS,
} from "@/lib/oj/videoDefault";
import { navigateToDestination } from "@/lib/ui/navRegistry";
import {
  speedEngineForWorkflowPath,
  speedTierHint,
  type SpeedSetting,
} from "@/lib/oj/speedTier";
import {
  mergeActionAndSlotAssignments,
  resolveWorkflowForAction,
} from "@/lib/workflowAssignments";

// Static options arrays (hoisted to avoid re-renders)
const MODE_OPTIONS: Array<{ label: string; value: "Standard" | "Raw" }> = [
  { label: "Standard", value: "Standard" },
  { label: "Raw", value: "Raw" },
];

const QUALITY_OPTIONS: Array<{ label: string; value: number }> = [
  { label: "Draft", value: 0.25 },
  { label: "Low", value: 0.5 },
  { label: "Normal", value: 1 },
  { label: "High", value: 2 },
];

const SPEED_OPTIONS: Array<{ label: string; value: SpeedSetting }> = [
  { label: "Draft", value: "Draft" },
  { label: "Standard", value: "Standard" },
  { label: "Quality", value: "Quality" },
];

const VIDEO_MODEL_OPTIONS: Array<{
  label: string;
  value: "ltxv" | "ltx25" | "wan" | "minimax";
}> = [
  // LTX-2.5 runs on a stock install; legacy LTXV 0.9.5 is opt-in via
  // --vmodel ltxv (a stored "ltxv" reads as LTX-2.5: videoDefault.ts).
  { label: "LTX-2.5", value: "ltx25" },
  { label: "Wan", value: "wan" },
  { label: "H3 Audio", value: "minimax" },
];

/** Video variants per run (--vb): queued one after another, new seed each. */
const VIDEO_BATCH_PILLS: Array<{ label: string; value: number }> =
  VIDEO_BATCH_OPTIONS.map((n) => ({ label: String(n), value: n }));

/** H3 Audio speed: Quality (pack recipe) or FastH3 (8-step distilled DiT). */
const H3_SPEED_OPTIONS: Array<{ label: string; value: "off" | "fast8" }> = [
  { label: "Quality", value: "off" },
  { label: "Fast 8-step", value: "fast8" },
];

const CLIP_SKIP_OPTIONS: Array<{ label: string; value: number }> = [
  { label: "Off", value: 1 },
  { label: "2", value: 2 },
  { label: "3", value: 3 },
  { label: "4", value: 4 },
];

const TILED_VAE_OPTIONS: Array<{
  label: string;
  value: "auto" | "on" | "off";
}> = [
  { label: "Auto", value: "auto" },
  { label: "On", value: "on" },
  { label: "Off", value: "off" },
];

/** Small on/off switch for boolean settings. */
function SettingSwitch({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <div>
        <SettingLabel label={label} />
        <p className="text-[11px] leading-tight text-[var(--text-tertiary)]">
          {hint}
        </p>
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors ${
          checked ? "bg-splash" : "bg-[var(--bg-tertiary)]"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-5" : "translate-x-1"
          }`}
        />
      </button>
    </div>
  );
}

const BATCH_SIZE_OPTIONS: Array<{ label: string; value: number }> = [
  { label: "1", value: 1 },
  { label: "2", value: 2 },
  { label: "4", value: 4 },
  { label: "8", value: 8 },
];

// Engine options
// Each engine routes the prompt bar to a model-family workflow. "custom" keeps
// the user's checkpoint/workflow selection (legacy "v7" is treated as custom).
const ENGINE_OPTIONS: Array<{
  value: string;
  label: string;
  workflow: string | null;
  workflowName: string | null;
  krea2Backend?: "comfyui" | "direct";
}> = [
  {
    value: "custom",
    label: "Custom (checkpoint)",
    workflow: null,
    workflowName: null,
  },
  {
    value: "zimage-turbo",
    label: "Z-Image Turbo",
    workflow: "zimageturbo.json",
    workflowName: "Z-Image Turbo",
  },
  {
    value: "ideogram4",
    label: "Ideogram 4",
    workflow: "ideogram4_t2i.json",
    workflowName: "Ideogram 4",
  },
  {
    value: "krea-2-comfyui",
    label: "Krea 2 (ComfyUI)",
    workflow: "krea2_t2i.json",
    workflowName: "Krea 2",
    krea2Backend: "comfyui",
  },
  {
    value: "krea-2-direct",
    label: "Krea 2 Direct",
    workflow: "krea2_t2i.json",
    workflowName: "Krea 2",
    krea2Backend: "direct",
  },
  {
    // Region-limited license: the H3 attribution banner shows when selected.
    value: H3_IMAGE_ENGINE,
    label: "MiniMax H3 Image",
    workflow: H3_IMAGE_WORKFLOW,
    workflowName: "MiniMax H3 Image",
  },
];

// Default values per section (for per-section Reset)
const SECTION_DEFAULTS = {
  image: { aspect: "1:1", ratio: 1, quality: 1 },
  model: {
    model: undefined,
    vae: undefined,
    modelVersion: "custom",
    krea2Backend: "comfyui" as const,
  },
  aesthetics: {
    modelMode: "Standard" as const,
    stylize: 100,
    chaos: 0,
  },
  more: {
    speed: "Standard" as const,
    privacy: "Public" as const,
  },
  video: {
    videoModel: "ltx25" as const,
    h3Speed: "off" as const,
    videoBatch: 1,
  },
  advanced: {
    steps: undefined,
    cfg: undefined,
    sampler: undefined,
    scheduler: undefined,
    batchSize: 1,
    seed: undefined,
    negative: undefined,
    clipSkip: undefined,
    tiledVae: "auto" as const,
    freeOnFamilySwitch: true,
    memoryPreflight: true,
  },
  loras: { loras: [] as LoraWeight[] },
};

// Aspect ratio presets
const ASPECT_PRESETS = [
  { value: "1:1", w: 1, h: 1 },
  { value: "4:3", w: 4, h: 3 },
  { value: "3:2", w: 3, h: 2 },
  { value: "16:9", w: 16, h: 9 },
  { value: "9:16", w: 9, h: 16 },
  { value: "2:3", w: 2, h: 3 },
  { value: "3:4", w: 3, h: 4 },
] as const;

/** Parse "W:H" into numeric ratio, returns null on bad input */
function parseAspect(ar: string): { w: number; h: number } | null {
  const m = ar.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const w = parseFloat(m[1]);
  const h = parseFloat(m[2]);
  if (w <= 0 || h <= 0) return null;
  return { w, h };
}

function AspectPreview({ aspect }: { aspect: string }) {
  const parsed = parseAspect(aspect);
  const ratio = parsed ? parsed.w / parsed.h : 1;

  // Fit inside a 80x80 box
  const boxSize = 80;
  let w: number, h: number;
  if (ratio >= 1) {
    w = boxSize;
    h = boxSize / ratio;
  } else {
    h = boxSize;
    w = boxSize * ratio;
  }

  return (
    <div className="flex items-center justify-center py-3">
      <div
        className="relative flex items-center justify-center"
        style={{ width: boxSize, height: boxSize }}
      >
        <div
          className="rounded-lg border-2 border-[var(--border-secondary)] bg-[var(--bg-tertiary)] transition-all duration-200"
          style={{ width: Math.round(w), height: Math.round(h) }}
        />
        <span className="absolute bottom-0 translate-y-5 text-xs font-mono tabular-nums text-[var(--text-muted)]">
          {aspect}
        </span>
      </div>
    </div>
  );
}

const DRAWER_TABS: Array<{
  id: PromptDrawerTab;
  label: string;
  Icon: typeof Palette;
}> = [
  { id: "styles", label: "Styles", Icon: Palette },
  { id: "settings", label: "Settings", Icon: SlidersHorizontal },
];

export function SettingsPanel() {
  const settings = useUIStore((s) => s.settings);
  const glassUI = useUIStore((s) => s.glassUI);
  const setGlassUI = useUIStore((s) => s.setGlassUI);
  const appearanceSummary = useAppearanceSummary();
  const updateSettings = useUIStore((s) => s.updateSettings);
  const selectedWorkflowPath = useUIStore((s) => s.selectedWorkflowPath);
  const selectedWorkflowName = useUIStore((s) => s.selectedWorkflowName);
  const defaultWorkflowPath = useUIStore((s) => s.defaultWorkflowPath);
  const defaultWorkflowName = useUIStore((s) => s.defaultWorkflowName);
  const actionWorkflowMap = useUIStore((s) => s.actionWorkflowMap);
  // What Speed does for the model the prompt bar would use right now.
  const speedHint = useMemo(() => {
    const resolved = resolveWorkflowForAction("promptbar.imagine", {
      assignments: mergeActionAndSlotAssignments(actionWorkflowMap),
      selectedWorkflowPath,
      selectedWorkflowName,
      defaultWorkflowPath,
      defaultWorkflowName,
    });
    const path = resolved?.workflowPath ?? selectedWorkflowPath ?? undefined;
    return speedTierHint(speedEngineForWorkflowPath(path), settings.speed);
  }, [
    actionWorkflowMap,
    selectedWorkflowPath,
    selectedWorkflowName,
    defaultWorkflowPath,
    defaultWorkflowName,
    settings.speed,
  ]);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const setSelectedWorkflow = useUIStore((s) => s.setSelectedWorkflow);
  const setActiveNav = useUIStore((s) => s.setActiveNav);
  const setStylesHubTab = useUIStore((s) => s.setStylesHubTab);

  // Drawer tab (Styles | Settings). Reset to Settings when the drawer
  // closes (promptControls.ts subscribes to settingsOpen), never on unmount:
  // StrictMode's dev double-mount would clobber a "styles" open.
  const tab = usePromptDrawerStore((s) => s.tab);
  const setTab = usePromptDrawerStore((s) => s.setTab);

  // Below md the panel is a full-screen modal sheet; from md up it docks
  // beside the feed and must not trap focus.
  const panelRef = useRef<HTMLElement>(null);
  const isSheet = useMediaQuery("(max-width: 767px)");
  useDialogFocus(panelRef, isSheet);

  const available = useModelStore((s) => s.available);
  const isLoading = useModelStore((s) => s.isLoading);
  const modelError = useModelStore((s) => s.error);
  const fetchAvailable = useModelStore((s) => s.fetchAvailable);
  const aliases = useModelStore((s) => s.aliases);

  const [customAspect, setCustomAspect] = useState("");
  const isCustom = useMemo(
    () => !ASPECT_PRESETS.some((p) => p.value === settings.aspect),
    [settings.aspect],
  );
  // "Custom" chosen while the value still matches a preset: show the field.
  const [customOpen, setCustomOpen] = useState(false);
  const showCustomAspect = isCustom || customOpen;

  // H3 warm backend state (server-side process; polled, not persisted here)
  const [h3Warm, setH3Warm] = useState<"off" | "starting" | "on">("off");
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/h3-warm");
        if (!res.ok) return;
        const s = (await res.json()) as {
          enabled: boolean;
          starting?: boolean;
        };
        if (!cancelled)
          setH3Warm(s.enabled ? "on" : s.starting ? "starting" : "off");
      } catch {
        /* server unreachable — leave state as-is */
      }
    };
    // Paused while the tab is hidden; refreshes as soon as it's shown again.
    const stop = startVisibleInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  const toggleH3Warm = async () => {
    const next = h3Warm === "off";
    setH3Warm(next ? "starting" : "off");
    try {
      const res = await fetch("/api/h3-warm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on: next }),
      });
      if (res.ok) {
        const s = (await res.json()) as {
          enabled: boolean;
          starting?: boolean;
        };
        setH3Warm(s.enabled ? "on" : s.starting ? "starting" : "off");
      }
    } catch {
      setH3Warm(next ? "off" : "on"); // revert optimistic state
    }
  };

  const qualityLabel =
    QUALITY_OPTIONS.find((q) => q.value === settings.quality)?.label ??
    `q ${settings.quality}`;
  const videoLabel =
    VIDEO_MODEL_OPTIONS.find(
      (v) => v.value === settingsVideoModel(settings.videoModel),
    )?.label ?? "LTX-2.5";
  const videoBatch = settings.videoBatch ?? 1;
  const videoSummary =
    videoBatch > 1 ? `${videoLabel} · ${videoBatch} variants` : videoLabel;

  // Active engine — legacy persisted values ("v7") fall back to custom
  const engine =
    ENGINE_OPTIONS.find((e) => e.value === settings.modelVersion) ??
    ENGINE_OPTIONS[0];

  const handleEngineChange = (value: string) => {
    const next =
      ENGINE_OPTIONS.find((e) => e.value === value) ?? ENGINE_OPTIONS[0];
    if (next.workflow) {
      // Engine workflows bake their own diffusion/text-encoder/VAE models;
      // Krea variants ride through --model for server-side variant selection.
      updateSettings({
        modelVersion: next.value,
        model: undefined,
        vae: undefined,
        krea2Backend: next.krea2Backend ?? "comfyui",
      });
      setSelectedWorkflow(next.workflow, next.workflowName);
    } else {
      updateSettings({
        modelVersion: next.value,
        model: undefined,
        krea2Backend: "comfyui",
      });
      setSelectedWorkflow(null);
    }
  };

  useEffect(() => {
    fetchAvailable();
  }, [fetchAvailable]);

  // Sync custom input when switching to a non-preset aspect
  useEffect(() => {
    if (isCustom) setCustomAspect(settings.aspect);
  }, [isCustom, settings.aspect]);

  return (
    // Below md the panel is a full-screen sheet over the feed (the reference
    // site's mobile settings overlay); from md up it docks as a side column.
    <aside
      ref={panelRef}
      role="dialog"
      aria-label="Settings"
      data-tour="prompt-settings"
      className="fixed inset-0 z-50 flex w-full flex-col bg-[var(--bg-primary)] animate-slide-up md:static md:z-auto md:h-full md:w-80 md:max-w-[90vw] md:animate-none md:border-l md:border-[var(--border-primary)] lg:w-[560px]"
    >
      {/* Panel header: Styles | Settings tabs + close */}
      <div className="flex items-center gap-2 border-b border-[var(--border-primary)] px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] md:pt-2.5">
        <h2 className="sr-only">{tab === "styles" ? "Styles" : "Settings"}</h2>
        <div
          role="tablist"
          aria-label="Drawer sections"
          className="flex min-w-0 flex-1 items-center gap-0.5 rounded-full border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-0.5"
        >
          {DRAWER_TABS.map(({ id, label, Icon }) => {
            const selected = tab === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                id={`cj-drawer-tab-${id}`}
                aria-selected={selected}
                aria-controls="cj-drawer-body"
                onClick={() => setTab(id)}
                className={`flex h-8 md:h-7 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-xs font-medium transition-[background-color,color] duration-150 ${
                  selected
                    ? "bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                <Icon
                  className={`h-3.5 w-3.5 ${selected ? "text-[var(--accent-primary)]" : ""}`}
                />
                {label}
              </button>
            );
          })}
        </div>
        <button
          onClick={() => setSettingsOpen(false)}
          className="flex h-9 w-9 shrink-0 md:h-7 md:w-7 items-center justify-center rounded-full bg-[var(--bg-tertiary)] md:bg-transparent text-[var(--text-secondary)] md:text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          aria-label="Close settings"
          title="Close (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div
        id="cj-drawer-body"
        role="tabpanel"
        aria-labelledby={`cj-drawer-tab-${tab}`}
        className="flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]"
      >
        {tab === "styles" && (
          <div className="flex flex-col gap-3 p-3">
            <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4 shadow-panel">
              <StyleReferencePanel embedded />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  // Through the registry: the "styles" key itself is the
                  // Datasets view; the Styles destination opens Browse.
                  navigateToDestination("styles", {
                    setActiveNav,
                    setStylesHubTab,
                  });
                  setSettingsOpen(false);
                }}
                className="flex items-center justify-center gap-1.5 rounded-xl border border-[var(--border-primary)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <Palette className="h-3.5 w-3.5" />
                Browse style library
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveNav("moodboards");
                  setSettingsOpen(false);
                }}
                className="flex items-center justify-center gap-1.5 rounded-xl border border-[var(--border-primary)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                Moodboards
              </button>
            </div>
          </div>
        )}

        {/* Two-column card grid at lg (panel is 560px there); single column
            on the narrow w-80 panel below lg. Stays mounted (hidden) under
            the Styles tab so card open/closed state survives tab switches. */}
        <div
          className={`${tab === "styles" ? "hidden" : "flex lg:grid"} flex-col gap-3 p-3 lg:grid-cols-2 lg:items-start`}
        >
          {/* Image: aspect ratio + quality */}
          <SettingCard
            title="Image"
            onReset={() => {
              updateSettings(SECTION_DEFAULTS.image);
              setCustomAspect("");
              setCustomOpen(false);
            }}
            defaultOpen
            headerSummary={`${settings.aspect} · ${qualityLabel}`}
          >
            <SettingLabel label="Aspect ratio" />
            <AspectPreview aspect={settings.aspect} />

            <div className="grid grid-cols-4 gap-1.5">
              {ASPECT_PRESETS.map((preset) => {
                const isActive =
                  !showCustomAspect && settings.aspect === preset.value;
                return (
                  <button
                    key={preset.value}
                    aria-pressed={isActive}
                    onClick={() => {
                      updateSettings({ aspect: preset.value });
                      setCustomAspect("");
                      setCustomOpen(false);
                    }}
                    className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition-[background-color,color,border-color] duration-150 ${
                      isActive
                        ? "border-splash/20 bg-splash/10 text-splash"
                        : "border-[var(--border-primary)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                    }`}
                  >
                    {preset.value}
                  </button>
                );
              })}
              <button
                aria-pressed={showCustomAspect}
                onClick={() => {
                  if (!isCustom) {
                    setCustomAspect(settings.aspect);
                  }
                  setCustomOpen(true);
                }}
                className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition-[background-color,color,border-color] duration-150 ${
                  showCustomAspect
                    ? "border-splash/20 bg-splash/10 text-splash"
                    : "border-[var(--border-primary)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                }`}
              >
                Custom
              </button>
            </div>

            {/* Custom W:H field — only in Custom mode, so the ratio isn't
                printed three times (preview label, preset, field). */}
            {showCustomAspect && (
              <input
                type="text"
                aria-label="Custom aspect ratio (W:H)"
                value={customAspect}
                onChange={(e) => {
                  setCustomAspect(e.target.value);
                  if (parseAspect(e.target.value)) {
                    updateSettings({ aspect: e.target.value });
                  }
                }}
                className="mt-1 w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-1.5 text-center font-mono text-sm text-[var(--text-primary)] focus:border-splash/30 focus:outline-none"
                placeholder="W:H"
              />
            )}

            <div className="flex flex-wrap items-center justify-between gap-y-1.5">
              <SettingLabel label="Quality" />
              <PillToggle
                options={QUALITY_OPTIONS}
                value={settings.quality}
                onChange={(v) => updateSettings({ quality: v })}
              />
            </div>
          </SettingCard>

          {/* Model */}
          <SettingCard
            title="Model"
            onReset={() => {
              updateSettings(SECTION_DEFAULTS.model);
              setSelectedWorkflow(null);
            }}
            defaultOpen
            headerSummary={engine.label}
          >
            {isLoading ? (
              <div className="flex items-center gap-2 py-1 text-[var(--text-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">Loading models...</span>
              </div>
            ) : modelError ? (
              <div className="flex items-center gap-2 py-1 text-red-400">
                <AlertCircle className="h-4 w-4" />
                <span className="text-sm">{modelError}</span>
              </div>
            ) : (
              <>
                {/* Version (engine) — routes the prompt bar to a model family */}
                <div>
                  <SettingLabel label="Version" />
                  <select
                    value={engine.value}
                    onChange={(e) => handleEngineChange(e.target.value)}
                    aria-label="Model version"
                    className="mt-1 w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:border-splash/30 focus:outline-none"
                  >
                    {ENGINE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  {engine.value === H3_IMAGE_ENGINE && (
                    <div className="mt-2">
                      <H3Attribution />
                    </div>
                  )}
                  {engine.krea2Backend === "direct" && (
                    <p className="mt-1 text-xs text-[var(--text-muted)]">
                      Uses the standalone Krea 2 backend instead of queueing the
                      ComfyUI graph.
                    </p>
                  )}
                </div>

                <div>
                  <SettingLabel label="Checkpoint" />
                  <ModelSelect
                    value={engine.workflow ? "" : (settings.model ?? "")}
                    options={available.checkpoints}
                    aliases={aliases.filter((a) => a.type === "checkpoint")}
                    onChange={(v) => updateSettings({ model: v || undefined })}
                    placeholder={
                      engine.workflow
                        ? `Managed by ${engine.label}`
                        : "Select checkpoint..."
                    }
                    disabled={Boolean(engine.workflow)}
                  />
                </div>

                <div>
                  <SettingLabel label="VAE" />
                  <ModelSelect
                    value={engine.workflow ? "" : (settings.vae ?? "")}
                    options={available.vaes}
                    aliases={aliases.filter((a) => a.type === "vae")}
                    onChange={(v) => updateSettings({ vae: v || undefined })}
                    placeholder={
                      engine.workflow
                        ? `Managed by ${engine.label}`
                        : "Default (from checkpoint)"
                    }
                    disabled={Boolean(engine.workflow)}
                  />
                </div>
              </>
            )}
          </SettingCard>

          {/* Aesthetics: raw mode + stylize / variety */}
          <SettingCard
            title="Aesthetics"
            onReset={() => updateSettings(SECTION_DEFAULTS.aesthetics)}
            defaultOpen
            headerSummary={`s ${settings.stylize} · v ${settings.chaos}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-y-1.5">
              <SettingLabel label="Mode" />
              <PillToggle
                options={MODE_OPTIONS}
                value={settings.modelMode}
                onChange={(v) => updateSettings({ modelMode: v })}
              />
            </div>

            <MJSlider
              label="Stylization"
              value={settings.stylize}
              min={0}
              max={1000}
              step={10}
              onChange={(v) => updateSettings({ stylize: v })}
              marks={["0", "100", "250", "500", "750", "1000"]}
            />
            <p className="-mt-2 text-xs text-[var(--text-tertiary)]">
              Slider LoRAs coming soon
            </p>

            <MJSlider
              label="Variety"
              value={settings.chaos}
              min={0}
              max={100}
              step={5}
              onChange={(v) => updateSettings({ chaos: v })}
              marks={["0", "25", "50", "75", "100"]}
            />
          </SettingCard>

          {/* More options: speed */}
          <SettingCard
            title="More options"
            onReset={() => updateSettings(SECTION_DEFAULTS.more)}
            defaultOpen
            headerSummary={settings.speed}
          >
            <div className="flex flex-wrap items-center justify-between gap-y-1.5">
              <SettingLabel label="Speed" />
              <PillToggle
                options={SPEED_OPTIONS}
                value={settings.speed}
                onChange={(v) => updateSettings({ speed: v })}
              />
            </div>
            {speedHint && (
              <p
                className="text-[11px] leading-tight text-[var(--text-tertiary)]"
                data-testid="speed-tier-hint"
              >
                {speedHint}
              </p>
            )}

          </SettingCard>

          {/* Video */}
          <SettingCard
            title="Video"
            onReset={() => updateSettings(SECTION_DEFAULTS.video)}
            defaultOpen={false}
            headerSummary={videoSummary}
          >
            {/* Default video engine for --video prompts */}
            <div className="flex flex-wrap items-center justify-between gap-y-1.5">
              <SettingLabel label="Video Model" />
              <PillToggle
                options={VIDEO_MODEL_OPTIONS}
                value={settingsVideoModel(settings.videoModel)}
                onChange={(v) => updateSettings({ videoModel: v })}
              />
            </div>

            {/* Variants per --video run (--vb); sequential, one seed each */}
            <div>
              <div className="flex flex-wrap items-center justify-between gap-y-1.5">
                <SettingLabel label="Variants" />
                <PillToggle
                  options={VIDEO_BATCH_PILLS}
                  value={videoBatch}
                  onChange={(v) => updateSettings({ videoBatch: v })}
                />
              </div>
              <p className="mt-1 text-[11px] leading-tight text-[var(--text-tertiary)]">
                Videos per run, each with its own seed. They render one after
                another, so 4 takes about 4x as long.
              </p>
            </div>

            {/* H3 Audio: Quality vs FastH3 (CUDA host; int8 DiT) */}
            {settings.videoModel === "minimax" && (
              <div className="flex flex-wrap items-center justify-between gap-y-1.5">
                <SettingLabel label="H3 Speed" />
                <PillToggle
                  options={H3_SPEED_OPTIONS}
                  value={settings.h3Speed ?? "off"}
                  onChange={(v) => updateSettings({ h3Speed: v })}
                />
              </div>
            )}

            {/* H3 warm backend (server-side process, not a store setting) */}
            <div className="flex items-center justify-between py-0.5">
              <div>
                <SettingLabel label="Keep H3 Warm" />
                <p className="text-[11px] leading-tight text-[var(--text-tertiary)]">
                  {h3Warm === "on"
                    ? "Dedicated H3 process holding ~87GB — renders skip the 2-3min model load"
                    : h3Warm === "starting"
                      ? "Starting dedicated H3 process…"
                      : "Off — H3 reloads models per render, RAM stays free"}
                </p>
              </div>
              <button
                onClick={() => void toggleH3Warm()}
                role="switch"
                aria-checked={h3Warm === "on"}
                aria-label="Keep H3 Warm"
                disabled={h3Warm === "starting"}
                className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors ${
                  h3Warm === "on"
                    ? "bg-splash"
                    : h3Warm === "starting"
                      ? "bg-splash/50"
                      : "bg-[var(--bg-tertiary)]"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                    h3Warm === "on" ? "translate-x-5" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          </SettingCard>

          {/* Advanced (sampler, steps, seed, memory) */}
          <SettingCard
            title="Advanced"
            onReset={() => updateSettings(SECTION_DEFAULTS.advanced)}
            defaultOpen={false}
            headerSummary={`${settings.sampler ?? "euler"} / ${settings.steps ?? 20} steps · batch ${settings.batchSize ?? 1}`}
          >
            <div className="grid grid-cols-2 gap-3">
              <div>
                <SettingLabel label="Sampler" />
                <ModelSelect
                  value={settings.sampler ?? ""}
                  options={available.samplers}
                  onChange={(v) => updateSettings({ sampler: v || undefined })}
                  placeholder="euler"
                />
              </div>
              <div>
                <SettingLabel label="Scheduler" />
                <ModelSelect
                  value={settings.scheduler ?? ""}
                  options={available.schedulers}
                  onChange={(v) =>
                    updateSettings({ scheduler: v || undefined })
                  }
                  placeholder="normal"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <MJSlider
                label="Steps"
                value={settings.steps ?? 20}
                min={1}
                max={150}
                step={1}
                onChange={(v) => updateSettings({ steps: v })}
                marks={["1", "75", "150"]}
              />
              <MJSlider
                label="CFG Scale"
                value={settings.cfg ?? 7}
                min={1}
                max={30}
                step={0.5}
                onChange={(v) => updateSettings({ cfg: v })}
                marks={["1", "15", "30"]}
              />
            </div>

            <div>
              <SettingLabel label="Batch Size" />
              <PillToggle
                options={BATCH_SIZE_OPTIONS}
                value={settings.batchSize ?? 1}
                onChange={(v) => updateSettings({ batchSize: v })}
              />
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                Default 1 protects smaller GPUs; raise only when you want
                parallel jobs. Images only: video uses Video → Variants.
              </p>
            </div>

            {/* Seed — fixed for reproducibility, empty for random */}
            <div>
              <div className="flex flex-wrap items-center justify-between gap-y-1.5">
                <SettingLabel label="Seed" />
                <button
                  type="button"
                  onClick={() =>
                    updateSettings({
                      seed: Math.floor(Math.random() * 2147483647),
                    })
                  }
                  className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  aria-label="Randomize seed"
                >
                  <Dices className="h-3 w-3" />
                  Roll
                </button>
              </div>
              <input
                type="text"
                inputMode="numeric"
                value={settings.seed ?? ""}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  if (raw === "") {
                    updateSettings({ seed: undefined });
                    return;
                  }
                  const n = Number(raw);
                  if (Number.isInteger(n) && n >= 0) {
                    updateSettings({ seed: n });
                  }
                }}
                className="mt-1 w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-1.5 font-mono text-sm text-[var(--text-primary)] focus:border-splash/30 focus:outline-none"
                placeholder="Random"
                aria-label="Seed"
              />
            </div>

            {/* Default negative prompt → --no */}
            <div>
              <SettingLabel label="Exclude (negative)" />
              <input
                type="text"
                value={settings.negative ?? ""}
                onChange={(e) =>
                  updateSettings({ negative: e.target.value || undefined })
                }
                className="mt-1 w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:border-splash/30 focus:outline-none"
                placeholder="e.g. text, watermark, blurry"
                aria-label="Negative prompt terms"
              />
            </div>

            {/* Clip skip → --clipskip (SD1.5/SDXL family only) */}
            <div>
              <div className="flex flex-wrap items-center justify-between gap-y-1.5">
                <SettingLabel label="Clip Skip" />
                <PillToggle
                  options={CLIP_SKIP_OPTIONS}
                  value={settings.clipSkip ?? 1}
                  onChange={(v) =>
                    updateSettings({ clipSkip: v > 1 ? v : undefined })
                  }
                />
              </div>
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                SD1.5 / SDXL / Pony / Illustrious only — ignored on other model
                families.
              </p>
            </div>

            {/* Tiled VAE decode → --tiledvae / --tiledvae-off */}
            <div>
              <div className="flex flex-wrap items-center justify-between gap-y-1.5">
                <SettingLabel label="Tiled VAE" />
                <PillToggle
                  options={TILED_VAE_OPTIONS}
                  value={settings.tiledVae ?? "auto"}
                  onChange={(v) => updateSettings({ tiledVae: v })}
                />
              </div>
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                Auto tiles the decode at 2048×2048+ or when memory is low.
              </p>
            </div>

            <SettingSwitch
              label="Unload on Model Switch"
              hint="Free ComfyUI memory when the model family changes"
              checked={settings.freeOnFamilySwitch !== false}
              onChange={(v) => updateSettings({ freeOnFamilySwitch: v })}
            />
            <SettingSwitch
              label="Memory Preflight"
              hint="Warn before a heavy model that won't fit free memory"
              checked={settings.memoryPreflight !== false}
              onChange={(v) => updateSettings({ memoryPreflight: v })}
            />
          </SettingCard>

          {/* System (ComfyUI) */}
          <button
            type="button"
            onClick={() => openOnboarding()}
            data-testid="open-onboarding"
            className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-4 py-3 text-left shadow-panel transition-colors hover:bg-[var(--bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-splash"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-[var(--text-primary)]">
                Connection &amp; models
              </span>
              <span className="mt-1 block text-xs text-[var(--text-muted)]">
                Where ComfyUI runs, starter models
              </span>
            </span>
            <ChevronDown className="h-4 w-4 -rotate-90 text-[var(--text-muted)]" />
          </button>
          <button
            type="button"
            onClick={() => startTour()}
            data-testid="settings-take-tour"
            className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-4 py-3 text-left shadow-panel transition-colors hover:bg-[var(--bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-splash"
          >
            <Compass className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-[var(--text-primary)]">
                Take the tour
              </span>
              <span className="mt-1 block text-xs text-[var(--text-muted)]">
                A short walk through every page
              </span>
            </span>
            <ChevronDown className="h-4 w-4 -rotate-90 text-[var(--text-muted)]" />
          </button>
          <SystemCard />

          {/* Folders (ComfyUI + Adrift library) */}
          <SettingCard
            title="Folders"
            defaultOpen={false}
            headerSummary="ComfyUI, models, input, output, Adrift library"
          >
            <FoldersEditor showSave />
          </SettingCard>

          {/* LoRAs */}
          <SettingCard
            title="LoRAs"
            onReset={() => updateSettings(SECTION_DEFAULTS.loras)}
            defaultOpen={false}
            headerSummary={
              settings.loras.length > 0
                ? `${settings.loras.length} active`
                : undefined
            }
          >
            <LoraManager
              loras={settings.loras}
              availableLoras={available.loras}
              selectedModel={settings.model}
              aliases={aliases.filter((a) => a.type === "lora")}
              onChange={(loras) => updateSettings({ loras })}
            />
          </SettingCard>

          {/* Appearance */}
          <SettingCard
            title="Appearance"
            defaultOpen={false}
            headerSummary={`${appearanceSummary} · ${glassUI ? "Liquid Glass" : "Solid"}`}
          >
            <AppearanceSettings />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-y-1.5">
              <SettingLabel label="Liquid Glass" />
              <PillToggle
                options={[
                  { label: "Off", value: "off" },
                  { label: "On", value: "on" },
                ]}
                value={glassUI ? "on" : "off"}
                onChange={(v) => setGlassUI(v === "on")}
              />
            </div>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Frosted translucent chrome for the sidebar, prompt bar, and
              panels.
            </p>
          </SettingCard>

          {/* Global reset — two-step so one stray click can't wipe every
              setting */}
          <ResetAllButton
            onReset={() => useUIStore.getState().resetSettings()}
          />
        </div>
      </div>
    </aside>
  );
}

/** "Reset All to Defaults" with an inline confirm step. */
export function ResetAllButton({
  onReset,
  initialConfirming = false,
}: {
  onReset: () => void;
  /** Test hook: render the confirm step directly. */
  initialConfirming?: boolean;
}) {
  const [confirming, setConfirming] = useState(initialConfirming);
  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="w-full rounded-xl border border-[var(--border-primary)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] lg:col-span-2"
      >
        Reset All to Defaults
      </button>
    );
  }
  return (
    <div
      role="group"
      aria-label="Confirm reset"
      className="flex w-full flex-wrap items-center gap-2 rounded-xl border border-[var(--border-secondary)] px-4 py-2 lg:col-span-2"
    >
      <p className="min-w-0 flex-1 text-sm text-[var(--text-primary)]">
        Reset every setting on this panel? This can&apos;t be undone.
      </p>
      <button
        type="button"
        autoFocus
        onClick={() => setConfirming(false)}
        className="rounded-lg px-3 py-1 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={() => {
          setConfirming(false);
          onReset();
        }}
        className="rounded-lg bg-[var(--bg-hover)] px-3 py-1 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-active)]"
      >
        Reset all
      </button>
    </div>
  );
}

interface ModelSelectProps {
  value: string;
  options: string[];
  aliases?: { alias: string; filename: string }[];
  onChange: (value: string) => void;
  placeholder?: string;
  /** Engine-managed selects render read-only (e.g. Ideogram 4 bakes its models) */
  disabled?: boolean;
}

function ModelSelect({
  value,
  options,
  aliases = [],
  onChange,
  placeholder,
  disabled = false,
}: ModelSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");

  const allOptions = [
    ...aliases.map((a) => ({
      label: a.alias,
      value: a.filename,
      isAlias: true,
    })),
    ...options.map((o) => ({ label: o, value: o, isAlias: false })),
  ];
  const filtered = allOptions.filter((o) =>
    o.label.toLowerCase().includes(search.toLowerCase()),
  );
  const displayValue =
    aliases.find((a) => a.filename === value)?.alias ?? value;

  return (
    <div className="relative">
      <button
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`flex w-full items-center justify-between rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-1.5 text-left transition-colors ${
          disabled
            ? "cursor-not-allowed opacity-60"
            : "hover:border-[var(--border-secondary)]"
        }`}
      >
        <span
          className={`truncate text-sm ${value ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`}
        >
          {displayValue || placeholder}
        </span>
        <ChevronDown
          className={`ml-1 h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)] transition-transform ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute z-50 mt-1 w-full max-h-56 overflow-auto rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] shadow-xl">
            <div className="border-b border-[var(--border-primary)] p-2">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                className="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-2 py-1 text-sm focus:border-splash/30 focus:outline-none"
                autoFocus
              />
            </div>
            <div className="py-1">
              {placeholder && (
                <button
                  onClick={() => {
                    onChange("");
                    setIsOpen(false);
                  }}
                  className="w-full px-3 py-1.5 text-left text-sm text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
                >
                  {placeholder}
                </button>
              )}
              {filtered.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => {
                    onChange(opt.value);
                    setIsOpen(false);
                  }}
                  className={`w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--bg-hover)] ${
                    opt.value === value ? "bg-splash/5 text-splash" : ""
                  } ${opt.isAlias ? "text-splash/70" : ""}`}
                >
                  {opt.label}
                  {opt.isAlias && (
                    <span className="ml-2 text-xs text-[var(--text-muted)]">
                      (alias)
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface LoraManagerProps {
  loras: LoraWeight[];
  availableLoras: string[];
  aliases: { alias: string; filename: string }[];
  selectedModel?: string;
  onChange: (loras: LoraWeight[]) => void;
}

function LoraManager({
  loras,
  availableLoras,
  aliases,
  selectedModel,
  onChange,
}: LoraManagerProps) {
  // Stable per-row keys: LoraWeight has no id field, and keying by index
  // shifts each ModelSelect's local dropdown/search state onto the wrong
  // LoRA when a middle row is removed.
  const nextRowKey = useRef(0);
  const rowKeys = useRef<string[]>([]);
  while (rowKeys.current.length < loras.length) {
    rowKeys.current.push(`lora-row-${nextRowKey.current++}`);
  }
  rowKeys.current.length = loras.length;

  const addLora = () => onChange([...loras, { name: "", strength: 1.0 }]);
  const updateLora = (index: number, update: Partial<LoraWeight>) => {
    const next = [...loras];
    next[index] = { ...next[index], ...update };
    onChange(next);
  };
  const removeLora = (index: number) => {
    rowKeys.current.splice(index, 1);
    onChange(loras.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-2">
      {loras.map((lora, index) => (
        <div key={rowKeys.current[index]}>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <ModelSelect
                value={lora.name}
                options={availableLoras}
                aliases={aliases}
                onChange={(v) => updateLora(index, { name: v })}
                placeholder="Select LoRA..."
              />
            </div>
            <input
              type="number"
              value={lora.strength}
              onChange={(e) =>
                updateLora(index, { strength: parseFloat(e.target.value) || 0 })
              }
              className="w-16 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-2 py-1.5 text-sm focus:border-splash/30 focus:outline-none"
              step={0.05}
              min={-2}
              max={2}
            />
            <button
              aria-label="Remove LoRA"
              onClick={() => removeLora(index)}
              className="p-2 text-[var(--text-muted)] transition-colors hover:text-red-400"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          {lora.name && (
            <LoraMetaInfo
              filename={
                availableLoras.includes(lora.name)
                  ? lora.name
                  : (aliases.find((a) => a.alias === lora.name)?.filename ?? "")
              }
              selectedModel={selectedModel}
            />
          )}
        </div>
      ))}
      <button
        onClick={addLora}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--border-primary)] px-3 py-1.5 text-sm text-[var(--text-muted)] transition-colors hover:border-splash hover:text-splash"
      >
        <Plus className="h-3.5 w-3.5" />
        Add LoRA
      </button>
    </div>
  );
}

export default SettingsPanel;
