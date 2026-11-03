"use client";

import { Fragment, useEffect, useMemo, useState, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  useModelStore,
  selectAvailableCheckpoints,
  selectAvailableLoras,
  selectAvailableVaes,
} from "@/store/modelStore";
import type { Workflow } from "@/types";
import {
  getAllPackCardSummaries,
  extractRequirementsFromWorkflow,
  extractCustomNodeRequirements,
  validateRequirements,
  discoverDynamicControls,
  type PackCardSummary,
  type PackRequirement,
  type PackDynamicControls,
} from "@/lib/oj/packBrowser";
import type { ControlSchema } from "@/lib/oj/workflowControlSchema";
import { getPack } from "@/lib/oj/packs";
import { WorkflowControlPanel } from "@/components/WorkflowControlPanel";
import { PackWorkflowActions } from "@/components/PackWorkflowActions";
import {
  blockerCount,
  describeMissingNodes,
  usePackNodeAvailability,
} from "@/hooks/usePackNodeAvailability";
import type {
  PackKindNodeStatus,
  PackNodeAvailability,
} from "@/lib/comfy/packNodeAvailability";
import {
  AlertTriangle,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  Download,
  FileJson,
  FlaskConical,
  Layers,
  Loader2,
  Package,
  RefreshCw,
  Settings2,
  Sparkles,
  SlidersHorizontal,
} from "lucide-react";

// Status chip component

