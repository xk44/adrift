"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useModelStore } from "@/store/modelStore";
import { useUIStore } from "@/store";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import type { ModelAlias } from "@/types";
import {
  detectWorkflowType,
  formatWorkflowName,
  getTypeLabel,
  getTypeColorClasses,
  detectRequiredInputs,
  analyzeWorkflowStructure,
  validateWorkflowForApi,
  type WorkflowType,
  type RequiredInput,
  type WorkflowStructure,
  type WorkflowValidation,
} from "@/lib/oj/workflow-analysis";
import type { WorkflowRuntimeCompatibility } from "@/lib/comfy/manager";
import {
  useInstallConfirmFlow,
  type InstallConfirmState,
} from "@/lib/hooks/useInstallConfirmFlow";
import { openSetupTab } from "@/lib/setupNav";
import { isOverlayMode } from "@/lib/overlay";
import { getActiveHostSession } from "@/lib/overlay/session";
import { getComfyWsBaseOverride } from "@/lib/comfy/wsBaseOverride";
import {
  buildEditInComfyMessages,
  buildShowGraphMessage,
  comfyFrontendUrl,
  openedComfyToast,
} from "@/lib/comfy/editInComfyUI";
import {
  Plus,
  Trash2,
  Edit2,
  X,
  Upload,
  Download,
  FileJson,
  Layers,
  Box,
  Palette,
  RefreshCw,
  AlertCircle,
  Check,
  ChevronRight,
  Star,
  StarOff,
  Eye,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Image,
  Wand2,
  Maximize2,
  Paintbrush,
  HelpCircle,
  Loader2,
  ExternalLink,
} from "lucide-react";
import { showToast } from "@/components/Toast";
import { StateView } from "@/components/ui/StateView";
import { friendlyLoadError } from "@/lib/ui/viewState";

export interface WorkflowData {
  id: string;
  name: string;
  file: string;
  path: string;
  source: string;
  type?: WorkflowType;
  requiredInputs?: RequiredInput[];
  structure?: WorkflowStructure;
  validation?: WorkflowValidation;
  runtime?: WorkflowRuntimeCompatibility;
  isDefault?: boolean;
  loaded?: boolean;
}

/*
 * Workflow and model-name sections of the Setup page (SetupPage.tsx owns the
 * tabs and URL).
 */

export function AliasManager() {
  const aliases = useModelStore((s) => s.aliases);
  const addAlias = useModelStore((s) => s.addAlias);
  const removeAlias = useModelStore((s) => s.removeAlias);
  const updateAlias = useModelStore((s) => s.updateAlias);
  const available = useModelStore((s) => s.available);
  const fetchAvailable = useModelStore((s) => s.fetchAvailable);
  const isLoading = useModelStore((s) => s.isLoading);

  const [editingAlias, setEditingAlias] = useState<string | null>(null);
  const [newAlias, setNewAlias] = useState<Partial<ModelAlias> | null>(null);

  useEffect(() => {
    fetchAvailable();
  }, [fetchAvailable]);

  const handleSaveNew = () => {
    if (newAlias?.alias && newAlias?.filename && newAlias?.type) {
      addAlias(newAlias as ModelAlias);
      setNewAlias(null);
    }
  };

  const groupedAliases = {
    checkpoint: aliases.filter((a) => a.type === "checkpoint"),
    lora: aliases.filter((a) => a.type === "lora"),
    vae: aliases.filter((a) => a.type === "vae"),
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium text-[var(--text-primary)]">
            Model Aliases
          </h2>
          <p className="text-sm text-[var(--text-secondary)]">
            Create shortcuts for models like{" "}
            <code className="text-[var(--accent-primary)]">
              --v illustrious
            </code>{" "}
            or{" "}
            <code className="text-[var(--accent-primary)]">
              --lora anime::0.55
            </code>
          </p>
        </div>
        <button
          onClick={() => fetchAvailable()}
          disabled={isLoading}
          className="btn btn-secondary flex items-center gap-2"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
          Refresh Models
        </button>
      </div>

      <AliasSection
        title="Checkpoints"
        icon={Box}
        aliases={groupedAliases.checkpoint}
        availableOptions={available.checkpoints}
        type="checkpoint"
        editingAlias={editingAlias}
        setEditingAlias={setEditingAlias}
        onRemove={removeAlias}
        onUpdate={updateAlias}
      />
      <AliasSection
        title="LoRAs"
        icon={Layers}
        aliases={groupedAliases.lora}
        availableOptions={available.loras}
        type="lora"
        editingAlias={editingAlias}
        setEditingAlias={setEditingAlias}
        onRemove={removeAlias}
        onUpdate={updateAlias}
      />
      <AliasSection
        title="VAEs"
        icon={Palette}
        aliases={groupedAliases.vae}
        availableOptions={available.vaes}
        type="vae"
        editingAlias={editingAlias}
        setEditingAlias={setEditingAlias}
        onRemove={removeAlias}
        onUpdate={updateAlias}
      />

      <div className="card p-4">
        <h3 className="font-medium text-[var(--text-primary)] mb-4">
          Add New Alias
        </h3>
        {newAlias ? (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="text-sm text-[var(--text-secondary)] mb-1 block">
                  Type
                </label>
                <select
                  aria-label="Type"
                  value={newAlias.type ?? ""}
                  onChange={(e) =>
                    setNewAlias({
                      ...newAlias,
                      type: e.target.value as ModelAlias["type"],
                    })
                  }
                  className="input w-full"
                >
                  <option value="">Select type...</option>
                  <option value="checkpoint">Checkpoint</option>
                  <option value="lora">LoRA</option>
                  <option value="vae">VAE</option>
                </select>
              </div>
              <div>
                <label className="text-sm text-[var(--text-secondary)] mb-1 block">
                  Alias
                </label>
                <input
                  aria-label="Alias"
                  type="text"
                  value={newAlias.alias ?? ""}
                  onChange={(e) =>
                    setNewAlias({ ...newAlias, alias: e.target.value })
                  }
                  placeholder="e.g., illustrious"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="text-sm text-[var(--text-secondary)] mb-1 block">
                  File
                </label>
                <select
                  aria-label="File"
                  value={newAlias.filename ?? ""}
                  onChange={(e) =>
                    setNewAlias({ ...newAlias, filename: e.target.value })
                  }
                  className="input w-full"
                >
                  <option value="">Select file...</option>
                  {(newAlias.type === "checkpoint"
                    ? available.checkpoints
                    : newAlias.type === "lora"
                      ? available.loras
                      : newAlias.type === "vae"
                        ? available.vaes
                        : []
                  ).map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setNewAlias(null)}
                className="btn btn-secondary"
              >
                Cancel
              </button>
              <button onClick={handleSaveNew} className="btn btn-primary">
                Save Alias
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setNewAlias({ type: "checkpoint" })}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg border border-dashed border-[var(--border-primary)] text-[var(--text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)] transition-colors"
          >
            <Plus className="w-5 h-5" />
            Add Alias
          </button>
        )}
      </div>
    </div>
  );
}

