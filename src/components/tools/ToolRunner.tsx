"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { ChevronRight, Loader2, Play } from "lucide-react";
import { radioKeyTarget } from "@/lib/tools/radioNav";
import { setupHint } from "@/lib/tools/setupHint";
import {
  applySceneFill,
  patchedFields,
  sceneFill,
  sceneSourced,
  type SceneFill,
} from "@/lib/tools/scene";
import { useSceneStore } from "@/store/sceneStore";
import { FromScene } from "./SceneChip";
import { modelLine } from "@/lib/tools/hub";
import type { BadgeSource } from "@/lib/tools/licenseBadges";
import {
  RUN_BUTTON_FOOTER,
  RunError,
  RunnerHeader,
  RunnerNotice,
} from "./RunnerShell";
import { OutputFormatPicker } from "./OutputFormatPicker";
import { ChoicePicker } from "./ChoicePicker";
import {
  PresetGrid,
  RunHint,
  RunnerStage,
  RunnerStudio,
  useRecentRunsStore,
  useRecentToolRuns,
} from "./RunnerStudio";
import { useRunnerCard } from "./ToolCover";
import {
  isPresetPicker,
  outputForCategory,
  picksAreFast,
} from "@/lib/tools/runnerStudio";
import { useGenerationStore, useUIStore } from "@/store";
import { showToast } from "@/components/Toast";
import {
  ToolInputError,
  buildActionRequest,
  defaultSettings,
  editFamilies,
  editLorasIn,
  catalogLicenseLinks,
  licenseNoteFor,
  OUTPAINT_ANCHORS,
  OUTPAINT_ZOOM_PRESETS,
  zoomPresetSettings,
  OUTPAINT_ASPECTS,
  OUTPAINT_DIRECTIONS,
  audioActive,
  pickBlock,
  pickEditLora,
  pickValue,
  pickerVisible,
  previewCatalogPrompt,
  sliderValue,
  sliderVisible,
  textVisible,
  secondTextVisible,
  videoWindowSeconds,
  type ActionChoice,
  type ActionPicker,
  type ActionToolSpec,
  type CatalogTool,
  type EditLoraListResponse,
  type OutpaintAnchor,
  type OutpaintDirection,
  type ToolCard,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import {
  ToolApiError,
  describeCaption,
  describeImage,
  exportActionToolWorkflow,
  exportCatalogToolWorkflow,
  submitActionTool,
  submitCatalogTool,
  submitTextTool,
  submitVideoTool,
  type ToolAudio,
  type ToolImage,
  type ToolVideo,
} from "@/lib/tools/runTool";
import { ToolAudioInput } from "./ToolAudioInput";
import { Sa3AudioControls } from "./Sa3AudioControls";
import { LtxLoraControls } from "./LtxLoraControls";
import { CharSheetViews } from "./CharSheetViews";
import { charSheetSize } from "@/lib/oj/h3CharSheet";
import { LTX_EXTRA_LORA_TOOLS } from "@/lib/oj/ltxCommunityLoras";
import { isSa3Tool } from "@/lib/tools/sa3Tools";
import { Sa3PackHint } from "./Sa3PackHint";
import { sa3PackFixes } from "@/lib/tools/sa3Setup";
import { previewSwatches } from "@/lib/tools/videoPalette";
import { RunFailureNotice } from "./RunFailureNotice";
import {
  classifyRunError,
  type RunFailure,
} from "@/lib/comfy/runFailure";
import { ToolImageInput } from "./ToolImageInput";
import { useToolHandoff } from "./useToolHandoff";
import { useToolHandoffStore } from "@/store/toolHandoffStore";
import { EditorReturnNote, useEditorOrigin } from "./EditorReturn";
import {
  SendToGraphButton,
  UseGraphImageButton,
  useGraphImageHandoff,
  useIsOverlay,
} from "./OverlayGraphActions";
import {
  CharacterProfilePicker,
  resolveProfileRef,
} from "./CharacterProfilePicker";
import { SceneStitchBar } from "./SceneStitchBar";
import {
  applyProfileSuffix,
  pickProfileSlot,
  type CharacterProfile,
} from "@/lib/tools/characterProfiles";
import { AvatarPresetPicker } from "./AvatarPresetPicker";
import { ToolVideoInput } from "./ToolVideoInput";
import { MaskPainter } from "./MaskPainter";
import { VideoMaskPicker } from "./VideoMaskPicker";
import { FocusPointPicker } from "./FocusPointPicker";
import { MotionPathPainter } from "./MotionPathPainter";
import type { WanMoveDraw } from "@/lib/oj/wanMoveDraw";
import {
  SMART_TRACK_ACTIONS,
  SMART_TRACK_WINDOW_SECONDS,
  hasSmartTrack,
  type SmartTrackOccurrence,
} from "@/lib/tools/smartTrack";
import { regionMaskTool } from "@/lib/tools/maskWiring";
import {
  UpscaleModelPicker,
  useUpscalerDefaults,
} from "@/components/upscale/UpscaleModelPicker";
import { UpscaleAfterToggle } from "@/components/upscale/UpscaleAfterToggle";
import {
  UPSCALE_GRAPH_PARAM,
  chainLabel,
  defaultUpscaleAfter,
  effectiveUpscaleAfter,
  upscaleAfterMedia,
  type UpscaleAfterChoice,
} from "@/lib/upscale/upscaleAfter";
import { useUpscaleAfterStore } from "@/store/upscaleAfterStore";
import { VIDEO_UPSCALE_ACTION } from "@/lib/upscale/upscaleModels";
import { CinemaStudio } from "./CinemaStudio";
import { HdrCompareResult } from "./HdrCompareResult";
import {
  COMPARE_SOURCE_TOOLS,
  rememberCompareSource,
} from "@/lib/tools/compareSources";
import { ShowGraphButton } from "./GraphPreview";
import { H3Attribution, LikenessConsent, useLikenessConsent } from "./H3Notice";
import {
  appendCinema,
  cinemaSupported,
  compileCinema,
  compileSceneShots,
  sceneActive,
  CINEMA_TOOL_OMIT,
  type CinemaScene,
  type CinemaSettings,
} from "@/lib/tools/cinema";
import { isH3Model, needsLikenessConsent } from "@/lib/tools/h3License";

interface ToolRunnerProps {
  card: ToolCard;
  catalogTool?: CatalogTool;
  actionSpec?: ActionToolSpec;
  editLoras: EditLoraListResponse | null;
  onBack: () => void;
  /** Open model line from the hub (action tools). */
  model?: string | null;
  /** License note from the hub for action tools (e.g. non-commercial weights). */
  hubLicenseNote?: string | null;
  /** License links for the hub note (license text / model page). */
  hubLicenseLinks?: BadgeSource[];
}

export const field =
  "w-full rounded-lg border border-light-100 dark:border-dark-750 bg-light-input dark:bg-dark-input px-3 py-2 text-sm text-light-primary dark:text-dark-primary placeholder:text-light-500 dark:placeholder:text-dark-400 focus:outline-none focus:ring-2 focus:ring-splash";

/** Picker options with optionIssue applied for the picked source video. */
function pickerOptionsFor(
  p: ActionPicker,
  video: { width: number; height: number } | null,
): ActionChoice[] {
  if (!p.optionIssue || !video?.width || !video.height) return p.options;
  return p.options.map((o) => {
    const issue = p.optionIssue!(o.id, video);
    return issue ? { ...o, disabled: true, hint: issue } : o;
  });
}

/** First visible pick that can't run on this video (its reason), else null. */
function pickIssue(
  spec: ActionToolSpec,
  settings: ToolSettings,
  video: { width: number; height: number },
): string | null {
  if (!video.width || !video.height) return null;
  for (const p of spec.pickers ?? []) {
    if (!p.optionIssue || !pickerVisible(p, spec, settings)) continue;
    const issue = p.optionIssue(pickValue(p, settings), video);
    if (issue) return issue;
  }
  return null;
}

/** Collapsed "Advanced" block: expert knobs out of a beginner's way. */
const ADVANCED_DETAILS =
  "group rounded-xl border border-light-100 p-3 text-xs dark:border-dark-750";

const STEPS_HINT =
  "More steps can add detail but take longer. Leave blank for the tool's tuned default.";
const CFG_HINT =
  "How strictly the prompt is followed. Higher is more literal, lower is looser. Leave blank for the default.";
const SEED_HINT =
  "Same seed + same inputs = the same result. Leave blank for a new variation each run.";

function AdvancedSummary() {
  return (
    <summary className="-m-1 flex cursor-pointer list-none items-center gap-1.5 rounded-lg p-1 font-medium text-light-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-splash dark:text-dark-primary [&::-webkit-details-marker]:hidden">
      <ChevronRight
        aria-hidden
        className="h-3.5 w-3.5 text-light-500 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none dark:text-dark-400"
      />
      Advanced
      <span className="font-normal text-light-500 dark:text-dark-400">
        optional
      </span>
    </summary>
  );
}

export function Segmented({
  label,
  value,
  options,
  onChange,
  disabled,
  hint,
  labelExtra,
}: {
  label: string;
  value: string;
  options: { id: string; label: string; hint?: string; disabled?: boolean }[];
  onChange: (id: string) => void;
  disabled?: boolean;
  hint?: string;
  /** Shown after the label (e.g. the "from scene" marker). */
  labelExtra?: React.ReactNode;
}) {
  const hintId = useId();
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
        {label}
        {labelExtra}
      </span>
      <div
        role="radiogroup"
        aria-label={label}
        aria-describedby={hint ? hintId : undefined}
        className="flex flex-wrap gap-1.5"
        onKeyDown={(e) => {
          if (disabled) return;
          const from = Math.max(
            0,
            options.findIndex((o) => o.id === value),
          );
          const to = radioKeyTarget(
            options.map((o) => !!o.disabled),
            from,
            e.key,
          );
          if (to === null) return;
          e.preventDefault();
          onChange(options[to]!.id);
          const radios =
            e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
          radios[to]?.focus();
        }}
      >
        {options.map((o, i) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={value === o.id}
            // One tab stop per group; arrows move between options.
            tabIndex={
              value === o.id ||
              (!options.some((x) => x.id === value) && i === 0)
                ? 0
                : -1
            }
            title={o.hint}
            disabled={disabled || o.disabled}
            onClick={() => onChange(o.id)}
            className={`min-h-8 rounded-full border px-3 py-1.5 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-splash disabled:opacity-40 ${
              value === o.id
                ? "border-splash bg-splash/10 text-splash"
                : "border-light-100 dark:border-dark-750 text-light-500 dark:text-dark-400 hover:border-splash/60"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {hint && (
        <p id={hintId} className="text-[11px] text-light-500 dark:text-dark-400">
          {hint}
        </p>
      )}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className={`flex items-start gap-2.5 text-xs ${disabled ? "opacity-50" : ""}`}
    >
      <input
        type="checkbox"
        className="mt-0.5 accent-[var(--accent-primary)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="font-medium text-light-primary dark:text-dark-primary">
          {label}
        </span>
        {hint && (
          <span className="block text-light-500 dark:text-dark-400">
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}

export function loadBlob(url: string): Promise<Blob> {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`image fetch ${r.status}`);
    return r.blob();
  });
}

/** Palette preset tile art: the preset's own swatches. */
function paletteThumb(id: string): React.ReactNode | null {
  const sw = previewSwatches("preset", id, "");
  if (!sw.length) return null;
  return (
    <span className="absolute inset-0 flex">
      {sw.map((c, i) => (
        <span
          key={`${c.hex}-${i}`}
          style={{ backgroundColor: c.hex, flexGrow: c.weight }}
        />
      ))}
    </span>
  );
}

export function ToolRunner({
  card,
  catalogTool,
  actionSpec,
  editLoras,
  onBack,
  model,
  hubLicenseNote,
  hubLicenseLinks,
}: ToolRunnerProps) {
  const clientId = useGenerationStore((s) => s.clientId);
  const addRun = useGenerationStore((s) => s.addRun);
  const setActiveNav = useUIStore((s) => s.setActiveNav);
  const setPromptValue = useUIStore((s) => s.setPromptValue);

  const tool = catalogTool;
  const spec = actionSpec;
  const videoLabel = spec?.videoInput;
  const audioInputLabel = spec?.audioInput;
  // Video-in tools take the clip separately; the only image is the reference.
  const refCount = tool
    ? tool.refCount
    : spec?.noSourceInput
      ? 0
      : videoLabel
        ? spec?.secondImage
          ? 1 + (spec.extraImages?.length ?? 0)
          : 0
        : spec?.secondImage
          ? 2 + (spec.extraImages?.length ?? 0)
          : 1;
  const refLabels = tool
    ? tool.refLabels
    : videoLabel
      ? [spec?.secondImage ?? "Reference", ...(spec?.extraImages ?? [])]
      : spec?.secondImage
        ? [
            spec.firstImage ?? "Photo",
            spec.secondImage,
            ...(spec.extraImages ?? []),
          ]
        : ["Image"];

  // Scene (Tools header) fills matching fields until edited on this card.
  const sceneState = useSceneStore((s) => s.scene);
  const baseSettings = useMemo(
    () => defaultSettings(tool ?? spec),
    [tool, spec],
  );
  const fill = useMemo(
    () => sceneFill(tool ?? spec, sceneState),
    [tool, spec, sceneState],
  );
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const touch = useCallback(
    (ids: string[]) =>
      setTouched((t) =>
        ids.every((id) => t.has(id)) ? t : new Set([...t, ...ids]),
      ),
    [],
  );
  const [appliedFill, setAppliedFill] = useState<SceneFill>(fill);
  const [settings, setSettings] = useState<ToolSettings>(() =>
    applySceneFill(baseSettings, baseSettings, {}, fill, new Set()),
  );
  useEffect(() => {
    if (JSON.stringify(fill) === JSON.stringify(appliedFill)) return;
    setSettings((s) =>
      applySceneFill(s, baseSettings, appliedFill, fill, touched),
    );
    setAppliedFill(fill);
  }, [fill, appliedFill, baseSettings, touched]);
  const fromScene = sceneSourced(settings, fill, touched);
  const sceneMark = (id: string) =>
    fromScene.has(id) ? <FromScene /> : null;
  const [images, setImages] = useState<(ToolImage | null)[]>(() =>
    Array.from({ length: refCount }, () => null),
  );
  const [video, setVideo] = useState<ToolVideo | null>(null);
  // Audio picker label while it applies (voiceover: clone engine only).
  const audioLabel =
    audioInputLabel && audioActive(spec, settings)
      ? audioInputLabel
      : undefined;
  const [audio, setAudio] = useState<ToolAudio | null>(null);
  const [mask, setMask] = useState<string | null>(null);
  // Per-subject masks (region tools: one paste-back pass per subject).
  const [subjectMasks, setSubjectMasks] = useState<(string | null)[]>([]);
  const regionMask = tool ? null : regionMaskTool(spec?.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Submit failures (ComfyUI down, rejected prompt, ...) with a next step.
  const [failure, setFailure] = useState<RunFailure | null>(null);
  const [queued, setQueued] = useState(false);
  // "Upscale after": Settings default, overridable for this tool visit.
  const upAfterMedia = upscaleAfterMedia(card.key);
  const upDefaults = useUpscalerDefaults();
  const [upAfterOverride, setUpAfterOverride] =
    useState<UpscaleAfterChoice | null>(null);
  useEffect(() => setUpAfterOverride(null), [card.key]);
  const upAfter = upAfterMedia
    ? effectiveUpscaleAfter(upAfterOverride, upDefaults?.pref, upAfterMedia)
    : null;
  const upAfterDefault = upAfterMedia
    ? defaultUpscaleAfter(upDefaults?.pref, upAfterMedia)
    : null;
  const recentRuns = useRecentToolRuns(card.key);
  const hubCard = useRunnerCard();
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [captioning, setCaptioning] = useState(false);
  const [cinema, setCinema] = useState<CinemaSettings>({});
  /** Shot runs of the last queued scene, in shot order (for Stitch scene). */
  const [sceneRunIds, setSceneRunIds] = useState<string[] | null>(null);
  const needsConsent = needsLikenessConsent(card.key);
  const [consented, setConsented] = useLikenessConsent(card.key);
  const h3 = !tool && isH3Model(model);
  const showCinema = !tool && cinemaSupported(spec?.id);
  const cinemaSuffix = showCinema
    ? compileCinema(cinema, CINEMA_TOOL_OMIT[spec?.id ?? ""] ?? [])
    : "";
  // Settings actually sent: the Cinema Studio suffix rides on the prompt.
  const sendSettings: ToolSettings = cinemaSuffix
    ? { ...settings, text: appendCinema(settings.text, cinemaSuffix) }
    : settings;
  // Multi-shot scene: one full prompt per shot (replaces the single suffix).
  const [scene, setScene] = useState<CinemaScene | null>(null);
  const scenePrompts =
    showCinema && sceneActive(scene)
      ? compileSceneShots(
          settings.text,
          scene as CinemaScene,
          cinema,
          CINEMA_TOOL_OMIT[spec?.id ?? ""] ?? [],
        )
      : null;

  const patch = useCallback(
    (p: Partial<ToolSettings>) => {
      touch(patchedFields(p));
      setSettings((s) => ({ ...s, ...p }));
    },
    [touch],
  );
  const setWanMoveDraw = useCallback(
    (wanMoveDraw: WanMoveDraw | undefined) => patch({ wanMoveDraw }),
    [patch],
  );
  const setPick = (key: string, value: string) => {
    touch([`picks.${key}`]);
    setSettings((s) => ({ ...s, picks: { ...s.picks, [key]: value } }));
  };
  const setImage = (i: number, img: ToolImage | null) => {
    setImages((prev) => prev.map((p, idx) => (idx === i ? img : p)));
    if (i === 0) {
      setMask(null);
      setSubjectMasks([]);
    }
    setQueued(false);
    setSuggestions([]);
  };

  // ComfyUI overlay: images picked in the graph + "Send to graph".
  const overlay = useIsOverlay();
  const graphInputs = overlay && refCount > 0 && !videoLabel;
  const setGraphImage = (img: ToolImage) => {
    const empty = images.findIndex((i) => !i);
    setImage(empty >= 0 ? empty : 0, img);
  };
  useGraphImageHandoff(
    overlay,
    graphInputs,
    (img) => setImage(0, img),
    setError,
  );
  // Lightbox / editor "Tools" panel: the open image/clip arrives as the
  // first input; from the editor, its selection seeds the mask painter and
  // image results go back there.
  // Video editor: its subject picks become this tool's smart selection.
  const editorOrigin = useEditorOrigin(card.title, (smartTrack) =>
    setSettings((s) => ({ ...s, smartTrack })),
  );
  useToolHandoff(card.key, {
    onHandoff: editorOrigin.onHandoff,
    onImage:
      refCount > 0 && !videoLabel ? (img) => setImage(0, img) : undefined,
    onMoreImage:
      refCount > 1 && !videoLabel
        ? (slot, img) => {
            if (slot < refCount) setImage(slot, img);
          }
        : undefined,
    onVideo: videoLabel ? (v) => setVideo(v) : undefined,
    onAudio: spec?.audioHandoff ? (a) => setAudio(a) : undefined,
    onError: setError,
  });
  // "Made with" chip: the run's settings (choices, speed, prompt) come back.
  useEffect(() => {
    const p = useToolHandoffStore.getState().takePrefill(card.key);
    if (!p) return;
    setSettings((s) => ({
      ...s,
      ...p.settings,
      picks: { ...s.picks, ...p.settings.picks },
    }));
  }, [card.key]);
  // Character profile: fills the identity-like image slot, adds its suffix.
  const profileSlot = pickProfileSlot(refLabels.slice(0, refCount));
  const applyProfile = (
    img: ToolImage | null,
    next: CharacterProfile | null,
    prev: CharacterProfile | null,
  ) => {
    if (img) setImage(profileSlot, img);
    else if (prev?.refs.some((r) => r.id === images[profileSlot]?.id))
      setImage(profileSlot, null);
    if (showText)
      setSettings((s) => ({
        ...s,
        text: applyProfileSuffix(s.text, next, prev),
      }));
  };

  // Scene character from a saved profile: its reference fills the same
  // identity slot (the look rides in the scene character text, not a suffix).
  const applySceneProfile = (p: CharacterProfile) => {
    if (refCount === 0 || !p.refs[0]) return;
    resolveProfileRef(p.refs[0], profileSlot > 0 || Boolean(videoLabel))
      .then((img) => setImage(profileSlot, img))
      .catch(() => setError("Couldn't load that profile's reference image."));
  };

  // Smart select (video tools with text-prompted SAM): clicks replace the prompt.
  const smartTrackOn =
    !tool && Boolean(spec && SMART_TRACK_ACTIONS.has(spec.id));
  const hasClicks = smartTrackOn && hasSmartTrack(settings.smartTrack);
  // Per-person Smart select (cast_swap): one click list per reference photo.
  const perRefTrack = !tool && Boolean(spec?.smartTrackPerRef);
  const [trackSubject, setTrackSubject] = useState(0);
  const setSubjectClicks = (k: number, next: SmartTrackOccurrence[]) => {
    const all = [...(settings.smartTrackSubjects ?? [])];
    while (all.length <= k) all.push([]);
    all[k] = next;
    patch({
      smartTrackSubjects: all.some((c) => c.length) ? all : undefined,
    });
  };
  const requiresText = tool
    ? tool.promptMode === "required"
    : Boolean(spec?.text?.required) && !hasClicks;
  const showText = tool
    ? tool.promptMode !== "none"
    : textVisible(spec, settings);
  const textLabel = tool
    ? tool.promptMode === "required"
      ? "Prompt"
      : "Prompt (optional)"
    : `${spec?.text?.label ?? "Prompt"}${
        spec?.text?.required || /\(optional\)/i.test(spec?.text?.label ?? "")
          ? ""
          : " (optional)"
      }`;
  const textPlaceholder = tool
    ? tool.promptHint
    : (spec?.text?.placeholder ?? "");

  const licenseNote = useMemo(
    () => (tool ? licenseNoteFor(tool.license) : (hubLicenseNote ?? null)),
    [tool, hubLicenseNote],
  );
  const licenseLinks = useMemo(
    () => (tool ? catalogLicenseLinks(tool.license) : (hubLicenseLinks ?? [])),
    [tool, hubLicenseLinks],
  );
  const catalogPreview =
    tool && tool.options.length > 0 ? previewCatalogPrompt(tool, settings) : "";

  const lora = spec?.usesEditLora
    ? pickEditLora(spec, settings, editLoras)
    : null;
  const families = editFamilies(editLoras);
  const activeFamily = spec?.picksEditFamily
    ? (settings.editFamily ?? families[0]?.id ?? "")
    : "";

  // Restyle tools rebuild the image from structure, so the prompt is a full scene description:
  // seed it from a local caption of the input (StyleVault Qwen3-VL), then the user edits the style.
  const canCaption = Boolean(tool && tool.category === "Restyle" && showText);
  const captionInput = async () => {
    const img = images[0];
    if (!img || captioning) return;
    setCaptioning(true);
    setError(null);
    try {
      patch({ text: await describeCaption(fetch, img, loadBlob) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCaptioning(false);
    }
  };

  // A picked option that runs through another tool (Motion presets' LTX-2.5
  // engine) blocks Run while that tool's pack or models are missing.
  const optionBlock =
    card.available && spec && !tool ? pickBlock(card, spec, settings) : null;
  const blocked = !card.available || optionBlock !== null;
  const blockChecking = optionBlock ? optionBlock.checking : card.checking;
  const blockReason =
    (optionBlock ? optionBlock.reason : card.unavailableReason) ??
    "Not available on this server.";
  const blockModel = optionBlock
    ? optionBlock.model
    : tool
      ? tool.baseLabel
      : model;
  // Video tools with an optional reference (Restyle video) run without it;
  // image tools with one need only the first photo. Extra reference slots
  // (spec.extraImages) are always optional.
  const missingImages =
    !(videoLabel && spec?.secondImageOptional) &&
    images
      .slice(0, videoLabel || spec?.secondImageOptional ? 1 : 2)
      .some((i) => !i);

  const compareStage = !tool && !!spec && COMPARE_SOURCE_TOOLS.has(spec.id);

  const run = async () => {
    setError(null);
    setFailure(null);
    setQueued(false);
    setBusy(true);
    try {
      if (needsConsent && !consented)
        throw new ToolInputError(
          "Confirm the likeness consent statement first.",
        );
      if (spec?.special === "describe") {
        const img = images[0];
        if (!img) throw new ToolInputError("Add an image first.");
        setSuggestions(await describeImage(fetch, img, loadBlob));
        return;
      }
      // Optional custom nodes the server bypassed (same toast as imagine).
      const onWarnings = (warnings: string[]) =>
        warnings.forEach((w) => showToast(w, "info", 8000));
      const submit = (sent: ToolSettings) =>
        tool
          ? submitCatalogTool({
              fetchImpl: fetch,
              tool,
              settings,
              images,
              mask,
              clientId,
              onWarnings,
            })
          : spec?.noSourceInput
            ? submitTextTool({
                fetchImpl: fetch,
                spec,
                settings: sent,
                audio,
                clientId,
                onWarnings,
              })
            : videoLabel
              ? submitVideoTool({
                  fetchImpl: fetch,
                  spec: spec as ActionToolSpec,
                  settings: sent,
                  video,
                  face: images[0],
                  extras: images.slice(1),
                  audio,
                  clientId,
                  onWarnings,
                })
              : submitActionTool({
                  fetchImpl: fetch,
                  spec: spec as ActionToolSpec,
                  settings: sent,
                  editLoras,
                  image: images[0],
                  secondImage: images[1] ?? null,
                  extraImages: images.slice(2),
                  audio,
                  clientId,
                  onWarnings,
                  ...(regionMask ? { subjectMasks, mask } : {}),
                });
      // Multi-shot scene: one run per shot, same source, queued in order.
      const queue = scenePrompts
        ? scenePrompts.map((text) => ({ ...sendSettings, text }))
        : [sendSettings];
      const queuedIds: string[] = [];
      let chained = 0;
      let selfUpscaled = 0;
      setSceneRunIds(null);
      for (const sent of queue) {
        const run = await submit(sent);
        addRun(run);
        editorOrigin.track(run.run_id);
        queuedIds.push(run.run_id);
        if (upAfter?.on) {
          if (run.params?.[UPSCALE_GRAPH_PARAM] === true) selfUpscaled++;
          else {
            useUpscaleAfterStore.getState().add({
              parentRunId: run.run_id,
              parentLabel: card.title,
              cardKey: card.key,
              factor: upAfter.factor,
              createdAt: Date.now(),
              status: "waiting",
              children: [],
            });
            chained++;
          }
        }
        if (compareStage && images[0])
          rememberCompareSource(run.run_id, {
            url: images[0].previewUrl,
            width: images[0].width,
            height: images[0].height,
          });
      }
      if (scenePrompts) setSceneRunIds(queuedIds);
      useRecentRunsStore.getState().note(card.key, [...queuedIds].reverse());
      setQueued(true);
      showToast(
        scenePrompts
          ? `${scenePrompts.length} shots queued. Progress shows in Create.`
          : `${card.title} queued. Progress shows in Create.`,
        "success",
      );
      if (chained > 0)
        showToast(
          `${chainLabel(upAfter?.factor ?? 2, upAfterMedia ?? "image")} queues when ${chained > 1 ? "each finishes" : "it finishes"}.`,
          "info",
        );
      else if (selfUpscaled > 0)
        showToast(`${card.title} already upscales; no extra pass.`, "info");
    } catch (e) {
      if (e instanceof ToolInputError) {
        setError(e.message);
      } else if (e instanceof ToolApiError) {
        setFailure(
          classifyRunError({
            message: e.message,
            status: e.status,
            code: e.code,
            details: e.details,
          }),
        );
      } else {
        setFailure(
          classifyRunError({
            message: e instanceof Error ? e.message : "Something went wrong.",
          }),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  // Early validation hint (no network): what would stop Run?
  let validation: string | null = null;
  if (!blocked) {
    if (videoLabel && !video)
      validation = `Add ${videoLabel.toLowerCase()} to start.`;
    else if (audioLabel && !audio)
      validation = `Add ${audioLabel.toLowerCase()} to start.`;
    else if (missingImages)
      validation = `Add ${(refLabels[images.findIndex((i) => !i)] ?? "an image").toLowerCase()} to start.`;
    else if (tool?.needsMask && !mask)
      validation = tool.maskHint ?? "Paint the area to change.";
    else if (requiresText && !settings.text.trim() && !scenePrompts)
      validation = "Add a prompt.";
    else if (needsConsent && !consented)
      validation = "Confirm the likeness consent statement to run.";
    else if (spec && video && pickIssue(spec, settings, video))
      validation = pickIssue(spec, settings, video);
    else if (spec && !tool && spec.id !== "describe") {
      try {
        buildActionRequest(
          spec,
          scenePrompts ? { ...settings, text: scenePrompts[0] } : settings,
          editLoras,
          spec.secondImage ? "x" : undefined,
          audioLabel
            ? { ref: "x", ...(audio?.duration ? { seconds: audio.duration } : {}) }
            : undefined,
        );
      } catch (e) {
        if (e instanceof ToolInputError) validation = e.message;
      }
    }
  }

  const primary = images[0];

  return (
    <RunnerStudio
      testId="tool-runner"
      header={
        <>
        <RunnerHeader
          title={card.title}
          subtitle={card.subtitle}
          model={modelLine(tool ? tool.baseLabel : (model ?? null))}
          onBack={onBack}
        />

        {h3 && <H3Attribution />}

        {blocked && (
          <RunnerNotice
            checking={blockChecking}
            reason={blockReason}
            model={blockModel}
          />
        )}
        {blocked &&
          !blockChecking &&
          spec &&
          isSa3Tool(spec.id) &&
          sa3PackFixes(blockReason) && <Sa3PackHint />}
        </>
      }
      controls={
        <>

        <section className="space-y-4">
          {videoLabel && (
            <ToolVideoInput
              label={videoLabel}
              note={spec?.videoNote}
              value={video}
              onChange={(v) => {
                setVideo(v);
                setQueued(false);
                if (smartTrackOn) patch({ smartTrack: undefined });
                if (perRefTrack) patch({ smartTrackSubjects: undefined });
                if (spec?.id === "rack_focus") patch({ focusPoints: undefined });
              }}
            />
          )}
          {!tool && spec?.id === "rack_focus" && video && (
            <FocusPointPicker
              key={video.id}
              mode="video"
              src={video.previewUrl}
              maxSeconds={videoWindowSeconds(spec.videoWindow, video.fps ?? 0) ?? undefined}
              value={settings.focusPoints ?? []}
              onChange={(next) =>
                patch({ focusPoints: next.length ? next : undefined })
              }
            />
          )}
          {smartTrackOn && video && spec && (
            <VideoMaskPicker
              video={video}
              maxSeconds={SMART_TRACK_WINDOW_SECONDS[spec.id] ?? 3}
              value={settings.smartTrack ?? []}
              onChange={(next) =>
                patch({ smartTrack: next.length ? next : undefined })
              }
            />
          )}
          {perRefTrack && video && spec && (
            <div className="space-y-1.5">
              <div
                className="flex gap-1.5"
                role="radiogroup"
                aria-label="Clicks for person"
              >
                {images.map((_, k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={trackSubject === k}
                    onClick={() => setTrackSubject(k)}
                    className={`rounded-lg border px-2 py-1 text-[11px] ${
                      trackSubject === k
                        ? "border-splash bg-splash/10 text-splash"
                        : "border-light-100 text-light-500 dark:border-dark-750 dark:text-dark-400"
                    }`}
                  >
                    Person {k + 1}
                    {settings.smartTrackSubjects?.[k]?.length ? " ✓" : ""}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-light-500 dark:text-dark-400">
                Optional: click the person that Character {trackSubject + 1}{" "}
                replaces. People without clicks are matched automatically.
              </p>
              <VideoMaskPicker
                key={`subject-${trackSubject}`}
                video={video}
                maxSeconds={SMART_TRACK_WINDOW_SECONDS[spec.id] ?? 3}
                value={settings.smartTrackSubjects?.[trackSubject] ?? []}
                onChange={(next) => setSubjectClicks(trackSubject, next)}
              />
            </div>
          )}
          {spec?.id === "talking_avatar" && !images[0] && (
            <AvatarPresetPicker
              disabled={busy}
              onImage={(img) => setImage(0, img)}
              onScene={(scene) => {
                if (!settings.text.trim()) patch({ text: scene });
              }}
            />
          )}
          {graphInputs && (
            <UseGraphImageButton
              onImage={setGraphImage}
              onError={setError}
              disabled={busy}
            />
          )}
          {refCount > 0 && (
            <CharacterProfilePicker
              toolKey={card.key}
              disabled={busy}
              needsPixels={
                profileSlot > 0 ||
                spec?.special === "describe" ||
                Boolean(videoLabel)
              }
              onApply={applyProfile}
            />
          )}
          {images.map((img, i) => (
            <ToolImageInput
              key={i}
              label={refLabels[i] ?? `Image ${i + 1}`}
              value={img}
              onChange={(v) => setImage(i, v)}
              needsPixels={
                i > 0 || spec?.special === "describe" || Boolean(videoLabel)
              }
            />
          ))}
          {audioLabel && (
            <ToolAudioInput
              label={audioLabel}
              note={spec?.audioNote}
              value={audio}
              onChange={(a) => {
                setAudio(a);
                setQueued(false);
              }}
            />
          )}
        </section>

        {!tool && spec?.id === "refocus" && primary && (
          <FocusPointPicker
            key={primary.id}
            mode="image"
            src={primary.previewUrl}
            value={settings.focusPoints ?? []}
            onChange={(next) =>
              patch({ focusPoints: next.length ? next : undefined })
            }
          />
        )}

        {tool?.needsMask && primary && (
          <section className="space-y-1.5">
            {tool.maskHint && (
              <p className="text-[11px] text-light-500 dark:text-dark-400">
                {tool.maskHint}
              </p>
            )}
            <MaskPainter
              imageUrl={primary.previewUrl}
              onChange={setMask}
              initialMask={editorOrigin.editorMask}
            />
          </section>
        )}

        {regionMask && primary && (
          <section className="space-y-1.5" data-testid="region-mask">
            <p className="text-[11px] text-light-500 dark:text-dark-400">
              {regionMask.hint}
            </p>
            <MaskPainter
              imageUrl={primary.previewUrl}
              onChange={setMask}
              onSubjectsChange={setSubjectMasks}
              subjects={regionMask.subjects}
              initialMode="smart"
              initialMask={editorOrigin.editorMask}
            />
          </section>
        )}

        {showText && (
          <section className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="tool-text"
                className="text-xs font-medium text-light-primary dark:text-dark-primary"
              >
                {textLabel}
                {sceneMark("text")}
              </label>
              {canCaption && (
                <button
                  type="button"
                  onClick={captionInput}
                  disabled={!images[0] || captioning}
                  title="Caption the input image locally and use it as the prompt"
                  className="inline-flex items-center gap-1 text-[11px] text-light-500 hover:text-light-primary disabled:opacity-40 dark:text-dark-400 dark:hover:text-dark-primary"
                >
                  {captioning && <Loader2 className="h-3 w-3 animate-spin" />}
                  Describe input
                </button>
              )}
            </div>
            {!tool && spec?.text?.compact ? (
              <input
                id="tool-text"
                type="text"
                maxLength={2000}
                className={`${field} font-mono text-xs`}
                placeholder={textPlaceholder}
                value={settings.text}
                onChange={(e) => patch({ text: e.target.value })}
              />
            ) : (
              <textarea
                id="tool-text"
                rows={3}
                maxLength={2000}
                className={`${field} resize-y`}
                placeholder={textPlaceholder}
                value={settings.text}
                onChange={(e) => patch({ text: e.target.value })}
              />
            )}
            {!tool && spec?.text?.hint && (
              <p className="text-[11px] text-light-500 dark:text-dark-400">
                {spec.text.hint}
              </p>
            )}
            {!tool && spec?.secondText && secondTextVisible(spec, settings) && (
              <>
                <label
                  htmlFor="tool-text-2"
                  className="block pt-2 text-xs font-medium text-light-primary dark:text-dark-primary"
                >
                  {spec.secondText.label}
                  {spec.secondText.required ? "" : " (optional)"}
                </label>
                {spec.secondText.compact ? (
                  <input
                    id="tool-text-2"
                    type="text"
                    maxLength={200}
                    className={field}
                    placeholder={spec.secondText.placeholder}
                    value={settings.secondText ?? ""}
                    onChange={(e) => patch({ secondText: e.target.value })}
                  />
                ) : (
                  <textarea
                    id="tool-text-2"
                    rows={5}
                    maxLength={4000}
                    className={`${field} resize-y font-mono text-xs`}
                    placeholder={spec.secondText.placeholder}
                    value={settings.secondText ?? ""}
                    onChange={(e) => patch({ secondText: e.target.value })}
                  />
                )}
                {spec.secondText.hint && (
                  <p className="text-[11px] text-light-500 dark:text-dark-400">
                    {spec.secondText.hint}
                  </p>
                )}
              </>
            )}
            {catalogPreview && (
              <p className="text-[11px] text-light-500 dark:text-dark-400">
                Sends: <span className="font-mono">{catalogPreview}</span>
              </p>
            )}
          </section>
        )}

        {spec?.id === "h3_charsheet" && (
          <CharSheetViews
            value={settings.picks.views}
            onChange={(csv) => setPick("views", csv)}
            width={charSheetSize(settings.picks.size).width}
            height={charSheetSize(settings.picks.size).height}
          />
        )}

        {/* Action pickers (speed, mode, motion) */}
        {spec?.pickers
          ?.filter((p) => pickerVisible(p, spec, settings))
          .map((p) => {
            const options = pickerOptionsFor(p, video);
            if (isPresetPicker({ key: p.key, options }))
              return (
                <PresetGrid
                  key={p.key}
                  label={p.title}
                  pickerKey={`${spec.id}:${p.key}`}
                  value={pickValue(p, settings)}
                  options={options}
                  onChange={(id) => setPick(p.key, id)}
                  thumb={
                    spec.id === "video_palette" && p.key === "preset"
                      ? paletteThumb
                      : undefined
                  }
                />
              );
            return p.dropdown ? (
              <ChoicePicker
                key={p.key}
                label={p.title}
                value={pickValue(p, settings)}
                options={options}
                onChange={(id) => setPick(p.key, id)}
              />
            ) : (
              <Segmented
                key={p.key}
                label={p.title}
                value={pickValue(p, settings)}
                options={options}
                onChange={(id) => setPick(p.key, id)}
                hint={p.hint}
                labelExtra={sceneMark(`picks.${p.key}`)}
              />
            );
          })}

        {!tool && spec?.id === "upscale" && (
          <UpscaleModelPicker
            value={settings.picks.upscale_model}
            onChange={(m) => setPick("upscale_model", m)}
            mode={pickValue(spec.pickers![0], settings)}
          />
        )}
        {!tool &&
          spec?.id === "upscale_video" &&
          pickValue(spec.pickers![0], settings) === "fast" && (
            <UpscaleModelPicker
              value={settings.picks.upscale_model}
              onChange={(m) => setPick("upscale_model", m)}
              mode={VIDEO_UPSCALE_ACTION}
              content="video"
            />
          )}

        {/* Action sliders (grade strength); advanced ones collapse */}
        {(() => {
          const visible =
            spec?.sliders?.filter((sl) => sliderVisible(sl, spec, settings)) ??
            [];
          const render = (sl: (typeof visible)[number]) => {
            const v = sliderValue(sl, settings);
            const hint = sl.hintFor?.(v, settings) ?? sl.hint;
            return (
              <label key={sl.key} className="block space-y-1.5 text-xs">
                <span className="font-medium text-light-primary dark:text-dark-primary">
                  {sl.title}: {v}
                  {sl.unit ?? ""}
                </span>
                <input
                  type="range"
                  className="w-full accent-[var(--accent-primary)]"
                  min={sl.min}
                  max={sl.max}
                  step={sl.step}
                  value={v}
                  onChange={(e) => setPick(sl.key, e.target.value)}
                />
                {hint && (
                  <span className="block text-[11px] text-light-500 dark:text-dark-400">
                    {hint}
                  </span>
                )}
              </label>
            );
          };
          const advanced = visible.filter((sl) => sl.advanced);
          return (
            <>
              {visible.filter((sl) => !sl.advanced).map(render)}
              {advanced.length > 0 && (
                <details className={ADVANCED_DETAILS}>
                  <AdvancedSummary />
                  <div className="mt-3 space-y-3">{advanced.map(render)}</div>
                </details>
              )}
            </>
          );
        })()}

        {!tool && spec?.seedInput && (
          <label className="block space-y-1 text-xs" title={SEED_HINT}>
            <span className="font-medium text-light-primary dark:text-dark-primary">
              Seed
              {sceneMark("seed")}
            </span>
            <input
              type="number"
              className={field}
              min={0}
              max={2147483647}
              placeholder="random"
              value={settings.seed ?? ""}
              onChange={(e) =>
                patch({
                  seed:
                    e.target.value === ""
                      ? undefined
                      : Math.trunc(Number(e.target.value)),
                })
              }
            />
          </label>
        )}

        {spec && LTX_EXTRA_LORA_TOOLS.has(spec.id) && (
          <LtxLoraControls
            toolId={spec.id}
            picks={settings.picks}
            setPick={setPick}
            disabled={busy}
          />
        )}

        {spec && isSa3Tool(spec.id) && (
          <Sa3AudioControls
            toolId={spec.id}
            picks={settings.picks}
            setPick={setPick}
            audio={audio}
            disabled={busy}
          />
        )}

        {!tool &&
          spec?.id === "video_palette" &&
          (() => {
            const sw = previewSwatches(
              settings.picks.source ?? "preset",
              settings.picks.preset ?? "",
              settings.text,
            );
            return sw.length > 0 ? (
              <div
                className="flex h-6 overflow-hidden rounded-md ring-1 ring-black/10"
                aria-label="Palette preview"
              >
                {sw.map((c, i) => (
                  <span
                    key={`${c.hex}-${i}`}
                    title={c.hex}
                    style={{ backgroundColor: c.hex, flexGrow: c.weight }}
                  />
                ))}
              </div>
            ) : null;
          })()}

        {!tool &&
          spec?.id === "wan_move" &&
          settings.picks.source === "draw" &&
          primary && (
            <section className="space-y-1.5">
              <p className="text-xs font-medium text-light-primary dark:text-dark-primary">
                Draw the motion
              </p>
              <MotionPathPainter
                imageUrl={primary.previewUrl}
                onChange={setWanMoveDraw}
              />
            </section>
          )}

        {showCinema && (
          <section className="space-y-1.5">
            <CinemaStudio
              toolId={spec?.id}
              value={cinema}
              onChange={setCinema}
              scene={scene}
              onSceneChange={setScene}
              onSceneProfile={applySceneProfile}
              sceneImage={refCount > 0 ? images[0] : null}
              onUseSceneImage={
                refCount > 0
                  ? (img) =>
                      resolveProfileRef(img, Boolean(videoLabel))
                        .then((full) => setImage(0, full))
                        .catch(() =>
                          setError("Couldn't load that location image."),
                        )
                  : undefined
              }
            />
            {sceneRunIds && <SceneStitchBar runIds={sceneRunIds} />}
            {scenePrompts ? (
              <ol
                className="list-decimal space-y-0.5 pl-5 text-[11px] text-light-500 dark:text-dark-400"
                aria-label="Scene shots sent"
              >
                {scenePrompts.map((p, i) => (
                  <li key={i}>
                    <span className="font-mono">{p}</span>
                  </li>
                ))}
              </ol>
            ) : (
              cinemaSuffix && (
                <p className="text-[11px] text-light-500 dark:text-dark-400">
                  Sends: <span className="font-mono">{sendSettings.text}</span>
                </p>
              )
            )}
          </section>
        )}

        {/* Edit LoRA choice (Edit photo picks family + LoRA) */}
        {spec?.usesEditLora && (
          <section className="space-y-3">
            {spec.picksEditFamily && families.length > 0 && (
              <Segmented
                label="Edit model family"
                value={activeFamily}
                options={families}
                onChange={(id) =>
                  patch({ editFamily: id, editLoraId: undefined })
                }
              />
            )}
            {(() => {
              const famId = spec.picksEditFamily ? activeFamily : "krea2edit";
              const list = editLorasIn(editLoras, famId);
              if (list.length < 2) {
                return lora ? (
                  <p className="text-[11px] text-light-500 dark:text-dark-400">
                    Edit LoRA: {lora.name}
                  </p>
                ) : null;
              }
              return (
                <div className="space-y-1.5">
                  <label
                    htmlFor="tool-lora"
                    className="text-xs font-medium text-light-primary dark:text-dark-primary"
                  >
                    Edit LoRA
                  </label>
                  <select
                    id="tool-lora"
                    className={field}
                    value={lora?.id ?? ""}
                    onChange={(e) => patch({ editLoraId: e.target.value })}
                  >
                    {list.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })()}
          </section>
        )}

        {/* Catalog enum options (camera angles ...) */}
        {tool && tool.options.length > 0 && (
          <section className="grid gap-3 sm:grid-cols-3">
            {tool.options.map((opt) => (
              <div key={opt.id} className="space-y-1.5">
                <label
                  htmlFor={`opt-${opt.id}`}
                  className="text-xs font-medium text-light-primary dark:text-dark-primary"
                >
                  {opt.label}
                </label>
                <select
                  id={`opt-${opt.id}`}
                  className={field}
                  value={settings.picks[opt.id] ?? opt.default}
                  onChange={(e) => setPick(opt.id, e.target.value)}
                >
                  {opt.values.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </section>
        )}

        {/* Outpaint */}
        {tool?.outpaint && (
          <section className="space-y-3" aria-label="Expand canvas">
            <Segmented
              label="Expand by"
              value={settings.outpaintMode}
              options={[
                { id: "sides", label: "Direction + amount" },
                { id: "aspect", label: "Aspect ratio" },
              ]}
              onChange={(id) =>
                patch({ outpaintMode: id as ToolSettings["outpaintMode"] })
              }
            />
            <div className="flex flex-wrap gap-2" aria-label="Quick presets">
              {OUTPAINT_ZOOM_PRESETS.map((z) => (
                <button
                  key={z.id}
                  type="button"
                  data-testid={`outpaint-${z.id}`}
                  onClick={() => patch(zoomPresetSettings(z.amount))}
                  className="rounded-full border border-light-100 px-3 py-1 text-xs font-medium text-light-primary hover:border-splash dark:border-dark-750 dark:text-dark-primary"
                >
                  {z.label}
                </button>
              ))}
            </div>
            {settings.outpaintMode === "sides" ? (
              <>
                <Segmented
                  label="Direction"
                  value={settings.outpaintDirection}
                  options={OUTPAINT_DIRECTIONS}
                  onChange={(id) =>
                    patch({ outpaintDirection: id as OutpaintDirection })
                  }
                />
                <label className="block space-y-1.5 text-xs">
                  <span className="font-medium text-light-primary dark:text-dark-primary">
                    Amount per side: {Math.round(settings.outpaintAmount * 100)}
                    %
                  </span>
                  <input
                    type="range"
                    className="w-full accent-[var(--accent-primary)]"
                    min={5}
                    max={Math.round(tool.outpaint.maxSide * 100)}
                    step={5}
                    value={Math.round(settings.outpaintAmount * 100)}
                    onChange={(e) =>
                      patch({ outpaintAmount: Number(e.target.value) / 100 })
                    }
                  />
                </label>
              </>
            ) : (
              <>
                <Segmented
                  label="Aspect ratio"
                  labelExtra={sceneMark("outpaintAspect")}
                  value={settings.outpaintAspect}
                  options={OUTPAINT_ASPECTS.map((a) => ({ id: a, label: a }))}
                  onChange={(id) => patch({ outpaintAspect: id })}
                />
                <Segmented
                  label="Keep image at"
                  value={settings.outpaintAnchor}
                  options={OUTPAINT_ANCHORS.map((a) => ({
                    id: a,
                    label: a[0].toUpperCase() + a.slice(1),
                  }))}
                  onChange={(id) =>
                    patch({ outpaintAnchor: id as OutpaintAnchor })
                  }
                />
              </>
            )}
            <p className="text-[11px] text-light-500 dark:text-dark-400">
              The canvas is padded with gray (#808080) on the server and capped
              at 2048 × 2048.
            </p>
          </section>
        )}

        {/* Keep framing + fast toggles */}
        {tool && (tool.extras.keepFraming || tool.speed.supported) && (
          <section className="space-y-3">
            {tool.extras.keepFraming && (
              <Toggle
                label={tool.extras.keepFraming.label}
                hint={
                  tool.extras.keepFraming.available
                    ? tool.extras.keepFraming.description
                    : "Consistency LoRA not installed on this server."
                }
                checked={settings.keepFraming}
                disabled={!tool.extras.keepFraming.available}
                onChange={(v) => patch({ keepFraming: v })}
              />
            )}
            {tool.speed.supported && (
              <Toggle
                label="Fast"
                hint={
                  tool.speed.available
                    ? `${tool.speed.label ?? "Lightning"} LoRA, ${tool.speed.steps} steps, CFG ${tool.speed.cfg}.`
                    : `${tool.speed.label ?? "Lightning"} LoRA not installed on this server.`
                }
                checked={settings.fast}
                disabled={!tool.speed.available}
                onChange={(v) => patch({ fast: v })}
              />
            )}
          </section>
        )}

        {/* Advanced: blank fields keep the tool's tuned defaults */}
        {tool && (
          <details className={ADVANCED_DETAILS}>
            <AdvancedSummary />
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {(
                [
                  ["steps", "Steps", STEPS_HINT, tool.defaults.steps, 1, 100, 1],
                  ["cfg", "Prompt strength (CFG)", CFG_HINT, tool.defaults.cfg, 0, 20, 0.1],
                ] as const
              ).map(([key, label, hint, def, min, max, step]) => (
                <label key={key} className="space-y-1" title={hint}>
                  <span className="text-light-500 dark:text-dark-400">
                    {label}
                  </span>
                  <input
                    type="number"
                    className={field}
                    min={min}
                    max={max}
                    step={step}
                    placeholder={String(def)}
                    value={settings[key] ?? ""}
                    onChange={(e) =>
                      patch({
                        [key]:
                          e.target.value === ""
                            ? undefined
                            : Number(e.target.value),
                      })
                    }
                  />
                </label>
              ))}
              <label className="space-y-1" title={SEED_HINT}>
                <span className="text-light-500 dark:text-dark-400">
                  Seed
                  {sceneMark("seed")}
                </span>
                <input
                  type="number"
                  className={field}
                  min={0}
                  max={2147483647}
                  placeholder="random"
                  value={settings.seed ?? ""}
                  onChange={(e) =>
                    patch({
                      seed:
                        e.target.value === ""
                          ? undefined
                          : Math.trunc(Number(e.target.value)),
                    })
                  }
                />
              </label>
            </div>
          </details>
        )}

        {licenseNote && (
          <p
            className="text-[11px] text-light-500 dark:text-dark-400"
            data-testid="tool-license"
          >
            {licenseNote}
            {licenseLinks.map((l) => (
              <a
                key={l.url}
                href={l.url!}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-1.5 underline decoration-dotted underline-offset-2 hover:text-splash"
              >
                {l.license}
              </a>
            ))}
          </p>
        )}

        {needsConsent && (
          <LikenessConsent checked={consented} onChange={setConsented} />
        )}

        {/* Generate */}
        <div className="space-y-2" data-testid="runner-generate">
          {/* SDR to HDR writes its own EXR master; the global one would not apply. */}
          {!compareStage && !spec?.ownMaster && <OutputFormatPicker />}
          {upAfterMedia && upAfter && upAfterDefault && (
            <UpscaleAfterToggle
              media={upAfterMedia}
              value={upAfter}
              onChange={setUpAfterOverride}
              overridden={
                upAfter.on !== upAfterDefault.on ||
                (upAfter.on && upAfter.factor !== upAfterDefault.factor)
              }
              onReset={() => setUpAfterOverride(null)}
              disabled={busy}
            />
          )}
          <button
            type="button"
            onClick={run}
            disabled={busy || blocked || validation !== null}
            aria-busy={busy}
            className={RUN_BUTTON_FOOTER}
          >
            {busy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {busy
              ? "Starting…"
              : spec?.special === "describe"
                ? "Describe"
                : "Generate"}
          </button>
          <RunHint
            output={outputForCategory(hubCard?.hubCategory, card.category)}
            fast={settings.fast || picksAreFast(settings.picks)}
          />
          {overlay && tool && (
            <SendToGraphButton
              title={card.title}
              disabled={busy || blocked || validation !== null}
              build={async () =>
                (
                  await exportCatalogToolWorkflow({
                    fetchImpl: fetch,
                    tool,
                    settings,
                    images,
                    mask,
                    clientId,
                  })
                ).workflow
              }
            />
          )}
          {/* Dry run: the exact graph Run would queue (image action + catalog tools). */}
          {(tool ||
            (spec &&
              !spec.noSourceInput &&
              !videoLabel &&
              spec.special !== "describe")) && (
            <ShowGraphButton
              title={card.title}
              disabled={
                busy ||
                blocked ||
                validation !== null ||
                (needsConsent && !consented)
              }
              build={async () =>
                (tool
                  ? await exportCatalogToolWorkflow({
                      fetchImpl: fetch,
                      tool,
                      settings,
                      images,
                      mask,
                      clientId,
                    })
                  : await exportActionToolWorkflow({
                      fetchImpl: fetch,
                      spec: spec as ActionToolSpec,
                      settings: sendSettings,
                      editLoras,
                      image: images[0],
                      secondImage: images[1] ?? null,
                      extraImages: images.slice(2),
                      audio,
                      clientId,
                      ...(regionMask ? { subjectMasks, mask } : {}),
                    })
                ).workflow
              }
            />
          )}
          {blocked && !blockChecking && !busy ? (
            <p className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
              {setupHint(blockReason, blockModel)} to run this.
            </p>
          ) : (
            validation &&
            !busy && (
              <p className="text-[11px] text-light-500 dark:text-dark-400">
                {validation}
              </p>
            )
          )}
          {error && <RunError message={error} />}
          {editorOrigin.fromEditor && <EditorReturnNote />}
          {editorOrigin.fromVideoEditor && <EditorReturnNote video />}
          {failure && !busy && (
            <RunFailureNotice
              failure={failure}
              card={card}
              onRetry={blocked ? undefined : run}
            />
          )}
          {queued && (
            <p className="text-xs text-light-500 dark:text-dark-400">
              Queued.{" "}
              <button
                type="button"
                className="text-splash underline"
                onClick={() => setActiveNav("create")}
              >
                Open Create
              </button>{" "}
              to watch progress.
            </p>
          )}
        </div>
        </>
      }
      stage={
        <RunnerStage
          runs={recentRuns}
          failureCard={card}
          onRetry={blocked || busy ? undefined : run}
          renderResult={
            compareStage
              ? (r, fallback) => (
                  <HdrCompareResult run={r} fallback={fallback} />
                )
              : undefined
          }
          extra={
            suggestions.length > 0 ? (
            <ul className="space-y-2" aria-label="Prompt suggestions">
              {suggestions.map((s) => (
                <li
                  key={s}
                  className="rounded-xl border border-light-100 dark:border-dark-750 bg-light-input dark:bg-dark-input p-3 text-xs"
                >
                  <p className="text-light-primary dark:text-dark-primary">
                    {s}
                  </p>
                  <button
                    type="button"
                    className="mt-2 text-splash underline"
                    onClick={() => {
                      setPromptValue(s);
                      setActiveNav("create");
                    }}
                  >
                    Use in Create
                  </button>
                </li>
              ))}
            </ul>
            ) : null
          }
        />
      }
    />
  );
}