function StatusChip({
  status,
  label,
}: {
  status: "available" | "missing" | "unknown";
  label: string;
}) {
  const styles = {
    available:
      "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
    missing:
      "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-300",
    unknown:
      "border-light-200 bg-light-50 text-light-500 dark:border-dark-700 dark:bg-dark-850 dark:text-dark-400",
  };

  const icons = {
    available: <Check className="h-3 w-3" />,
    missing: <AlertTriangle className="h-3 w-3" />,
    unknown: <Settings2 className="h-3 w-3" />,
  };

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${styles[status]}`}
      title={
        status === "available"
          ? "Found locally"
          : status === "missing"
            ? "Not found locally"
            : "Availability unknown"
      }
    >
      {icons[status]}
      {label}
    </span>
  );
}

// Pack card

function PackCard({
  summary,
  isExpanded,
  onToggle,
  onSelectWorkflow,
  nodeStatus,
  candidates,
}: {
  summary: PackCardSummary;
  isExpanded: boolean;
  onToggle: () => void;
  onSelectWorkflow: (kind: string) => void;
  /** kind → missing-node status for this pack (absent = not checked). */
  nodeStatus?: Record<string, PackKindNodeStatus>;
  candidates?: PackNodeAvailability["candidates"];
}) {
  const blockedKinds = summary.workflowKinds.filter(
    (wk) => blockerCount(nodeStatus?.[wk.kind]) > 0,
  );
  const packMissing = [
    ...new Set(blockedKinds.flatMap((wk) => nodeStatus![wk.kind].missing)),
  ].sort();
  const packMissingAssets = [
    ...new Set(
      blockedKinds.flatMap((wk) => nodeStatus![wk.kind].missingAssets ?? []),
    ),
  ].sort();
  const packBlockedTip = [
    packMissing.length ? `Missing ComfyUI nodes:\n${packMissing.join("\n")}` : "",
    packMissingAssets.length
      ? `Missing model files:\n${packMissingAssets.join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Color mapping for common model families
  const familyColors: Record<string, string> = {
    sdxl: "from-blue-500/10 via-blue-400/5 to-transparent dark:from-blue-500/20 dark:via-blue-400/10",
    flux: "from-purple-500/10 via-purple-400/5 to-transparent dark:from-purple-500/20 dark:via-purple-400/10",
    sd15: "from-green-500/10 via-green-400/5 to-transparent dark:from-green-500/20 dark:via-green-400/10",
  };

  const gradient = familyColors[summary.modelFamily] ?? familyColors.sdxl;

  return (
    <div className="overflow-hidden rounded-2xl border border-light-100 bg-light-input shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] transition-shadow hover:shadow-[0_4px_12px_rgba(0,0,0,0.08)] dark:border-dark-750 dark:bg-dark-input dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
      <button
        onClick={onToggle}
        className="flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-light-50/50 dark:hover:bg-dark-850/50"
      >
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${gradient} text-light-600 dark:text-dark-300`}
        >
          <Package className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-balance text-light-primary dark:text-dark-primary">
              {summary.name}
            </h3>
            {summary.isDefault && (
              <span className="rounded-full border border-splash/20 bg-splash/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-splash">
                Default
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-light-500 dark:text-dark-400">
            {summary.description}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full border border-light-200 bg-light-50 px-2 py-0.5 text-[11px] font-medium text-light-600 dark:border-dark-700 dark:bg-dark-900 dark:text-dark-300">
              {summary.modelFamily}
            </span>
            <span className="rounded-full border border-light-200 bg-light-50 px-2 py-0.5 text-[11px] font-medium text-light-600 dark:border-dark-700 dark:bg-dark-900 dark:text-dark-300">
              {summary.baseResolution}px base
            </span>
            <span className="rounded-full border border-light-200 bg-light-50 px-2 py-0.5 text-[11px] font-medium text-light-600 dark:border-dark-700 dark:bg-dark-900 dark:text-dark-300">
              {summary.workflowCount} workflow
              {summary.workflowCount !== 1 ? "s" : ""}
            </span>
            {summary.adapterHighlights.map((h) => (
              <span
                key={h}
                className="rounded-full border border-purple-500/20 bg-purple-500/10 px-2 py-0.5 text-[11px] font-medium text-purple-600 dark:text-purple-300"
              >
                {h}
              </span>
            ))}
            {summary.supportsNegativePrompt && (
              <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-300">
                Neg prompt
              </span>
            )}
            {blockedKinds.length > 0 && (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-300"
                title={packBlockedTip}
              >
                <AlertTriangle className="h-3 w-3" />
                {blockedKinds.length}/{summary.workflowKinds.length} modes need
                {packMissing.length && packMissingAssets.length
                  ? " nodes/models"
                  : packMissing.length
                    ? " nodes"
                    : " models"}
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 pt-1">
          {isExpanded ? (
            <ChevronDown className="h-5 w-5 text-light-400 dark:text-dark-500" />
          ) : (
            <ChevronRight className="h-5 w-5 text-light-400 dark:text-dark-500" />
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="border-t border-light-100 px-4 py-3 dark:border-dark-750">
          <div className="mb-3">
            <p className="text-[11px] font-medium text-light-400 dark:text-dark-500">
              Workflow kinds
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {summary.workflowKinds.map((wk) => {
              const status = nodeStatus?.[wk.kind];
              const missingTip = describeMissingNodes(status, candidates);
              const unchecked = status?.format === "ui";
              return (
                <button
                  key={wk.kind}
                  onClick={() => onSelectWorkflow(wk.kind)}
                  data-missing-nodes={missingTip ? "true" : undefined}
                  className={
                    missingTip
                      ? "inline-flex items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-500/15 dark:text-amber-300"
                      : "inline-flex items-center gap-1 rounded-lg border border-light-200 bg-light-50 px-2.5 py-1.5 text-xs font-medium text-light-600 transition-colors hover:border-splash/40 hover:bg-splash/5 hover:text-splash dark:border-dark-700 dark:bg-dark-900 dark:text-dark-300 dark:hover:border-splash/40 dark:hover:bg-splash/10 dark:hover:text-splash"
                  }
                  title={
                    missingTip ??
                    (unchecked
                      ? `${wk.label}: UI-format graph, installed nodes not checked`
                      : `View ${wk.label} workflow details`)
                  }
                >
                  {missingTip ? (
                    <AlertTriangle className="h-3.5 w-3.5" />
                  ) : (
                    <FileJson className="h-3.5 w-3.5" />
                  )}
                  {wk.label}
                  {missingTip && (
                    <span className="text-[10px] font-semibold">
                      ({blockerCount(status)} missing)
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Adapter config summary */}
          <div className="mt-3 rounded-xl border border-light-100 bg-light-50/50 p-3 dark:border-dark-750 dark:bg-dark-850/50">
            <p className="text-[11px] font-medium text-light-400 dark:text-dark-500">
              Adapter config
            </p>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-light-500 dark:text-dark-400">
              <div>
                Sampler:{" "}
                <span className="font-medium text-light-primary dark:text-dark-primary">
                  {summary.adapterHighlights.find(
                    (h) => h.includes("Sampler") || h.includes("Flux"),
                  ) || "KSampler"}
                </span>
              </div>
              <div>
                LoRA:{" "}
                <span className="font-medium text-light-primary dark:text-dark-primary">
                  {summary.adapterHighlights
                    .find((h) => h.startsWith("LoRA:"))
                    ?.replace("LoRA: ", "") || "LoraLoader"}
                </span>
              </div>
              <div>
                Neg prompt:{" "}
                <span
                  className={
                    summary.supportsNegativePrompt
                      ? "text-emerald-600 dark:text-emerald-300"
                      : "text-amber-600 dark:text-amber-300"
                  }
                >
                  {summary.supportsNegativePrompt ? "Yes" : "No"}
                </span>
              </div>
              <div>
                CFG scale:{" "}
                <span className="font-medium text-light-primary dark:text-dark-primary">
                  {summary.supportsCfgScale ? "Yes" : "No"}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Control schema chip — renders a single control from the workflow schema

const CONTROL_KIND_STYLES: Record<string, string> = {
  number: "bg-blue-500/10 text-blue-600 dark:text-blue-300 border-blue-500/20",
  seed: "bg-violet-500/10 text-violet-600 dark:text-violet-300 border-violet-500/20",
  string:
    "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border-emerald-500/20",
  enum: "bg-amber-500/10 text-amber-600 dark:text-amber-300 border-amber-500/20",
  boolean: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-300 border-cyan-500/20",
  image: "bg-pink-500/10 text-pink-600 dark:text-pink-300 border-pink-500/20",
  model:
    "bg-purple-500/10 text-purple-600 dark:text-purple-300 border-purple-500/20",
  link: "bg-light-400/10 text-light-500 dark:text-dark-400 border-light-400/20",
  hidden:
    "bg-light-400/5 text-light-400 dark:text-dark-500 border-light-400/10",
};

const CONTROL_KIND_ICONS: Record<string, React.ReactNode> = {
  number: <span className="text-[9px] font-mono">#</span>,
  seed: <Sparkles className="h-2.5 w-2.5" />,
  string: <span className="text-[9px] font-mono">Aa</span>,
  enum: <span className="text-[9px] font-mono">&#x25BC;</span>,
  boolean: <span className="text-[9px] font-mono">&#x2713;</span>,
  image: <span className="text-[9px]">&#x1F5BC;</span>,
  model: <Boxes className="h-2.5 w-2.5" />,
};

function ControlChip({ control }: { control: ControlSchema }) {
  const style = CONTROL_KIND_STYLES[control.kind] ?? CONTROL_KIND_STYLES.string;
  const icon = CONTROL_KIND_ICONS[control.kind];

  const formatValue = (value: unknown): string => {
    if (value === null || value === undefined) return "—";
    if (typeof value === "string")
      return value.length > 18 ? value.slice(0, 16) + "…" : value;
    return String(value);
  };

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${style}`}
      title={`${control.key}: ${control.kind}${control.min != null ? ` (${control.min}–${control.max})` : ""}`}
    >
      {icon}
      <span className="font-semibold">{control.label}</span>
      {control.defaultValue != null && (
        <span className="opacity-70">{formatValue(control.defaultValue)}</span>
      )}
    </span>
  );
}

