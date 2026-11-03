"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { shallow } from "zustand/shallow";
import {
  RotateCcw,
  Dices,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Search,
  X,
} from "lucide-react";
import {
  type ControlSchema,
  validateModelChoice,
  getModelOptionsForControl,
  getModelCategoryLabel,
  validateAllControlsExtended,
  computeGroupedOverrideSummary,
  computeGroupedInvalidSummary,
  collectInvalidOverrideKeys,
  type LocalInventory,
} from "@/lib/oj/workflowControlSchema";
import {
  useWorkflowControlStore,
  packSelectionKey,
  computeEffectiveControls,
  getEditableControls,
  computeDependentKeys,
  buildComparisonEntries,
  matchSmartDefaults,
  type BatchOverride,
} from "@/store/workflowControlStore";
import type { WorkflowType } from "@/lib/oj/workflow-analysis";
import {
  useModelStore,
  selectAvailableAnimatediffModels,
  selectAvailableCheckpoints,
  selectAvailableClip,
  selectAvailableControlnet,
  selectAvailableDiffusers,
  selectAvailableEmbeddings,
  selectAvailableEnumOptions,
  selectAvailableGligen,
  selectAvailableHypernetworks,
  selectAvailableInputAudios,
  selectAvailableInputImages,
  selectAvailableInputVideos,
  selectAvailableIpadapter,
  selectAvailableLoras,
  selectAvailableSamplers,
  selectAvailableSchedulers,
  selectAvailableStyleModels,
  selectAvailableUnet,
  selectAvailableUpscaleModels,
  selectAvailableVaes,
  selectAvailableVideoModels,
} from "@/store/modelStore";
import { useUIStore } from "@/store";
import { mergeScopedOverrides } from "@/lib/workflowControlScope";
import type { GalleryImage } from "@/types";
import { roundNumeric, MAX_RANDOM_SEED } from "@/lib/oj/inputSpec";
import { stabilizeEffectiveControls } from "@/components/workflowControls/stableControls";
import {
  useSpecControls,
  useAfterGenerate,
  buildSubmitOverrides,
  ControlHelpText,
  ControlModeSelect,
  UploadButton,
  RemoteEnumEditor,
} from "@/components/workflowControls/specControls";
import {
  isPromptLike,
  buildInventoryFromModelStore,
  KIND_DOT_COLORS,
} from "@/components/workflowControls/panelHelpers";
import {
  PanelInfoHeader,
  PanelSummaryHeader,
  PanelToolbar,
  BatchModeSection,
  useStableList,
  sameControlMeta,
} from "@/components/workflowControls/PanelSections";
import { ModelSelector } from "@/components/workflowControls/ModelSelector";
import { ImageControl, FileControl } from "@/components/workflowControls/MediaControls";
import {
  ControlDocTooltip,
  DependencyBadge,
  BatchChips,
  ComparisonView,
  SmartDefaultsBar,
} from "@/components/workflowControls/PanelBits";
import { EnumEditor, NumberEditor } from "@/components/workflowControls/ScalarEditors";


const PULSE_ANIMATION_STYLE = `
@keyframes cj-dep-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(251, 191, 36, 0); }
  50% { box-shadow: 0 0 0 3px rgba(251, 191, 36, 0.15); }
}
.cj-dep-pulse {
  animation: cj-dep-pulse 2s ease-in-out 3;
}
`;

const EMPTY_OVERRIDES: Record<string, unknown> = {};
// Stable fallback: a fresh `[]` from the selector re-renders the whole panel
// on every store update while no batch values exist.
const EMPTY_BATCH: BatchOverride[] = [];

// Search/filter threshold — show search bar when this many controls exist
const SEARCH_THRESHOLD = 8;


// Individual control editor (scalar controls)

interface ControlEditorProps {
  control: ControlSchema & { effectiveValue: unknown; isOverridden: boolean };
  onSetOverride: (key: string, value: unknown) => void;
  onResetOverride: (key: string) => void;
  modelInventory: LocalInventory;
  /** Whether this control is flagged as potentially needing update */
  isDependencyDirty?: boolean;
  /** Callback to dismiss the dependency dirty flag */
  onClearDependencyDirty?: (key: string) => void;
  /** Batch values for this control, if in batch mode */
  batchValues?: unknown[];
  /** Callback to remove a batch value by index */
  onRemoveBatchValue?: (key: string, index: number) => void;
  /** Override selection key (for per-control control_after_generate modes) */
  selectionKey?: string;
}