interface AliasSectionProps {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  aliases: ModelAlias[];
  availableOptions: string[];
  type: ModelAlias["type"];
  editingAlias: string | null;
  setEditingAlias: (alias: string | null) => void;
  onRemove: (alias: string) => void;
  onUpdate: (alias: string, update: Partial<ModelAlias>) => void;
}

function AliasSection({
  title,
  icon: Icon,
  aliases,
  availableOptions,
  editingAlias,
  setEditingAlias,
  onRemove,
  onUpdate,
}: AliasSectionProps) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-4">
        <Icon className="w-5 h-5 text-[var(--accent-primary)]" />
        <h3 className="font-medium text-[var(--text-primary)]">{title}</h3>
        <span className="text-sm text-[var(--text-muted)]">
          ({aliases.length})
        </span>
      </div>
      {aliases.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)] py-4 text-center">
          No {title.toLowerCase()} aliases defined yet
        </p>
      ) : (
        <div className="space-y-2">
          {aliases.map((alias) => (
            <AliasRow
              key={alias.alias}
              alias={alias}
              availableOptions={availableOptions}
              isEditing={editingAlias === alias.alias}
              onEdit={() => setEditingAlias(alias.alias)}
              onCancel={() => setEditingAlias(null)}
              onSave={(update) => {
                onUpdate(alias.alias, update);
                setEditingAlias(null);
              }}
              onRemove={() => onRemove(alias.alias)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface AliasRowProps {
  alias: ModelAlias;
  availableOptions: string[];
  isEditing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (update: Partial<ModelAlias>) => void;
  onRemove: () => void;
}

function AliasRow({
  alias,
  availableOptions,
  isEditing,
  onEdit,
  onCancel,
  onSave,
  onRemove,
}: AliasRowProps) {
  const [editValues, setEditValues] = useState(alias);

  if (isEditing) {
    return (
      <div className="flex items-center gap-2 p-2 rounded-lg bg-[var(--bg-tertiary)]">
        <input
          aria-label="Alias"
          type="text"
          value={editValues.alias}
          onChange={(e) =>
            setEditValues({ ...editValues, alias: e.target.value })
          }
          className="input flex-1"
        />
        <select
          aria-label="File"
          value={editValues.filename}
          onChange={(e) =>
            setEditValues({ ...editValues, filename: e.target.value })
          }
          className="input flex-1"
        >
          {availableOptions.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <button
          aria-label="Save alias"
          onClick={() => onSave(editValues)}
          className="btn-ghost btn-icon text-[var(--success)]"
        >
          <Check className="w-4 h-4" />
        </button>
        <button aria-label="Cancel" onClick={onCancel} className="btn-ghost btn-icon">
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 p-2 rounded-lg hover:bg-[var(--bg-tertiary)] group">
      <code className="text-[var(--accent-primary)] font-mono text-sm min-w-[120px]">
        {alias.alias}
      </code>
      <span className="text-[var(--text-muted)]">→</span>
      <span className="text-sm text-[var(--text-secondary)] truncate flex-1">
        {alias.filename}
      </span>
      <div className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity flex items-center gap-1">
        <button aria-label="Edit alias" onClick={onEdit} className="btn-ghost btn-icon">
          <Edit2 className="w-4 h-4" />
        </button>
        <button
          aria-label="Remove alias"
          onClick={onRemove}
          className="btn-ghost btn-icon text-[var(--error)]"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export function WorkflowManager({
  initialWorkflows,
}: {
  /** Pre-seeded list (tests / static render); still refetched on mount */
  initialWorkflows?: WorkflowData[];
}) {
  const selectedWorkflowPath = useUIStore((s) => s.selectedWorkflowPath);
  const setSelectedWorkflow = useUIStore((s) => s.setSelectedWorkflow);
  const defaultWorkflowPath = useUIStore((s) => s.defaultWorkflowPath);
  const setDefaultWorkflow = useUIStore((s) => s.setDefaultWorkflow);
  const clearDefaultWorkflow = useUIStore((s) => s.clearDefaultWorkflow);
  const setActiveNav = useUIStore((s) => s.setActiveNav);

  const [workflows, setWorkflows] = useState<WorkflowData[]>(
    initialWorkflows ?? [],
  );
  const [directory, setDirectory] = useState<string>("");
  const [loading, setLoading] = useState(!initialWorkflows);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [previewWorkflow, setPreviewWorkflow] = useState<WorkflowData | null>(
    null,
  );
  const [previewLoading, setPreviewLoading] = useState(false);

  const installFlow = useInstallConfirmFlow();

  const [isOverlay, setIsOverlay] = useState(false);
  const [serverComfyUrl, setServerComfyUrl] = useState<string | null>(null);
  // Set after "Edit in ComfyUI": refetch once when the user comes back.
  const refetchOnReturnRef = useRef(false);

  useEffect(() => {
    setIsOverlay(isOverlayMode());
  }, []);

  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === "hidden") return;
      if (!refetchOnReturnRef.current) return;
      refetchOnReturnRef.current = false;
      setReloadKey((k) => k + 1);
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, []);

  const resolveComfyUrl = useCallback(
    (httpUrl: string | null) =>
      comfyFrontendUrl({
        wsOverride: getComfyWsBaseOverride(),
        envWsBase: process.env.NEXT_PUBLIC_COMFY_WS_BASE ?? null,
        httpUrl,
        page: window.location,
      }),
    [],
  );

  // Only a relative WS proxy path leaves the browser without a ComfyUI URL;
  // then ask the server which ComfyUI it uses.
  useEffect(() => {
    if (isOverlay || resolveComfyUrl(null)) return;
    let cancelled = false;
    fetch("/api/settings/comfy-connection?quick=1", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { httpUrl?: string }) => {
        if (!cancelled && d.httpUrl) setServerComfyUrl(d.httpUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOverlay, resolveComfyUrl]);

  const handleEditInComfy = useCallback(
    async (wf: WorkflowData | null) => {
      const label = wf ? formatWorkflowName(wf.name) : "";
      if (isOverlay) {
        const session = getActiveHostSession();
        if (!session) {
          showToast("ComfyUI isn't connected to Adrift yet", "error");
          return;
        }
        if (!wf) {
          window.parent.postMessage(
            buildShowGraphMessage(session.nonce),
            session.origin,
          );
          refetchOnReturnRef.current = true;
          return;
        }
        try {
          const res = await fetch(
            `/api/comfy/workflows?path=${encodeURIComponent(`saved:${wf.file}`)}&format=ui`,
            { cache: "no-store" },
          );
          const data = await res.json();
          if (!res.ok || !data.ok || !data.workflow) {
            throw new Error(data.error || `HTTP ${res.status}`);
          }
          for (const msg of buildEditInComfyMessages(
            data.workflow,
            wf.file,
            session.nonce,
          )) {
            window.parent.postMessage(msg, session.origin);
          }
          refetchOnReturnRef.current = true;
        } catch (err) {
          showToast(
            `Couldn't open ${label} in ComfyUI: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }
        return;
      }

      const url = resolveComfyUrl(serverComfyUrl);
      if (!url) {
        showToast("ComfyUI address unknown — set it in Settings", "error");
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
      refetchOnReturnRef.current = true;
      showToast(
        wf ? openedComfyToast(label) : "Opened ComfyUI",
        "info",
        6000,
      );
    },
    [isOverlay, resolveComfyUrl, serverComfyUrl],
  );

  // Fetch workflows list with runtime compatibility info
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        setLoading(true);
        const response = await fetch("/api/comfy/workflows?includeRuntime=1", {
          cache: "no-store",
        });
        const data = await response.json();
        if (!response.ok || !data.ok) {
          throw new Error(data.error || `HTTP ${response.status}`);
        }
        if (!cancelled) {
          const wfs: WorkflowData[] = (data.workflows || []).map(
            (wf: Record<string, unknown>) => ({
              id: wf.id as string,
              name: wf.name as string,
              file: wf.file as string,
              path: wf.path as string,
              source: wf.source as string,
              // Kind detected server-side; the preview refines it on demand.
              type: (typeof wf.kind === "string"
                ? wf.kind
                : "unknown") as WorkflowType,
              runtime: wf.runtime as WorkflowRuntimeCompatibility | undefined,
              isDefault:
                useUIStore.getState().defaultWorkflowPath ===
                `saved:${wf.file}`,
            }),
          );
          setWorkflows(wfs);
          setDirectory(data.directory || "");
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(friendlyLoadError(err, "Failed to load workflows"));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    load();
    return () => {
      cancelled = true;
    };
    // Load once per reload: starring a default must not re-run every
    // runtime check. The effect below keeps isDefault in sync.
  }, [reloadKey]);

  // Load workflow details (type, inputs, validation) on demand
  const loadWorkflowDetails = useCallback(async (wf: WorkflowData) => {
    if (wf.loaded) return wf;

    try {
      const response = await fetch(
        `/api/comfy/workflows?path=${encodeURIComponent(`saved:${wf.file}`)}`,
      );
      const data = await response.json();
      if (!response.ok || !data.ok) {
        return wf;
      }

      const workflow = data.workflow;
      if (!workflow) return wf;

      const type = detectWorkflowType(workflow);
      const requiredInputs = detectRequiredInputs(workflow);
      const structure = analyzeWorkflowStructure(workflow);
      const validation = validateWorkflowForApi(workflow);

      return {
        ...wf,
        type,
        requiredInputs,
        structure,
        validation,
        loaded: true,
      };
    } catch {
      return wf;
    }
  }, []);

  const handlePreview = async (wf: WorkflowData) => {
    setPreviewLoading(true);
    const detailed = await loadWorkflowDetails(wf);
    setPreviewWorkflow(detailed);
    setPreviewLoading(false);
  };

  // Request inline confirmation for installing missing nodes
  const handleRequestInstall = useCallback(
    (wf: WorkflowData) => {
      const packIds = wf.runtime?.unambiguousInstallPackIds ?? [];
      if (packIds.length === 0) return;
      installFlow.requestConfirm(wf.id, formatWorkflowName(wf.name), packIds);
    },
    [installFlow],
  );

  // Select a workflow and go to Create view
  const handleUseWorkflow = (wf: WorkflowData) => {
    const workflowPath = `saved:${wf.file}`;
    setSelectedWorkflow(workflowPath, wf.name);
    setActiveNav("create");
  };

  const handleToggleDefault = (wf: WorkflowData) => {
    const workflowPath = `saved:${wf.file}`;
    if (defaultWorkflowPath === workflowPath) {
      clearDefaultWorkflow();
    } else {
      setDefaultWorkflow(workflowPath, wf.name);
    }
    // isDefault follows defaultWorkflowPath via the effect below.
  };

  // Update workflow when default changes
  useEffect(() => {
    setWorkflows((prev) =>
      prev.map((w) => ({
        ...w,
        isDefault: `saved:${w.file}` === defaultWorkflowPath,
      })),
    );
  }, [defaultWorkflowPath]);

  const getWorkflowIcon = (type: WorkflowType) => {
    switch (type) {
      case "t2i":
        return <Wand2 className="w-5 h-5" />;
      case "i2i":
        return <Image className="w-5 h-5" />;
      case "upscale":
        return <Maximize2 className="w-5 h-5" />;
      case "inpaint":
        return <Paintbrush className="w-5 h-5" />;
      default:
        return <HelpCircle className="w-5 h-5" />;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-medium text-[var(--text-primary)]">
            Saved ComfyUI workflows
          </h2>
          <p className="text-sm text-[var(--text-secondary)]">
            Select a workflow to use in the Create view. Click the star to set
            a default.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
          className="btn btn-secondary flex items-center gap-1.5 text-xs flex-shrink-0"
          title="Reload the list (picks up workflows saved in ComfyUI)"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Runtime compatibility summary */}
      {!loading && !error && workflows.some((wf) => wf.runtime) && (
        <div className="card p-4">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-500" />
              <span className="text-sm text-[var(--text-primary)]">
                {
                  workflows.filter(
                    (wf) =>
                      wf.runtime?.checked &&
                      (wf.runtime.missingNodeTypes.length ?? 0) === 0,
                  ).length
                }{" "}
                runtime-ready
              </span>
            </div>
            {workflows.filter(
              (wf) => (wf.runtime?.missingNodeTypes.length ?? 0) > 0,
            ).length > 0 && (
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-500" />
                <span className="text-sm text-[var(--text-primary)]">
                  {
                    workflows.filter(
                      (wf) => (wf.runtime?.missingNodeTypes.length ?? 0) > 0,
                    ).length
                  }{" "}
                  with missing nodes
                </span>
              </div>
            )}
            {workflows.filter((wf) => wf.runtime && !wf.runtime.checked)
              .length > 0 && (
              <div
                className="flex items-center gap-2"
                title="Adrift couldn't read these workflows or reach ComfyUI to check their nodes."
              >
                <AlertCircle className="w-5 h-5 text-light-400 dark:text-dark-500" />
                <span className="text-sm text-[var(--text-primary)]">
                  {
                    workflows.filter((wf) => wf.runtime && !wf.runtime.checked)
                      .length
                  }{" "}
                  not checked
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="card p-4 bg-[var(--bg-tertiary)]">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-[var(--warning)] flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="font-medium text-[var(--text-primary)]">
              ComfyUI workflow directory
            </h4>
            <p className="text-sm text-[var(--text-secondary)] mt-1 break-all">
              {directory || "Loading..."}
            </p>
          </div>
        </div>
      </div>

      {installFlow.state.phase === "result" && installFlow.state.result ? (
        <button
          type="button"
          onClick={installFlow.dismissResult}
          className={`card p-4 text-left text-sm transition-colors ${
            installFlow.state.result.isError
              ? "text-red-500 dark:text-red-300"
              : "text-emerald-600 dark:text-emerald-300"
          }`}
        >
          <div className="flex items-start gap-3">
            {installFlow.state.result.isError ? (
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            ) : (
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            )}
            <span className="flex-1">{installFlow.state.result.message}</span>
            <X className="w-3.5 h-3.5 shrink-0 opacity-50 hover:opacity-100" />
          </div>
        </button>
      ) : null}

      {installFlow.state.phase === "confirming" && installFlow.state.pending ? (
        <div className="card p-4 text-sm text-[var(--text-secondary)] border-amber-500/30 bg-amber-500/10">
          <p className="font-medium text-amber-600 dark:text-amber-300">
            Queue missing-node install for{" "}
            {installFlow.state.pending.workflowName}?
          </p>
          <p className="mt-1 line-clamp-2 break-all">
            Packs: {installFlow.state.pending.packIds.join(", ")}
          </p>
          <p className="mt-1 opacity-75">
            Only unambiguous packs are queued. Restart ComfyUI after Manager
            finishes.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void installFlow.executeInstall()}
              className="inline-flex items-center gap-1.5 rounded-full bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white transition-transform active:scale-[0.97]"
            >
              <Download className="w-3 h-3" /> Confirm install
            </button>
            <button
              type="button"
              onClick={installFlow.cancelConfirm}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-primary)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            >
              <X className="w-3 h-3" /> Cancel
            </button>
          </div>
        </div>
      ) : null}

      {/* Per-button assignment lives on Setup › Button routing (kind-filtered,
          saved + built-in packs). Mappings made here before still apply. */}
      <button
        type="button"
        onClick={() => openSetupTab("routing")}
        className="card p-4 w-full text-left flex items-center gap-3 hover:bg-[var(--bg-hover)] transition-colors"
      >
        <Layers className="w-5 h-5 text-[var(--text-secondary)] flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-[var(--text-primary)]">
            Choose which workflow each button uses
          </div>
          <div className="text-sm text-[var(--text-secondary)]">
            Open Button routing to assign a saved workflow or a built-in pack
            to Vary, Upscale, Animate, 3D and more.
          </div>
        </div>
        <ChevronRight className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0" />
      </button>

      {loading ? (
        <div className="card p-6 text-sm text-[var(--text-secondary)] flex items-center gap-3">
          <Loader2 className="w-5 h-5 animate-spin" />
          Loading saved workflows…
        </div>
      ) : error ? (
        <StateView
          status="error"
          className="card"
          title="Couldn't load saved workflows"
          message={error}
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      ) : workflows.length === 0 ? (
        <div className="card p-6 text-sm text-[var(--text-secondary)] text-center space-y-3">
          <p>No workflows found. Save workflows in ComfyUI to see them here.</p>
          <p>Build or edit graphs in ComfyUI&apos;s editor — they show up here.</p>
          <button
            type="button"
            onClick={() => void handleEditInComfy(null)}
            className="btn btn-secondary inline-flex items-center gap-1.5 text-xs"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open ComfyUI
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {workflows.map((wf) => {
            const workflowPath = `saved:${wf.file}`;
            const isSelected = selectedWorkflowPath === workflowPath;

            return (
              <div
                key={wf.id}
                className={`card p-4 transition-all cursor-pointer hover:border-[var(--accent-primary)] ${isSelected ? "border-[var(--accent-primary)] ring-1 ring-[var(--accent-primary)]" : "border-[var(--border-secondary)]"}`}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={`w-12 h-12 rounded-lg flex items-center justify-center ${getTypeColorClasses(wf.type || "unknown")}`}
                  >
                    {getWorkflowIcon(wf.type || "unknown")}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium text-[var(--text-primary)] truncate">
                        {formatWorkflowName(wf.name)}
                      </h3>
                      {wf.isDefault && (
                        <Star
                          className="w-4 h-4 text-[var(--warning)] flex-shrink-0"
                          fill="currentColor"
                        />
                      )}
                    </div>
                    <p className="text-xs text-[var(--text-muted)] truncate">
                      {wf.file}
                    </p>
                    {/* Type badge */}
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <span
                        className={`chip text-xs ${getTypeColorClasses(wf.type || "unknown")}`}
                      >
                        {getTypeLabel(wf.type || "unknown")}
                      </span>
                      {wf.validation && !wf.validation.isApiRunnable && (
                        <span className="chip text-xs bg-red-500/20 text-red-400 border-red-500/30">
                          <XCircle className="w-3 h-3 mr-1" />
                          Issues
                        </span>
                      )}
                      {wf.validation?.isApiRunnable && (
                        <span className="chip text-xs bg-green-500/20 text-green-400 border-green-500/30">
                          <CheckCircle2 className="w-3 h-3 mr-1" />
                          Ready
                        </span>
                      )}
                      {/* Runtime compatibility badges */}
                      {wf.runtime?.checked &&
                        (wf.runtime.missingNodeTypes.length ?? 0) > 0 && (
                          <span className="chip text-xs bg-amber-500/20 text-amber-600 border-amber-500/30 dark:text-amber-300">
                            <AlertTriangle className="w-3 h-3 mr-1" />
                            {wf.runtime.missingNodeTypes.length} missing
                          </span>
                        )}
                      {wf.runtime?.checked &&
                        (wf.runtime.missingNodeTypes.length ?? 0) === 0 && (
                          <span className="chip text-xs bg-emerald-500/20 text-emerald-600 border-emerald-500/30 dark:text-emerald-300">
                            <CheckCircle2 className="w-3 h-3 mr-1" />
                            Runtime OK
                          </span>
                        )}
                      {wf.runtime?.error && (
                        <span
                          className="chip text-xs bg-light-400/20 text-light-400 dark:text-dark-500 border-light-400/30"
                          title={wf.runtime.error}
                        >
                          <AlertCircle className="w-3 h-3 mr-1" />
                          Check unavailable
                        </span>
                      )}
                    </div>
                    {/* Runtime missing nodes summary */}
                    {wf.runtime?.checked &&
                      (wf.runtime.missingNodeTypes.length ?? 0) > 0 && (
                        <div className="mt-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-[var(--text-secondary)]">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-amber-600 dark:text-amber-300">
                              <AlertTriangle className="w-3 h-3 inline mr-1" />
                              {wf.runtime.missingNodeTypes.length} missing node
                              {wf.runtime.missingNodeTypes.length === 1
                                ? ""
                                : "s"}
                            </span>
                            <span className="text-[var(--text-muted)] tabular-nums">
                              {wf.runtime.unambiguousInstallPackIds.length}{" "}
                              installable &middot;{" "}
                              {wf.runtime.ambiguousNodeTypes.length} ambiguous
                            </span>
                          </div>
                          <p className="mt-1 line-clamp-1 break-all text-[var(--text-muted)]">
                            {wf.runtime.missingNodeTypes.slice(0, 5).join(", ")}
                            {wf.runtime.missingNodeTypes.length > 5
                              ? ` +${wf.runtime.missingNodeTypes.length - 5} more`
                              : ""}
                          </p>
                        </div>
                      )}
                  </div>
                </div>

                {/* Required inputs preview */}
                {wf.requiredInputs && wf.requiredInputs.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {wf.requiredInputs.slice(0, 3).map((input, idx) => (
                      <span
                        key={idx}
                        className="text-xs px-2 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                      >
                        {input.type === "model" && (
                          <Box className="w-3 h-3 inline mr-1" />
                        )}
                        {input.type === "image" && (
                          <Image className="w-3 h-3 inline mr-1" />
                        )}
                        {input.type === "text" && (
                          <Wand2 className="w-3 h-3 inline mr-1" />
                        )}
                        {input.name}
                      </span>
                    ))}
                    {wf.requiredInputs.length > 3 && (
                      <span className="text-xs px-2 py-0.5 text-[var(--text-muted)]">
                        +{wf.requiredInputs.length - 3} more
                      </span>
                    )}
                  </div>
                )}

                <div className="mt-4 flex items-center gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleToggleDefault(wf);
                    }}
                    className={`btn-ghost btn-icon ${wf.isDefault ? "text-[var(--warning)]" : "text-[var(--text-secondary)]"}`}
                    title={wf.isDefault ? "Unset as default" : "Set as default"}
                  >
                    {wf.isDefault ? (
                      <Star className="w-4 h-4" fill="currentColor" />
                    ) : (
                      <StarOff className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePreview(wf);
                    }}
                    className="btn-ghost btn-icon text-[var(--text-secondary)]"
                    title="Preview workflow"
                  >
                    <Eye className="w-4 h-4" />
                  </button>
                  {/* Install missing nodes CTA */}
                  {wf.runtime?.checked &&
                    (wf.runtime.unambiguousInstallPackIds.length ?? 0) > 0 &&
                    (installFlow.state.phase === "confirming" &&
                    installFlow.state.pending?.workflowId === wf.id ? (
                      <span className="btn btn-secondary flex items-center gap-1 text-xs border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300 pointer-events-none">
                        Awaiting confirm…
                      </span>
                    ) : installFlow.state.phase === "installing" &&
                      installFlow.state.pending?.workflowId === wf.id ? (
                      <span className="btn btn-secondary flex items-center gap-1 text-xs border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 pointer-events-none">
                        <Loader2 className="w-3 h-3 animate-spin" /> Installing…
                      </span>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRequestInstall(wf);
                        }}
                        className="btn btn-secondary flex items-center gap-1 text-xs border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
                        title="Queue ComfyUI Manager install tasks for unambiguous missing node packs"
                      >
                        <Download className="w-3 h-3" />
                        Install nodes
                      </button>
                    ))}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleEditInComfy(wf);
                    }}
                    className="btn-ghost btn-icon text-[var(--text-secondary)]"
                    title="Edit in ComfyUI"
                    aria-label={`Edit ${formatWorkflowName(wf.name)} in ComfyUI`}
                  >
                    <ExternalLink className="w-4 h-4" />
                  </button>
                  <div className="flex-1" />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleUseWorkflow(wf);
                    }}
                    className={`btn ${isSelected ? "btn-primary" : "btn-secondary"}`}
                  >
                    {isSelected ? (
                      <>
                        <Check className="w-4 h-4 mr-1" />
                        Selected
                      </>
                    ) : (
                      <>
                        Use Workflow
                        <ChevronRight className="w-4 h-4 ml-1" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Workflow Preview Modal */}
      {previewWorkflow && (
        <WorkflowPreviewModal
          workflow={previewWorkflow}
          loading={previewLoading}
          onClose={() => setPreviewWorkflow(null)}
          onUseWorkflow={() => {
            handleUseWorkflow(previewWorkflow);
            setPreviewWorkflow(null);
          }}
          onEditInComfy={() => void handleEditInComfy(previewWorkflow)}
        />
      )}
    </div>
  );
}

interface WorkflowPreviewModalProps {
  workflow: WorkflowData;
  loading: boolean;
  onClose: () => void;
  onUseWorkflow: () => void;
  onEditInComfy: () => void;
}

function WorkflowPreviewModal({
  workflow,
  loading,
  onClose,
  onUseWorkflow,
  onEditInComfy,
}: WorkflowPreviewModalProps) {
  const isSelected =
    useUIStore((s) => s.selectedWorkflowPath) === `saved:${workflow.file}`;
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, true, {
    onEscape: onClose,
    label: `Workflow: ${formatWorkflowName(workflow.name)}`,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div
        ref={dialogRef}
        className="card max-w-3xl w-full max-h-[85vh] overflow-hidden flex flex-col"
      >
        <div className="flex items-center justify-between p-4 border-b border-[var(--border-primary)]">
          <div className="flex items-center gap-3">
            <div
              className={`w-10 h-10 rounded-lg flex items-center justify-center ${getTypeColorClasses(workflow.type || "unknown")}`}
            >
              {workflow.type === "t2i" && <Wand2 className="w-5 h-5" />}
              {workflow.type === "i2i" && <Image className="w-5 h-5" />}
              {workflow.type === "upscale" && <Maximize2 className="w-5 h-5" />}
              {workflow.type === "inpaint" && (
                <Paintbrush className="w-5 h-5" />
              )}
              {workflow.type === "unknown" && (
                <HelpCircle className="w-5 h-5" />
              )}
            </div>
            <div>
              <h2 className="font-semibold text-[var(--text-primary)]">
                {formatWorkflowName(workflow.name)}
              </h2>
              <p className="text-sm text-[var(--text-muted)]">
                {workflow.file}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="btn-ghost btn-icon"
            aria-label="Close workflow preview"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-[var(--text-secondary)]">
              <Loader2 className="w-6 h-6 animate-spin mr-2" />
              Analyzing workflow...
            </div>
          ) : (
            <div className="space-y-6">
              {/* Validation Status */}
              {workflow.validation && (
                <div className="card p-4 bg-[var(--bg-tertiary)]">
                  <div className="flex items-center gap-2 mb-3">
                    {workflow.validation.isApiRunnable ? (
                      <>
                        <CheckCircle2 className="w-5 h-5 text-[var(--success)]" />
                        <span className="font-medium text-[var(--text-primary)]">
                          API-Ready
                        </span>
                      </>
                    ) : (
                      <>
                        <AlertTriangle className="w-5 h-5 text-[var(--warning)]" />
                        <span className="font-medium text-[var(--text-primary)]">
                          Validation Issues
                        </span>
                      </>
                    )}
                  </div>
                  {workflow.validation.issues.length > 0 && (
                    <ul className="space-y-1">
                      {workflow.validation.issues.map((issue, idx) => (
                        <li
                          key={idx}
                          className={`text-sm flex items-start gap-2 ${issue.severity === "error" ? "text-red-400" : "text-[var(--text-secondary)]"}`}
                        >
                          {issue.severity === "error" ? (
                            <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                          ) : (
                            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                          )}
                          <span>{issue.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* Runtime Compatibility */}
              {workflow.runtime && (
                <div className="card p-4 bg-[var(--bg-tertiary)]">
                  <div className="flex items-center gap-2 mb-3">
                    {workflow.runtime.checked &&
                    (workflow.runtime.missingNodeTypes.length ?? 0) === 0 ? (
                      <>
                        <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                        <span className="font-medium text-[var(--text-primary)]">
                          All Nodes Available
                        </span>
                        <span className="text-sm text-[var(--text-muted)] ml-1">
                          ({workflow.runtime.runtimeNodeTypes} runtime types
                          found)
                        </span>
                      </>
                    ) : workflow.runtime.checked ? (
                      <>
                        <AlertTriangle className="w-5 h-5 text-amber-500" />
                        <span className="font-medium text-[var(--text-primary)]">
                          Missing Nodes
                        </span>
                        <span className="text-sm text-[var(--text-muted)] ml-1">
                          ({workflow.runtime.missingNodeTypes.length} of{" "}
                          {workflow.runtime.runtimeNodeTypes +
                            workflow.runtime.missingNodeTypes.length}{" "}
                          types missing)
                        </span>
                      </>
                    ) : (
                      <>
                        <AlertCircle className="w-5 h-5 text-light-400 dark:text-dark-500" />
                        <span className="font-medium text-[var(--text-primary)]">
                          Check Unavailable
                        </span>
                      </>
                    )}
                  </div>
                  {workflow.runtime.checked &&
                    workflow.runtime.missingNodeTypes.length > 0 && (
                      <div>
                        <ul className="space-y-1 mb-2">
                          {workflow.runtime.missingNodes.map((report, idx) => (
                            <li
                              key={idx}
                              className="text-sm flex items-start gap-2 text-[var(--text-secondary)]"
                            >
                              <XCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-amber-500" />
                              <span>
                                <code className="text-xs bg-[var(--bg-primary)] px-1 rounded">
                                  {report.nodeType}
                                </code>
                                {report.candidates.length === 0 && (
                                  <span className="text-red-400 ml-1">
                                    unresolved
                                  </span>
                                )}
                                {report.candidates.length === 1 && (
                                  <span className="text-emerald-500 ml-1">
                                    installable:{" "}
                                    {report.candidates[0].label ||
                                      report.candidates[0].id}
                                  </span>
                                )}
                                {report.candidates.length > 1 && (
                                  <span className="text-amber-500 ml-1">
                                    ambiguous ({report.candidates.length} packs)
                                  </span>
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                        {workflow.runtime.unambiguousInstallPackIds.length >
                          0 && (
                          <p className="text-xs text-[var(--text-muted)]">
                            {workflow.runtime.unambiguousInstallPackIds.length}{" "}
                            pack
                            {workflow.runtime.unambiguousInstallPackIds
                              .length === 1
                              ? ""
                              : "s"}{" "}
                            auto-installable &middot;{" "}
                            {workflow.runtime.ambiguousNodeTypes.length}{" "}
                            ambiguous &middot;{" "}
                            {workflow.runtime.unresolvedNodeTypes.length}{" "}
                            unresolved
                          </p>
                        )}
                      </div>
                    )}
                  {workflow.runtime.error && (
                    <p className="text-sm text-[var(--text-muted)]">
                      {workflow.runtime.error}
                    </p>
                  )}
                </div>
              )}

              {/* Structure Overview */}
              {workflow.structure && (
                <div>
                  <h3 className="font-medium text-[var(--text-primary)] mb-3">
                    Workflow Structure
                  </h3>
                  <div className="grid grid-cols-3 gap-4 mb-4">
                    <div className="card p-3 bg-[var(--bg-tertiary)]">
                      <div className="text-2xl font-semibold text-[var(--accent-primary)]">
                        {workflow.structure.nodeCount}
                      </div>
                      <div className="text-xs text-[var(--text-muted)]">
                        Nodes
                      </div>
                    </div>
                    <div className="card p-3 bg-[var(--bg-tertiary)]">
                      <div className="text-2xl font-semibold text-[var(--accent-primary)]">
                        {workflow.structure.connections}
                      </div>
                      <div className="text-xs text-[var(--text-muted)]">
                        Connections
                      </div>
                    </div>
                    <div className="card p-3 bg-[var(--bg-tertiary)]">
                      <div className="text-2xl font-semibold text-[var(--accent-primary)]">
                        {workflow.structure.nodeTypes.length}
                      </div>
                      <div className="text-xs text-[var(--text-muted)]">
                        Node Types
                      </div>
                    </div>
                  </div>

                  {/* Node Type Tags */}
                  <div className="flex flex-wrap gap-2">
                    {workflow.structure.nodeTypes.map((type) => (
                      <span
                        key={type}
                        className="text-xs px-2 py-1 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border border-[var(--border-secondary)]"
                      >
                        {type}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Required Inputs */}
              {workflow.requiredInputs &&
                workflow.requiredInputs.length > 0 && (
                  <div>
                    <h3 className="font-medium text-[var(--text-primary)] mb-3">
                      Required Inputs
                    </h3>
                    <div className="space-y-2">
                      {workflow.requiredInputs.map((input, idx) => (
                        <div
                          key={idx}
                          className="flex items-center gap-3 p-3 rounded-lg bg-[var(--bg-tertiary)]"
                        >
                          <div
                            className={`w-8 h-8 rounded-lg flex items-center justify-center ${input.type === "model" ? "bg-blue-500/20 text-blue-400" : input.type === "image" || input.type === "mask" ? "bg-purple-500/20 text-purple-400" : input.type === "text" ? "bg-green-500/20 text-green-400" : "bg-light-400/20 text-light-400 dark:text-dark-500"}`}
                          >
                            {input.type === "model" && (
                              <Box className="w-4 h-4" />
                            )}
                            {input.type === "image" && (
                              <Image className="w-4 h-4" />
                            )}
                            {input.type === "mask" && (
                              <Paintbrush className="w-4 h-4" />
                            )}
                            {input.type === "text" && (
                              <Wand2 className="w-4 h-4" />
                            )}
                            {input.type === "latent" && (
                              <Maximize2 className="w-4 h-4" />
                            )}
                            {input.type === "number" && (
                              <Layers className="w-4 h-4" />
                            )}
                            {input.type === "string" && (
                              <FileJson className="w-4 h-4" />
                            )}
                          </div>
                          <div className="flex-1">
                            <div className="font-medium text-[var(--text-primary)]">
                              {input.name}
                            </div>
                            <div className="text-xs text-[var(--text-muted)]">
                              {input.description}
                            </div>
                          </div>
                          <span className="chip text-xs">{input.type}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              {/* Node List */}
              {workflow.structure?.nodes &&
                workflow.structure.nodes.length > 0 && (
                  <div>
                    <h3 className="font-medium text-[var(--text-primary)] mb-3">
                      Nodes ({workflow.structure.nodes.length})
                    </h3>
                    <div className="max-h-64 overflow-y-auto space-y-1">
                      {workflow.structure.nodes.map((node) => (
                        <div
                          key={node.id}
                          className="flex items-center gap-3 p-2 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] transition-colors"
                        >
                          <span className="text-xs font-mono text-[var(--accent-primary)] bg-[var(--bg-primary)] px-1.5 py-0.5 rounded">
                            {node.id}
                          </span>
                          <span className="text-sm text-[var(--text-primary)]">
                            {node.type}
                          </span>
                          {node.inputs.length > 0 && (
                            <span className="text-xs text-[var(--text-muted)] ml-auto">
                              {node.inputs.length} input
                              {node.inputs.length !== 1 ? "s" : ""}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 p-4 border-t border-[var(--border-primary)]">
          <button onClick={onClose} className="btn btn-secondary">
            Close
          </button>
          <button
            type="button"
            onClick={onEditInComfy}
            className="btn btn-secondary flex items-center"
          >
            <ExternalLink className="w-4 h-4 mr-2" />
            Edit in ComfyUI
          </button>
          <button
            onClick={onUseWorkflow}
            className={`btn ${isSelected ? "btn-primary" : "btn-secondary"}`}
          >
            {isSelected ? (
              <>
                <Check className="w-4 h-4 mr-2" />
                Currently Selected
              </>
            ) : (
              <>
                Use This Workflow
                <ChevronRight className="w-4 h-4 ml-2" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ImportExport() {
  const aliases = useModelStore((s) => s.aliases);
  const defaultModel = useModelStore((s) => s.defaultModel);
  const defaultVae = useModelStore((s) => s.defaultVae);
  const defaultLoras = useModelStore((s) => s.defaultLoras);
  const addAlias = useModelStore((s) => s.addAlias);
  const updateAlias = useModelStore((s) => s.updateAlias);
  const setDefaultModel = useModelStore((s) => s.setDefaultModel);
  const setDefaultVae = useModelStore((s) => s.setDefaultVae);
  const setDefaultLoras = useModelStore((s) => s.setDefaultLoras);

  const [importStatus, setImportStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const handleExport = () => {
    const data = {
      version: "1.0",
      aliases,
      defaults: { model: defaultModel, vae: defaultVae, loras: defaultLoras },
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "adrift-config.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportStatus(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string) as {
          aliases?: ModelAlias[];
          defaults?: {
            model?: string | null;
            vae?: string | null;
            loras?: typeof defaultLoras;
          };
        };

        let importedAliases = 0;
        if (Array.isArray(data.aliases)) {
          for (const alias of data.aliases) {
            if (!alias?.alias || !alias.filename || !alias.type) continue;
            if (aliases.some((existing) => existing.alias === alias.alias)) {
              updateAlias(alias.alias, alias);
            } else {
              addAlias(alias);
            }
            importedAliases += 1;
          }
        }

        if (data.defaults) {
          setDefaultModel(data.defaults.model ?? null);
          setDefaultVae(data.defaults.vae ?? null);
          if (Array.isArray(data.defaults.loras)) {
            setDefaultLoras(data.defaults.loras);
          }
        }

        const successMsg = `Imported ${importedAliases} alias${importedAliases === 1 ? "" : "es"} and default model settings.`;
        showToast(successMsg, "success");
        setImportStatus({ type: "success", message: successMsg });
      } catch {
        const errMsg = "Invalid config file";
        showToast(errMsg, "error");
        setImportStatus({ type: "error", message: errMsg });
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-[var(--text-primary)]">
          Import / Export
        </h2>
        <p className="text-sm text-[var(--text-secondary)]">
          Backup or restore your aliases and settings
        </p>
      </div>
      <div className="grid grid-cols-2 gap-6">
        <div className="card p-6">
          <Download className="w-8 h-8 text-[var(--accent-primary)] mb-4" />
          <h3 className="font-medium text-[var(--text-primary)] mb-2">
            Export Configuration
          </h3>
          <p className="text-sm text-[var(--text-secondary)] mb-4">
            Download your aliases and settings as a JSON file
          </p>
          <button onClick={handleExport} className="btn btn-primary w-full">
            Export
          </button>
        </div>
        <div className="card p-6">
          <Upload className="w-8 h-8 text-[var(--accent-primary)] mb-4" />
          <h3 className="font-medium text-[var(--text-primary)] mb-2">
            Import Configuration
          </h3>
          <p className="text-sm text-[var(--text-secondary)] mb-4">
            Restore aliases and settings from a backup file
          </p>
          <label className="btn btn-secondary w-full cursor-pointer">
            Import
            <input
              type="file"
              accept=".json"
              onChange={handleImport}
              className="hidden"
            />
          </label>
          {importStatus && (
            <div
              className={`mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                importStatus.type === "success"
                  ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200"
                  : "bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-200"
              }`}
              role="status"
              aria-live="polite"
            >
              {importStatus.type === "success" ? (
                <CheckCircle2 className="h-4 w-4 shrink-0" />
              ) : (
                <AlertCircle className="h-4 w-4 shrink-0" />
              )}
              <span>{importStatus.message}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