// Workflow detail panel

function WorkflowDetailPanel({
  requirements,
  customNodes,
  controls,
  loading,
  packId,
  workflowKind,
  graphPath,
}: {
  requirements: PackRequirement[];
  customNodes: PackRequirement[];
  controls: PackDynamicControls | null;
  loading: boolean;
  packId: string;
  workflowKind: string;
  /** Workflow file under public/workflows; scopes control overrides. */
  graphPath?: string;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-2xl bg-light-input p-8 dark:bg-dark-input">
        <Loader2 className="h-6 w-6 animate-spin text-splash" />
        <span className="ml-3 text-sm text-light-500 dark:text-dark-400">
          Analyzing workflow...
        </span>
      </div>
    );
  }

  if (!controls && requirements.length === 0 && customNodes.length === 0) {
    return (
      <div className="rounded-2xl bg-light-input p-6 text-center dark:bg-dark-input">
        <Settings2 className="mx-auto h-8 w-8 text-light-400 dark:text-dark-500" />
        <p className="mt-2 text-sm text-light-500 dark:text-dark-400">
          Select a workflow to see its requirements and controls.
        </p>
      </div>
    );
  }

  const availableCount = requirements.filter(
    (r) => r.status === "available",
  ).length;
  const missingCount = requirements.filter(
    (r) => r.status === "missing",
  ).length;
  const unknownCount = requirements.filter(
    (r) => r.status === "unknown",
  ).length;

  return (
    <div className="space-y-4">
      {controls && (
        <div className="rounded-2xl border border-light-100 bg-light-input p-4 dark:border-dark-750 dark:bg-dark-input">
          <p className="text-[11px] font-medium text-light-400 dark:text-dark-500">
            Discovered controls
          </p>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <div className="rounded-xl border border-light-100 bg-light-50/50 p-2.5 dark:border-dark-750 dark:bg-dark-850/50">
              <div className="text-lg font-semibold text-light-primary dark:text-dark-primary">
                {controls.nodeTypeCount}
              </div>
              <div className="text-[11px] text-light-500 dark:text-dark-400">
                Node types
              </div>
            </div>
            <div className="rounded-xl border border-light-100 bg-light-50/50 p-2.5 dark:border-dark-750 dark:bg-dark-850/50">
              <div className="text-lg font-semibold text-light-primary dark:text-dark-primary">
                {controls.nodeCount}
              </div>
              <div className="text-[11px] text-light-500 dark:text-dark-400">
                Nodes
              </div>
            </div>
            <div className="rounded-xl border border-light-100 bg-light-50/50 p-2.5 dark:border-dark-750 dark:bg-dark-850/50">
              <div className="text-lg font-semibold text-splash">
                {controls.workflowType}
              </div>
              <div className="text-[11px] text-light-500 dark:text-dark-400">
                Type
              </div>
            </div>
            {controls.samplerClass && (
              <div className="rounded-xl border border-light-100 bg-light-50/50 p-2.5 dark:border-dark-750 dark:bg-dark-850/50">
                <div className="text-sm font-semibold text-light-primary dark:text-dark-primary truncate">
                  {controls.samplerClass}
                </div>
                <div className="text-[11px] text-light-500 dark:text-dark-400">
                  Sampler
                </div>
              </div>
            )}
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {controls.capabilities.controlnet && (
              <StatusChip status="available" label="ControlNet" />
            )}
            {controls.capabilities.ipadapter && (
              <StatusChip status="available" label="IPAdapter" />
            )}
            {controls.capabilities.upscale && (
              <StatusChip status="available" label="Upscale" />
            )}
            {controls.capabilities.video && (
              <StatusChip status="available" label="Video" />
            )}
            {controls.capabilities.lora && (
              <StatusChip status="available" label="LoRA" />
            )}
          </div>

          {Object.keys(controls.defaults).length > 0 && (
            <div className="mt-3 space-y-1">
              <p className="text-[11px] font-medium text-light-400 dark:text-dark-500">
                Default parameters
              </p>
              <div className="flex flex-wrap gap-2 text-xs">
                {controls.defaults.steps !== undefined && (
                  <span className="rounded border border-light-200 bg-light-50 px-2 py-1 dark:border-dark-700 dark:bg-dark-900">
                    Steps:{" "}
                    <span className="font-medium">
                      {controls.defaults.steps}
                    </span>
                  </span>
                )}
                {controls.defaults.cfg !== undefined && (
                  <span className="rounded border border-light-200 bg-light-50 px-2 py-1 dark:border-dark-700 dark:bg-dark-900">
                    CFG:{" "}
                    <span className="font-medium">{controls.defaults.cfg}</span>
                  </span>
                )}
                {controls.defaults.sampler && (
                  <span className="rounded border border-light-200 bg-light-50 px-2 py-1 dark:border-dark-700 dark:bg-dark-900">
                    Sampler:{" "}
                    <span className="font-medium">
                      {controls.defaults.sampler}
                    </span>
                  </span>
                )}
                {controls.defaults.scheduler && (
                  <span className="rounded border border-light-200 bg-light-50 px-2 py-1 dark:border-dark-700 dark:bg-dark-900">
                    Scheduler:{" "}
                    <span className="font-medium">
                      {controls.defaults.scheduler}
                    </span>
                  </span>
                )}
                {controls.defaults.width !== undefined &&
                  controls.defaults.height !== undefined && (
                    <span className="rounded border border-light-200 bg-light-50 px-2 py-1 dark:border-dark-700 dark:bg-dark-900">
                      Size:{" "}
                      <span className="font-medium">
                        {controls.defaults.width}×{controls.defaults.height}
                      </span>
                    </span>
                  )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Workflow control schema — editable control panel */}
      {controls && controls.controlSchema.length > 0 && (
        <div className="rounded-2xl border border-light-100 bg-light-input p-4 dark:border-dark-750 dark:bg-dark-input">
          <WorkflowControlPanel
            controls={controls.controlSchema}
            packId={packId}
            workflowKind={workflowKind}
            graphPath={graphPath}
          />
        </div>
      )}

      {requirements.length > 0 && (
        <div className="rounded-2xl border border-light-100 bg-light-input p-4 dark:border-dark-750 dark:bg-dark-input">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-medium text-light-400 dark:text-dark-500">
              Required models
            </p>
            <div className="flex items-center gap-2">
              {availableCount > 0 && (
                <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-300">
                  {availableCount} available
                </span>
              )}
              {missingCount > 0 && (
                <span className="text-[11px] font-medium text-amber-600 dark:text-amber-300">
                  {missingCount} missing
                </span>
              )}
            </div>
          </div>
          <div className="mt-2 space-y-1.5">
            {requirements.map((req, i) => {
              const iconMap: Record<string, React.ReactNode> = {
                checkpoint: <Boxes className="h-4 w-4" />,
                lora: <Layers className="h-4 w-4" />,
                vae: <FlaskConical className="h-4 w-4" />,
                controlnet: <Cpu className="h-4 w-4" />,
                upscale: <Download className="h-4 w-4" />,
                custom_node: <Cpu className="h-4 w-4" />,
              };
              return (
                <div
                  key={`${req.identifier}-${i}`}
                  className="flex items-center gap-2 rounded-xl border border-light-100 bg-light-50/50 px-3 py-2 dark:border-dark-750 dark:bg-dark-850/50"
                >
                  <div
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                      req.category === "checkpoint"
                        ? "bg-blue-500/10 text-blue-500"
                        : req.category === "lora"
                          ? "bg-purple-500/10 text-purple-500"
                          : req.category === "vae"
                            ? "bg-emerald-500/10 text-emerald-500"
                            : "bg-light-400/10 text-light-500 dark:text-dark-400"
                    }`}
                  >
                    {iconMap[req.category] ?? <FileJson className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-light-primary dark:text-dark-primary">
                      {req.name}
                    </p>
                    <p className="truncate text-[11px] text-light-400 dark:text-dark-500">
                      {req.loaderClassType}
                    </p>
                  </div>
                  <StatusChip
                    status={req.status}
                    label={
                      req.status === "available"
                        ? "Found"
                        : req.status === "missing"
                          ? "Missing"
                          : "Unknown"
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {customNodes.length > 0 && (
        <div className="rounded-2xl border border-light-100 bg-light-input p-4 dark:border-dark-750 dark:bg-dark-input">
          <p className="text-[11px] font-medium text-light-400 dark:text-dark-500">
            Custom nodes required
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {customNodes.map((cn) => (
              <span
                key={cn.identifier}
                className="rounded-full border border-light-200 bg-light-50 px-2 py-0.5 text-[11px] text-light-500 dark:border-dark-700 dark:bg-dark-900 dark:text-dark-400"
              >
                {cn.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Main PackBrowser component

export function PackBrowser() {
  const [expandedPack, setExpandedPack] = useState<string | null>(null);
  const [selectedWorkflow, setSelectedWorkflow] = useState<{
    packId: string;
    kind: string;
    file: string;
  } | null>(null);
  const [workflowRequirements, setWorkflowRequirements] = useState<
    PackRequirement[]
  >([]);
  const [workflowCustomNodes, setWorkflowCustomNodes] = useState<
    PackRequirement[]
  >([]);
  const [dynamicControls, setDynamicControls] =
    useState<PackDynamicControls | null>(null);
  const [loadingWorkflow, setLoadingWorkflow] = useState(false);

  const available = useModelStore(
    useShallow((s) => ({
      checkpoints: selectAvailableCheckpoints(s),
      loras: selectAvailableLoras(s),
      vaes: selectAvailableVaes(s),
    })),
  );
  const fetchAvailable = useModelStore((s) => s.fetchAvailable);

  const packSummaries = useMemo(() => getAllPackCardSummaries(), []);
  const {
    availability: nodeAvailability,
    loading: nodeAvailabilityLoading,
    refresh: refreshNodeAvailability,
  } = usePackNodeAvailability();

  const modelFiles = useMemo(
    () => ({
      checkpoints: available.checkpoints,
      loras: available.loras,
      vaes: available.vaes,
    }),
    [available],
  );

  useEffect(() => {
    void fetchAvailable();
  }, [fetchAvailable]);

  // Load and analyze a workflow on selection
  const handleExpandWorkflow = useCallback(
    async (kind: string, packId: string) => {
      const pack = getPack(packId);
      if (!pack) return;

      const file = pack.workflows[kind as keyof typeof pack.workflows] as
        | string
        | undefined;
      if (!file) return;

      setSelectedWorkflow({ packId, kind, file });
      setLoadingWorkflow(true);
      setWorkflowRequirements([]);
      setWorkflowCustomNodes([]);
      setDynamicControls(null);

      try {
        // Pack workflow paths are relative to public/workflows.
        const urls = [`/workflows/${file}`];

        let workflowData: Workflow | null = null;
        for (const url of urls) {
          try {
            const resp = await fetch(url);
            if (resp.ok) {
              workflowData = await resp.json();
              break;
            }
          } catch {
            // try next URL
          }
        }

        if (workflowData) {
          const reqs = extractRequirementsFromWorkflow(workflowData);
          const cns = extractCustomNodeRequirements(workflowData);
          const controls = discoverDynamicControls(workflowData);

          const validatedReqs = validateRequirements(reqs, modelFiles);

          setWorkflowRequirements(validatedReqs);
          setWorkflowCustomNodes(cns);
          setDynamicControls(controls);
        }
      } catch {
        // Silently fail — workflow might not be available locally
      } finally {
        setLoadingWorkflow(false);
      }
    },
    [modelFiles],
  );

  // Reset workflow detail when expanding a different pack
  const handleTogglePack = useCallback(
    (packId: string) => {
      if (expandedPack === packId) {
        setExpandedPack(null);
        setSelectedWorkflow(null);
        setWorkflowRequirements([]);
        setWorkflowCustomNodes([]);
        setDynamicControls(null);
      } else {
        setExpandedPack(packId);
        // Auto-select first workflow kind
        const pack = getPack(packId);
        if (pack) {
          const firstKind = Object.keys(pack.workflows)[0];
          if (firstKind) {
            void handleExpandWorkflow(firstKind, packId);
          }
        }
      }
    },
    [expandedPack, handleExpandWorkflow],
  );

  // Fill custom-node status from the live missing-node report (API graphs).
  const selectedNodeStatus = selectedWorkflow
    ? nodeAvailability?.packs[selectedWorkflow.packId]?.[selectedWorkflow.kind]
    : undefined;
  const resolvedCustomNodes = useMemo(
    () =>
      selectedNodeStatus?.format === "api"
        ? workflowCustomNodes.map((cn) => ({
            ...cn,
            status: selectedNodeStatus.missing.includes(cn.identifier)
              ? ("missing" as const)
              : ("available" as const),
          }))
        : workflowCustomNodes,
    [selectedNodeStatus, workflowCustomNodes],
  );

  const workflowDetail = selectedWorkflow && (
    <div className="mt-2 mb-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium text-light-primary dark:text-dark-primary">
          Workflow: {selectedWorkflow.kind.replace(/_/g, " ")}
        </h3>
        <button
          type="button"
          onClick={() => {
            setSelectedWorkflow(null);
            setWorkflowRequirements([]);
            setWorkflowCustomNodes([]);
            setDynamicControls(null);
          }}
          className="rounded-full border border-light-200 px-2 py-1 text-[11px] text-light-500 transition-colors hover:bg-light-50 dark:border-dark-700 dark:text-dark-400 dark:hover:bg-dark-850"
        >
          Close
        </button>
      </div>
      <div className="mb-3">
        <PackWorkflowActions
          key={`${selectedWorkflow.packId}:${selectedWorkflow.kind}`}
          packName={getPack(selectedWorkflow.packId)?.name ?? selectedWorkflow.packId}
          packKey={selectedWorkflow.kind}
          file={selectedWorkflow.file}
        />
      </div>
      <WorkflowDetailPanel
        requirements={workflowRequirements}
        customNodes={resolvedCustomNodes}
        controls={dynamicControls}
        loading={loadingWorkflow}
        packId={selectedWorkflow?.packId ?? ""}
        workflowKind={selectedWorkflow?.kind ?? ""}
        graphPath={selectedWorkflow?.file}
      />
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-medium text-light-primary dark:text-dark-primary">
            Workflow Packs
          </h2>
          <button
            type="button"
            onClick={() => void refreshNodeAvailability()}
            disabled={nodeAvailabilityLoading}
            className="ml-auto inline-flex items-center gap-1 rounded-full border border-light-200 px-2 py-1 text-[11px] text-light-500 transition-colors hover:bg-light-50 disabled:opacity-60 dark:border-dark-700 dark:text-dark-400 dark:hover:bg-dark-850"
            title="Re-check installed ComfyUI nodes against every pack"
          >
            {nodeAvailabilityLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Recheck nodes
          </button>
        </div>
        <p className="mt-1 text-sm text-light-500 dark:text-dark-400">
          Browse available workflow packs and validate model requirements. Each
          pack groups workflows for a specific model family.
        </p>
      </div>

      <div className="space-y-3">
        {packSummaries.map((summary) => (
          <Fragment key={summary.id}>
          <PackCard
            key={summary.id}
            summary={summary}
            isExpanded={expandedPack === summary.id}
            onToggle={() => handleTogglePack(summary.id)}
            onSelectWorkflow={(kind) => handleExpandWorkflow(kind, summary.id)}
            nodeStatus={nodeAvailability?.packs[summary.id]}
            candidates={nodeAvailability?.candidates}
          />
          {/* Detail opens right under its own pack, not after the list. */}
          {selectedWorkflow?.packId === summary.id && workflowDetail}
          </Fragment>
        ))}
      </div>

    </div>
  );
}

export default PackBrowser;