function ControlEditor({
  control,
  selectionKey,
  onSetOverride,
  onResetOverride,
  modelInventory,
  isDependencyDirty,
  onClearDependencyDirty,
  batchValues,
  onRemoveBatchValue,
}: ControlEditorProps) {
  const {
    key,
    kind,
    label,
    effectiveValue,
    isOverridden,
    min,
    max,
    step,
    options,
  } = control;

  // Honor object_info round/step (INT snaps to step from min; FLOAT to
  // `round`, defaulting to step) once a spec is known.
  const specType = control.specType;
  const specRound = control.round;
  const handleNumberChange = useCallback(
    (v: number) =>
      onSetOverride(
        key,
        specType === "INT" || specType === "FLOAT"
          ? roundNumeric(v, { type: specType, min, max, step, round: specRound })
          : v,
      ),
    [key, onSetOverride, specType, specRound, min, max, step],
  );

  const handleStringChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onSetOverride(key, e.target.value),
    [key, onSetOverride],
  );

  const handleBooleanChange = useCallback(
    () => onSetOverride(key, !effectiveValue),
    [key, effectiveValue, onSetOverride],
  );

  const handleReset = useCallback(
    () => onResetOverride(key),
    [key, onResetOverride],
  );

  const handleRandomize = useCallback(() => {
    const lo = typeof min === "number" ? min : 0;
    const maxVal = Math.min(
      typeof max === "number" ? max : 0xffffffff,
      MAX_RANDOM_SEED,
    );
    const newSeed = lo + Math.floor(Math.random() * (maxVal - lo + 1));
    onSetOverride(key, newSeed);
  }, [key, min, max, onSetOverride]);

  const dotColor = KIND_DOT_COLORS[kind] ?? "bg-light-400 dark:bg-dark-500";

  // Model controls: delegate to ModelSelector with validation. Hooks stay above
  // early returns so this component keeps stable hook order if a control kind
  // changes while React reuses the component instance.
  if (kind === "model" && control.modelCategory) {
    const validation = validateModelChoice(control, modelInventory);
    const modelOptions = getModelOptionsForControl(control, modelInventory);
    const categoryLabel = getModelCategoryLabel(control.modelCategory);

    return (
      <ModelSelector
        control={control}
        options={modelOptions}
        isValid={validation.isValid}
        hasInventory={validation.hasInventory}
        currentValue={String(effectiveValue ?? "")}
        isOverridden={isOverridden}
        onSetOverride={onSetOverride}
        onResetOverride={onResetOverride}
        categoryLabel={categoryLabel}
      />
    );
  }

  if (kind === "image") {
    return (
      <div>
        <ImageControl
          control={control}
          onSetOverride={onSetOverride}
          onResetOverride={onResetOverride}
          localInventory={modelInventory}
        />
        {control.upload && (
          <div className="pl-[7.5rem] -mt-1 pb-1">
            <UploadButton
              control={control}
              onUploaded={(ref) => onSetOverride(key, ref)}
            />
            <ControlHelpText control={control} />
          </div>
        )}
      </div>
    );
  }

  if (kind === "file") {
    return (
      <div>
        <FileControl
          control={control}
          onSetOverride={onSetOverride}
          onResetOverride={onResetOverride}
          localInventory={modelInventory}
        />
        {control.upload && (
          <div className="pl-[7.5rem] -mt-1 pb-1">
            <UploadButton
              control={control}
              onUploaded={(ref) => onSetOverride(key, ref)}
            />
          </div>
        )}
      </div>
    );
  }

  const defaultStr =
    control.defaultValue !== null && control.defaultValue !== undefined
      ? String(control.defaultValue)
      : null;

  return (
    <div
      className={`flex items-start gap-2 py-1.5 group/edit ${isOverridden ? "border-l-2 border-splash/40 pl-1.5 -ml-2" : ""} ${isDependencyDirty ? "cj-dep-pulse rounded" : ""}`}
    >
      {/* Override indicator dot + label + tooltip */}
      <div className="w-28 shrink-0 flex items-center gap-1 pt-1">
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${dotColor}`}
        />
        <span className="text-[11px] font-medium text-light-600 dark:text-dark-300 truncate">
          {label}
        </span>
        <ControlDocTooltip control={control} />
        {isOverridden && (
          <button
            onClick={handleReset}
            className="transition-opacity text-splash/60 hover:text-splash shrink-0"
            title={`Reset to default${defaultStr !== null ? `: ${defaultStr}` : ""}`}
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        )}
        {isDependencyDirty && onClearDependencyDirty && (
          <DependencyBadge
            onDismiss={() => onClearDependencyDirty(control.key)}
          />
        )}
      </div>

      <div className="flex-1 min-w-0">
        {kind === "number" && (
          <NumberEditor
            value={effectiveValue as number}
            min={min}
            max={max}
            step={step}
            inputKey={key}
            label={label}
            isOverridden={isOverridden}
            defaultValue={control.defaultValue as number | undefined}
            onChange={handleNumberChange}
            onReset={handleReset}
          />
        )}

        {kind === "seed" && (
          <div className="flex items-center gap-1.5">
            <div className="flex-1">
              <NumberEditor
                value={effectiveValue as number}
                min={min ?? 0}
                max={max ?? 0xffffffff}
                step={1}
                inputKey={key}
                label={label}
                isOverridden={isOverridden}
                defaultValue={control.defaultValue as number | undefined}
                onChange={handleNumberChange}
                onReset={handleReset}
              />
            </div>
            <button
              onClick={handleRandomize}
              className="shrink-0 flex h-7 w-7 items-center justify-center rounded-lg border border-light-200 bg-light-50 text-violet-500 transition-colors hover:border-violet-400 hover:bg-violet-50 dark:border-dark-700 dark:bg-dark-900 dark:text-violet-400 dark:hover:border-violet-500 dark:hover:bg-violet-500/10"
              title="Randomize seed"
            >
              <Dices className="h-3.5 w-3.5" />
            </button>
            {control.controlAfterGenerate && selectionKey && (
              <ControlModeSelect
                selectionKey={selectionKey}
                controlKey={key}
              />
            )}
          </div>
        )}

        {kind === "string" &&
          (control.multiline || isPromptLike(control.inputKey) ? (
            <textarea
              value={effectiveValue as string}
              onChange={handleStringChange}
              rows={3}
              placeholder={
                isOverridden && defaultStr
                  ? `Default: ${defaultStr.slice(0, 60)}${defaultStr.length > 60 ? "…" : ""}`
                  : (control.placeholder ?? "Enter prompt…")
              }
              className={`w-full rounded-lg border bg-light-input px-2.5 py-1.5 text-xs text-light-primary dark:bg-dark-input dark:text-dark-primary outline-none transition-colors resize-y min-h-[60px] ${
                isOverridden
                  ? "border-splash/40 ring-1 ring-splash/20"
                  : "border-light-200 dark:border-dark-700 focus:border-splash/60"
              }`}
            />
          ) : (
            <input
              type="text"
              value={effectiveValue as string}
              onChange={handleStringChange}
              placeholder={
                isOverridden && defaultStr
                  ? `Default: ${defaultStr}`
                  : undefined
              }
              className={`w-full rounded-lg border bg-light-input px-2.5 py-1.5 text-xs text-light-primary dark:bg-dark-input dark:text-dark-primary outline-none transition-colors ${
                isOverridden
                  ? "border-splash/40 ring-1 ring-splash/20"
                  : "border-light-200 dark:border-dark-700 focus:border-splash/60"
              }`}
            />
          ))}

        {kind === "enum" && control.remote && (
          <RemoteEnumEditor
            control={control}
            value={String(effectiveValue ?? "")}
            onChange={(v) => onSetOverride(key, v)}
          />
        )}

        {/* Enum without known options (offline / unknown source): plain text */}
        {kind === "enum" && !control.remote && !options && (
          <input
            type="text"
            value={String(effectiveValue ?? "")}
            onChange={handleStringChange}
            className="w-full rounded-lg border border-light-200 bg-light-input px-2.5 py-1.5 text-xs text-light-primary dark:border-dark-700 dark:bg-dark-input dark:text-dark-primary outline-none"
          />
        )}

        {kind === "enum" && !control.remote && options && (
          <EnumEditor
            control={control}
            effectiveValue={effectiveValue as string}
            isOverridden={isOverridden}
            defaultStr={defaultStr}
            modelInventory={modelInventory}
            onSetOverride={onSetOverride}
          />
        )}

        {kind === "boolean" && (
          <div>
            <button
              onClick={handleBooleanChange}
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                effectiveValue
                  ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-600 dark:border-cyan-400/30 dark:bg-cyan-400/10 dark:text-cyan-300"
                  : "border-light-200 bg-light-50 text-light-500 dark:border-dark-700 dark:bg-dark-900 dark:text-dark-400"
              }`}
            >
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  effectiveValue
                    ? "bg-cyan-500 dark:bg-cyan-400"
                    : "bg-light-300 dark:bg-dark-600"
                }`}
              />
              {effectiveValue
                ? (control.labelOn ?? "On")
                : (control.labelOff ?? "Off")}
            </button>
            {isOverridden && defaultStr && (
              <p className="mt-0.5 text-[10px] text-dark-500/60">
                default: {defaultStr}
              </p>
            )}
          </div>
        )}

        <ControlHelpText control={control} />

        {batchValues && batchValues.length > 0 && onRemoveBatchValue && (
          <BatchChips
            values={batchValues}
            controlKey={control.key}
            onRemove={(index) => onRemoveBatchValue(control.key, index)}
          />
        )}
      </div>
    </div>
  );
}

// Editing one control re-renders only that row: the panel keeps unchanged
// control objects and handlers stable (see stabilizeEffectiveControls).
const MemoControlEditor = React.memo(ControlEditor);


// One collapsible node group. Memoized: the panel hands each group an
// identity-stable control list, so an override edit re-renders only the
// group that holds the edited control (and inside it only that editor).

type EffectiveControl = ReturnType<typeof computeEffectiveControls>[number];

interface ControlGroupSectionProps {
  group: string;
  controls: readonly EffectiveControl[];
  selectionKey: string;
  /** Search is active: groups force-expand and advanced inputs open. */
  searching: boolean;
  isCollapsed: boolean;
  invalidCount: number;
  overriddenInvalidCount: number;
  onToggleGroup: (group: string) => void;
  onResetGroup: (group: string) => void;
  onSetOverride: (key: string, value: unknown) => void;
  onResetOverride: (key: string) => void;
  modelInventory: LocalInventory;
  dependencyDirtyKeys: ReadonlySet<string> | undefined;
  onClearDependencyDirty: (key: string) => void;
  batchValueMap: ReadonlyMap<string, unknown[]>;
  onRemoveBatchValue: (key: string, index: number) => void;
}

function ControlGroupSectionImpl({
  group,
  controls: groupControls,
  selectionKey,
  searching,
  isCollapsed: collapsed,
  invalidCount,
  overriddenInvalidCount,
  onToggleGroup,
  onResetGroup,
  onSetOverride,
  onResetOverride,
  modelInventory,
  dependencyDirtyKeys,
  onClearDependencyDirty,
  batchValueMap,
  onRemoveBatchValue,
}: ControlGroupSectionProps) {
  const groupOverrideCount = groupControls.filter((c) => c.isOverridden).length;
  // Collapse state — ignored when search is active (always expand results)
  const isCollapsed = !searching && collapsed;
  // Node class types represented in this group (for type label hint)
  const classTypesInGroup = Array.from(
    new Set(groupControls.map((c) => c.classType)),
  );
  const classTypeHint =
    classTypesInGroup.length === 1 ? classTypesInGroup[0] : null;

  const renderCtrl = (ctrl: EffectiveControl) => (
    <MemoControlEditor
      key={ctrl.key}
      control={ctrl}
      selectionKey={selectionKey}
      onSetOverride={onSetOverride}
      onResetOverride={onResetOverride}
      modelInventory={modelInventory}
      isDependencyDirty={dependencyDirtyKeys?.has(ctrl.key) ?? false}
      onClearDependencyDirty={onClearDependencyDirty}
      batchValues={batchValueMap.get(ctrl.key)}
      onRemoveBatchValue={onRemoveBatchValue}
    />
  );
  // object_info `advanced: true` inputs collapse under a disclosure (opened
  // automatically while searching or when one is overridden).
  const basic = groupControls.filter((c) => !c.advanced);
  const advanced = groupControls.filter((c) => c.advanced);

  return (
    <div>
      {/* Group header — clickable to collapse */}
      <button
        type="button"
        onClick={() => onToggleGroup(group)}
        className="w-full flex items-center gap-1.5 mb-1.5 group/grphdr text-left"
      >
        {isCollapsed ? (
          <ChevronRight className="h-3 w-3 shrink-0 text-light-400/50 dark:text-dark-600/50 transition-transform" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0 text-light-400/50 dark:text-dark-600/50 transition-transform" />
        )}
        <p className="text-[10px] font-medium text-light-400/70 dark:text-dark-500/70 group-hover/grphdr:text-light-500 dark:group-hover/grphdr:text-dark-400 transition-colors">
          {group}
        </p>
        {/* Node class type hint — faint, shown when group maps to single node type */}
        {classTypeHint && !searching && (
          <span className="text-[9px] text-light-300/60 dark:text-dark-600/60 font-mono truncate max-w-[80px]">
            {classTypeHint}
          </span>
        )}
        {/* Collapsed count badge */}
        {isCollapsed && (
          <span className="text-[9px] text-light-400/50 dark:text-dark-600/50 ml-0.5">
            {groupControls.length}
          </span>
        )}
        <span className="flex items-center gap-1 ml-auto">
          {groupOverrideCount > 0 && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onResetGroup(group);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault(); // Space must not scroll/toggle the group
                  e.stopPropagation();
                  onResetGroup(group);
                }
              }}
              className="flex items-center gap-0.5 rounded border border-amber-500/20 bg-amber-500/5 px-1 py-0 text-[9px] text-amber-500 dark:text-amber-300 transition-colors hover:bg-amber-500/15 cursor-pointer"
              title={`Reset ${groupOverrideCount} override${groupOverrideCount !== 1 ? "s" : ""} in ${group}`}
            >
              <RotateCcw className="h-2.5 w-2.5" />
              {groupOverrideCount}
            </span>
          )}
          {invalidCount > 0 && (
            <span
              className="flex items-center gap-0.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-1 py-0 text-[9px] text-amber-600 dark:text-amber-300"
              title={`${invalidCount} invalid control${invalidCount !== 1 ? "s" : ""} in ${group}${overriddenInvalidCount > 0 ? ` — ${overriddenInvalidCount} overridden, can reset` : ""}`}
            >
              <AlertTriangle className="h-2.5 w-2.5" />
              {invalidCount}
            </span>
          )}
        </span>
      </button>

      {/* Controls — hidden when collapsed */}
      {!isCollapsed && (
        <div className="space-y-0.5 pl-4">
          {basic.map(renderCtrl)}
          {advanced.length > 0 && (
            <details
              className="group/adv"
              open={
                searching || advanced.some((c) => c.isOverridden) || undefined
              }
            >
              <summary className="cursor-pointer select-none py-1 text-[10px] font-medium text-light-500 dark:text-dark-400">
                Advanced ({advanced.length})
              </summary>
              {advanced.map(renderCtrl)}
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export const ControlGroupSection = React.memo(ControlGroupSectionImpl);

// Main WorkflowControlPanel

interface WorkflowControlPanelProps {
  controls: ControlSchema[];
  /** The pack ID for override keying */
  packId: string;
  /** The workflow kind for override keying (e.g. "t2i") */
  workflowKind: string;
  /**
   * The graph these controls were read from (path under public/workflows,
   * e.g. "packs/flux/t2i.json"). Overrides only ever apply to this graph.
   * Without it the panel edits locally but never touches submits.
   */
  graphPath?: string;
  className?: string;
  /** Optional workflow display name for the info header */
  workflowName?: string;
  /** Total node count in the workflow (for info header) */
  nodeCount?: number;
  /** Number of missing custom nodes / unresolved class_types */
  missingNodesCount?: number;
  /** Detected base model architecture (e.g. "Flux", "SDXL") */
  detectedBaseModel?: string;
  /** Detected workflow type for smart defaults (e.g. "t2i", "upscale") */
  workflowType?: WorkflowType;
  /**
   * Gallery image whose settings should be loaded via "Use These Settings".
   * When provided, shows a quick-apply button. Parent clears after applying.
   */
  galleryImageToApply?: GalleryImage | null;
  /** Callback when gallery settings have been applied */
  onGallerySettingsApplied?: () => void;
}

/**
 * A compact control panel that renders workflow controls with
 * editable inputs. Overrides are persisted per-workflow and can be
 * reset individually or entirely.
 *
 * Features: model selectors, image/file pickers, range sliders, prompt
 * textareas, collapsible node groups, search/filter, and a workflow info
 * header showing node count, base model, and compatibility status.
 */
export function WorkflowControlPanel({
  controls,
  packId,
  workflowKind,
  graphPath,
  className = "",
  workflowName,
  nodeCount,
  missingNodesCount,
  detectedBaseModel,
  workflowType,
  galleryImageToApply,
  onGallerySettingsApplied,
}: WorkflowControlPanelProps) {
  const selectionKey = packSelectionKey(packId, workflowKind);

  const overrides = useWorkflowControlStore(
    (s) => s.overrides[selectionKey] ?? EMPTY_OVERRIDES,
  );
  // Store actions are stable; one shallow-compared selector for all of them.
  const {
    setOverride,
    setOverrides,
    resetOverride,
    resetAllOverrides,
    resetGroupOverrides,
    undo,
    redo,
    setBatchOverride,
    removeBatchValue,
    markDependencyDirty,
    clearDependencyDirty,
  } = useWorkflowControlStore(
    (s) => ({
      setOverride: s.setOverride,
      setOverrides: s.setOverrides,
      resetOverride: s.resetOverride,
      resetAllOverrides: s.resetAllOverrides,
      resetGroupOverrides: s.resetGroupOverrides,
      undo: s.undo,
      redo: s.redo,
      setBatchOverride: s.setBatchOverride,
      removeBatchValue: s.removeBatchValue,
      markDependencyDirty: s.markDependencyDirty,
      clearDependencyDirty: s.clearDependencyDirty,
    }),
    shallow,
  );
  const setWorkflowControlOverrides = useUIStore(
    (s) => s.setWorkflowControlOverrides,
  );

  // Batch overrides
  const batchOverrides = useWorkflowControlStore(
    (s) => s.batchOverrides[selectionKey] ?? EMPTY_BATCH,
  );

  // Dependency dirty tracking
  const dependencyDirtyKeys = useWorkflowControlStore(
    (s) => s.dependencyDirtyKeys[selectionKey],
  );

  const [showComparison, setShowComparison] = useState(false);
  const [smartDefaultsDismissed, setSmartDefaultsDismissed] = useState(false);
  const [batchModeActive, setBatchModeActive] = useState(false);

  const toggleComparison = useCallback(() => setShowComparison((v) => !v), []);
  const closeComparison = useCallback(() => setShowComparison(false), []);
  const toggleBatchMode = useCallback(() => setBatchModeActive((v) => !v), []);
  const dismissSmartDefaults = useCallback(
    () => setSmartDefaultsDismissed(true),
    [],
  );

  // Fetch model inventory from modelStore
  const modelStoreAvailable = useModelStore(
    useShallow((s) => ({
      checkpoints: selectAvailableCheckpoints(s),
      loras: selectAvailableLoras(s),
      vaes: selectAvailableVaes(s),
      controlnet: selectAvailableControlnet(s),
      upscale_models: selectAvailableUpscaleModels(s),
      clip: selectAvailableClip(s),
      unet: selectAvailableUnet(s),
      ipadapter: selectAvailableIpadapter(s),
      embeddings: selectAvailableEmbeddings(s),
      gligen: selectAvailableGligen(s),
      hypernetworks: selectAvailableHypernetworks(s),
      diffusers: selectAvailableDiffusers(s),
      animatediff_models: selectAvailableAnimatediffModels(s),
      video_models: selectAvailableVideoModels(s),
      style_models: selectAvailableStyleModels(s),
      samplers: selectAvailableSamplers(s),
      schedulers: selectAvailableSchedulers(s),
      enumOptions: selectAvailableEnumOptions(s),
      input_images: selectAvailableInputImages(s),
      input_videos: selectAvailableInputVideos(s),
      input_audios: selectAvailableInputAudios(s),
    })),
  );
  const fetchAvailable = useModelStore((s) => s.fetchAvailable);

  // Build LocalInventory from store (includes model + file inventory)
  const localInventory = useMemo(
    () => buildInventoryFromModelStore(modelStoreAvailable),
    [modelStoreAvailable],
  );

  // Fetch available models once on mount
  useEffect(() => {
    void fetchAvailable();
  }, [fetchAvailable]);

  // object_info metadata (tooltip/advanced/round/control_after_generate/
  // upload/remote/V3 dynamic inputs). Falls back to heuristics offline.
  const { controls: specControls } = useSpecControls(controls, overrides);
  const applyAfterGenerate = useCallback(
    (patch: Record<string, unknown>) => setOverrides(selectionKey, patch),
    [selectionKey, setOverrides],
  );
  const rollNonce = useAfterGenerate(
    selectionKey,
    specControls,
    overrides,
    applyAfterGenerate,
  );

  useEffect(() => {
    // rollNonce: re-expand {a|b} dynamic prompts after every run.
    void rollNonce;
    if (!graphPath) return;
    setWorkflowControlOverrides(
      mergeScopedOverrides(
        useUIStore.getState().workflowControlOverrides,
        graphPath,
        buildSubmitOverrides(specControls, overrides),
      ),
    );
  }, [
    overrides,
    specControls,
    rollNonce,
    graphPath,
    setWorkflowControlOverrides,
  ]);

  const editableControls = useMemo(
    () => getEditableControls(specControls),
    [specControls],
  );

  // Compute effective values (unchanged controls keep their identity so
  // memoized editors skip re-rendering).
  const effectiveCacheRef = useRef<Map<string, EffectiveControl>>(new Map());
  const effectiveControls = useMemo(() => {
    const { items, cache } = stabilizeEffectiveControls(
      computeEffectiveControls(editableControls, overrides),
      effectiveCacheRef.current,
    );
    effectiveCacheRef.current = cache;
    return items;
  }, [editableControls, overrides]);

  // Key/label/kind only — stays identical across value edits.
  const controlMeta = useStableList(
    useMemo(
      () =>
        editableControls.map((c) => ({
          key: c.key,
          label: c.label,
          kind: c.kind,
        })),
      [editableControls],
    ),
    sameControlMeta,
  );

  const smartDefaults = useMemo(
    () =>
      workflowType ? matchSmartDefaults(workflowType, editableControls) : [],
    [workflowType, editableControls],
  );

  const comparisonEntries = useMemo(
    () =>
      showComparison ? buildComparisonEntries(editableControls, overrides) : [],
    [showComparison, editableControls, overrides],
  );

  // Build batch values lookup map for quick access during render
  const batchValueMap = useMemo(() => {
    const map = new Map<string, unknown[]>();
    for (const b of batchOverrides) {
      map.set(b.key, b.values);
    }
    return map;
  }, [batchOverrides]);

  // Keyboard shortcut for undo/redo (Ctrl+Z / Ctrl+Y)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only handle when panel is active and no text input is focused
      const target = e.target as HTMLElement;
      const isInputFocused =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable;
      // Cmd on macOS, Ctrl elsewhere. Shift makes e.key uppercase ("Z"), so
      // compare case-insensitively.
      const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
      const key = e.key.toLowerCase();

      if (mod && !e.shiftKey && key === "z" && !isInputFocused) {
        e.preventDefault();
        undo(selectionKey);
      } else if (
        mod &&
        ((key === "y" && !e.shiftKey) || (key === "z" && e.shiftKey)) &&
        !isInputFocused
      ) {
        e.preventDefault();
        redo(selectionKey);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [selectionKey, undo, redo]);

  // Handle gallery image quick-apply
  useEffect(() => {
    if (!galleryImageToApply) return;
    // The gallery image's paramsMap contains key-value pairs that may map to controls
    const img = galleryImageToApply;
    if (!img.paramsMap || Object.keys(img.paramsMap).length === 0) return;

    // Build override map from gallery params: match by inputKey
    const newOverrides: Record<string, unknown> = {};
    for (const ctrl of editableControls) {
      const paramValue = img.paramsMap[ctrl.inputKey];
      if (paramValue !== undefined && paramValue !== null) {
        newOverrides[ctrl.key] = paramValue;
      }
    }
    // Also try seed specifically
    if (img.seed !== undefined) {
      const seedCtrl = editableControls.find(
        (c) => c.inputKey === "seed" || c.inputKey === "noise_seed",
      );
      if (seedCtrl) {
        newOverrides[seedCtrl.key] = img.seed;
      }
    }

    if (Object.keys(newOverrides).length > 0) {
      setOverrides(selectionKey, newOverrides);
    }
    onGallerySettingsApplied?.();
  }, [
    galleryImageToApply,
    editableControls,
    selectionKey,
    setOverrides,
    onGallerySettingsApplied,
  ]);

  // Reset smart defaults dismissed state when workflow changes
  useEffect(() => {
    setSmartDefaultsDismissed(false);
  }, [selectionKey]);

  // Search/filter state — shown when above threshold
  const showSearch = effectiveControls.length >= SEARCH_THRESHOLD;
  const [searchQuery, setSearchQuery] = useState("");

  // Collapsible group state — all expanded by default
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );

  const toggleGroup = useCallback((group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  }, []);

  // Reset collapsed state when group list changes (workflow switch)
  useEffect(() => {
    setCollapsedGroups(new Set());
  }, [selectionKey]);

  // Apply search filter — match label, inputKey, group, or classType
  const filteredControls = useMemo(() => {
    if (!searchQuery.trim()) return effectiveControls;
    const lq = searchQuery.toLowerCase();
    return effectiveControls.filter(
      (c) =>
        c.label.toLowerCase().includes(lq) ||
        c.inputKey.toLowerCase().includes(lq) ||
        c.group.toLowerCase().includes(lq) ||
        c.classType.toLowerCase().includes(lq),
    );
  }, [effectiveControls, searchQuery]);

  // Per-group control lists. A group whose controls all kept their identity
  // reuses its previous array, so its memoized section skips the re-render.
  const groupedCacheRef = useRef<Record<string, EffectiveControl[]>>({});
  const grouped = useMemo(() => {
    const groups: Record<string, EffectiveControl[]> = {};
    for (const ctrl of filteredControls) {
      if (!groups[ctrl.group]) groups[ctrl.group] = [];
      groups[ctrl.group].push(ctrl);
    }
    const prev = groupedCacheRef.current;
    for (const group of Object.keys(groups)) {
      const old = prev[group];
      const list = groups[group];
      if (
        old &&
        old.length === list.length &&
        old.every((c, i) => c === list[i])
      ) {
        groups[group] = old;
      }
    }
    groupedCacheRef.current = groups;
    return groups;
  }, [filteredControls]);

  // Compute how many overrides are active (across all controls, not just filtered)
  const overrideCount = useMemo(
    () => effectiveControls.filter((c) => c.isOverridden).length,
    [effectiveControls],
  );

  // Compute grouped override summary for per-group reset UX
  const groupSummary = useMemo(
    () => computeGroupedOverrideSummary(editableControls, overrides),
    [editableControls, overrides],
  );

  // Compute extended validation summary (models + images + files)
  const extendedValidation = useMemo(
    () => validateAllControlsExtended(editableControls, localInventory),
    [editableControls, localInventory],
  );

  // Compute grouped invalid summary for per-group invalid display
  const invalidSummary = useMemo(
    () =>
      computeGroupedInvalidSummary(editableControls, overrides, localInventory),
    [editableControls, overrides, localInventory],
  );

  // Compute keys of overridden controls that are invalid but whose defaults are valid
  const invalidOverrideKeys = useMemo(
    () =>
      collectInvalidOverrideKeys(editableControls, overrides, localInventory),
    [editableControls, overrides, localInventory],
  );

  // Compute group-key map for per-group reset
  const groupKeyMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const ctrl of editableControls) {
      if (!map.has(ctrl.group)) {
        map.set(ctrl.group, new Set());
      }
      map.get(ctrl.group)!.add(ctrl.key);
    }
    return map;
  }, [editableControls]);

  // Per-control set/reset handlers bound to this workflow selection.
  // Handlers read per-edit data through refs so they keep their identity
  // across edits (spec-enriched controls are rebuilt on every override change).
  const editableControlsRef = useRef(editableControls);
  editableControlsRef.current = editableControls;
  const groupKeyMapRef = useRef(groupKeyMap);
  groupKeyMapRef.current = groupKeyMap;
  const invalidOverrideKeysRef = useRef(invalidOverrideKeys);
  invalidOverrideKeysRef.current = invalidOverrideKeys;
  const batchOverridesRef = useRef(batchOverrides);
  batchOverridesRef.current = batchOverrides;

  const handleSetOverride = useCallback(
    (key: string, value: unknown) => {
      setOverride(selectionKey, key, value);

      // Dependency tracking: when a model control changes, mark dependents dirty
      const controlsNow = editableControlsRef.current;
      const changedControl = controlsNow.find((c) => c.key === key);
      if (changedControl) {
        const dependentKeys = computeDependentKeys(changedControl, controlsNow);
        if (dependentKeys.length > 0) {
          markDependencyDirty(selectionKey, dependentKeys);
        }
      }
    },
    [selectionKey, setOverride, markDependencyDirty],
  );

  const handleResetOverride = useCallback(
    (key: string) => resetOverride(selectionKey, key),
    [selectionKey, resetOverride],
  );

  const handleResetAll = useCallback(
    () => resetAllOverrides(selectionKey),
    [selectionKey, resetAllOverrides],
  );

  const handleResetGroup = useCallback(
    (group: string) =>
      resetGroupOverrides(
        selectionKey,
        groupKeyMapRef.current.get(group) ?? new Set<string>(),
      ),
    [selectionKey, resetGroupOverrides],
  );

  const handleResetInvalid = useCallback(() => {
    const keys = invalidOverrideKeysRef.current;
    if (keys.size > 0) {
      resetGroupOverrides(selectionKey, keys);
    }
  }, [selectionKey, resetGroupOverrides]);

  const handleClearDependencyDirty = useCallback(
    (key: string) => clearDependencyDirty(selectionKey, key),
    [selectionKey, clearDependencyDirty],
  );

  const handleRemoveBatchValue = useCallback(
    (key: string, index: number) => removeBatchValue(selectionKey, key, index),
    [selectionKey, removeBatchValue],
  );

  const handleAddBatchValue = useCallback(
    (key: string, value: unknown) => {
      const existing = batchOverridesRef.current.find((b) => b.key === key);
      const current = existing ? existing.values : [];
      setBatchOverride(selectionKey, key, [...current, value]);
    },
    [selectionKey, setBatchOverride],
  );

  const handleApplySmartDefault = useCallback(
    (controlKey: string, value: unknown) => {
      setOverride(selectionKey, controlKey, value);
    },
    [selectionKey, setOverride],
  );

  if (effectiveControls.length === 0) {
    return null;
  }

  const searching = searchQuery.length > 0;

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Workflow info header — shown when name or stats are provided */}
      <PanelInfoHeader
        workflowName={workflowName}
        workflowKind={workflowKind}
        nodeCount={nodeCount}
        detectedBaseModel={detectedBaseModel}
        missingNodesCount={missingNodesCount}
      />

      <style dangerouslySetInnerHTML={{ __html: PULSE_ANIMATION_STYLE }} />

      {/* Controls header */}
      <PanelSummaryHeader
        controlCount={effectiveControls.length}
        overrideCount={overrideCount}
        totalInvalid={extendedValidation.totalInvalid}
        invalidOverrideCount={invalidOverrideKeys.size}
        onResetAll={handleResetAll}
        onResetInvalid={handleResetInvalid}
      />

      {/* Toolbar row: undo/redo + batch + compare */}
      <PanelToolbar
        selectionKey={selectionKey}
        batchModeActive={batchModeActive}
        batchCount={batchOverrides.length}
        showComparison={showComparison}
        onToggleBatchMode={toggleBatchMode}
        onToggleComparison={toggleComparison}
      />

      {showComparison && (
        <ComparisonView entries={comparisonEntries} onClose={closeComparison} />
      )}

      {smartDefaults.length > 0 &&
        !smartDefaultsDismissed &&
        overrideCount === 0 && (
          <SmartDefaultsBar
            recommendations={smartDefaults}
            onApply={handleApplySmartDefault}
            onDismiss={dismissSmartDefaults}
          />
        )}

      {/* Batch mode input — shown when batch mode is active */}
      <BatchModeSection
        active={batchModeActive}
        controls={controlMeta}
        batchOverrides={batchOverrides}
        onAddValue={handleAddBatchValue}
        onRemoveValue={handleRemoveBatchValue}
      />

      {/* Search/filter — only shown above threshold */}
      {showSearch && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-light-400 dark:text-dark-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter controls…"
            className="w-full rounded-lg border border-light-200 bg-light-input pl-6 pr-6 py-1.5 text-[11px] text-light-primary dark:border-dark-700 dark:bg-dark-input dark:text-dark-primary outline-none transition-colors focus:border-splash/60 dark:focus:border-splash/40"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-light-400 hover:text-light-600 dark:text-dark-500 dark:hover:text-dark-300 transition-colors"
              title="Clear filter"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {/* Changed-control summary — shows which groups have overrides */}
      {groupSummary.length > 0 && !searchQuery && (
        <div className="flex flex-wrap gap-1">
          {groupSummary.map((gs) => (
            <span
              key={gs.group}
              className="inline-flex items-center gap-0.5 rounded-full border border-splash/20 bg-splash/5 px-1.5 py-0.5 text-[10px] text-splash dark:border-splash/30 dark:bg-splash/10 dark:text-splash"
            >
              <span className="font-medium">{gs.group}</span>
              <span className="text-splash/60 dark:text-splash/70">
                {gs.overrideCount}
              </span>
            </span>
          ))}
        </div>
      )}

      {/* Search empty state */}
      {searchQuery && Object.keys(grouped).length === 0 && (
        <p className="py-2 text-center text-[11px] text-light-400 dark:text-dark-500 italic">
          No controls match &ldquo;{searchQuery}&rdquo;
        </p>
      )}

      {Object.entries(grouped).map(([group, groupControls]) => {
        // Per-group invalid count from invalid summary
        const groupInvalid = invalidSummary.find((g) => g.group === group);
        return (
          <ControlGroupSection
            key={group}
            group={group}
            controls={groupControls}
            selectionKey={selectionKey}
            searching={searching}
            isCollapsed={collapsedGroups.has(group)}
            invalidCount={groupInvalid?.invalidCount ?? 0}
            overriddenInvalidCount={groupInvalid?.overriddenInvalidCount ?? 0}
            onToggleGroup={toggleGroup}
            onResetGroup={handleResetGroup}
            onSetOverride={handleSetOverride}
            onResetOverride={handleResetOverride}
            modelInventory={localInventory}
            dependencyDirtyKeys={dependencyDirtyKeys}
            onClearDependencyDirty={handleClearDependencyDirty}
            batchValueMap={batchValueMap}
            onRemoveBatchValue={handleRemoveBatchValue}
          />
        );
      })}
    </div>
  );
}

export default WorkflowControlPanel;
