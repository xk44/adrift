"use client";

import { useMemo, useRef, useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { useOverlayStore } from "@/store";
import { OverlayToolsLauncher } from "@/components/OverlayToolsLauncher";
import { requestHostLayout } from "@/hooks/useOverlayMode";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronDown,
  Circle,
  Layers,
  Maximize2,
  PanelRight,
  Send,
  Settings,
  X,
  Zap,
} from "lucide-react";

const OverlaySettingsPanel = dynamic(
  () =>
    import("@/components/OverlaySettingsPanel").then((m) => ({
      default: m.OverlaySettingsPanel,
    })),
  { ssr: false },
);

interface OverlayTopBarProps {
  onBack: () => void;
  onSendWorkflow: (workflow: unknown) => void;
  onUseWorkflow: (workflow: unknown, name: string) => void;
}

/** Extract unique node class names from a UI- or API-format workflow */
function workflowNodeTypes(workflow: unknown): string[] {
  if (!workflow || typeof workflow !== "object") return [];
  const wf = workflow as Record<string, unknown>;
  const types: string[] = [];
  if (Array.isArray(wf.nodes)) {
    for (const n of wf.nodes as Array<Record<string, unknown>>) {
      if (typeof n.type === "string" && !types.includes(n.type))
        types.push(n.type);
    }
  } else {
    for (const val of Object.values(wf)) {
      if (val && typeof val === "object" && "class_type" in val) {
        const ct = (val as Record<string, unknown>).class_type;
        if (typeof ct === "string" && !types.includes(ct)) types.push(ct);
      }
    }
  }
  return types;
}

/**
 * top bar shown when CJ runs embedded in ComfyUI (overlay mode).
 * One quiet row: status · back · workflow pill (details in popover) · progress · settings.
 */
export function OverlayTopBar({
  onBack,
  onSendWorkflow,
  onUseWorkflow,
}: OverlayTopBarProps) {
  const overlayWorkflow = useOverlayStore((s) => s.overlayWorkflow);
  const overlayWorkflowName = useOverlayStore((s) => s.overlayWorkflowName);
  const workflowAccepted = useOverlayStore((s) => s.workflowAccepted);
  const dismissWorkflow = useOverlayStore((s) => s.dismissWorkflow);
  const progress = useOverlayStore((s) => s.progress);
  const bridgePhase = useOverlayStore((s) => s.bridgePhase);
  const overlaySettings = useOverlayStore((s) => s.overlaySettings);
  const settingsPanelOpen = useOverlayStore((s) => s.settingsPanelOpen);
  const setSettingsPanelOpen = useOverlayStore((s) => s.setSettingsPanelOpen);
  const syncConflict = useOverlayStore((s) => s.syncConflict);
  const acceptRemoteWorkflow = useOverlayStore((s) => s.acceptRemoteWorkflow);
  const keepLocalWorkflow = useOverlayStore((s) => s.keepLocalWorkflow);
  const selectedNode = useOverlayStore((s) => s.selectedNode);
  const connectionQuality = useOverlayStore((s) => s.connectionQuality);
  const bridgeLatency = useOverlayStore((s) => s.bridgeLatency);
  const hostLayout = useOverlayStore((s) => s.hostLayout);

  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsRef = useRef<HTMLDivElement>(null);

  // Close the workflow popover on outside click / Escape
  useEffect(() => {
    if (!detailsOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (!detailsRef.current?.contains(e.target as Node))
        setDetailsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetailsOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [detailsOpen]);

  const nodeTypes = useMemo(
    () => workflowNodeTypes(overlayWorkflow),
    [overlayWorkflow],
  );

  const connected = bridgePhase === "ready";
  const connecting =
    bridgePhase === "configured" || bridgePhase === "hello-sent";

  const statusTitle = !connected
    ? connecting
      ? "Connecting..."
      : bridgePhase === "error"
        ? "Connection error"
        : "Disconnected"
    : connectionQuality === "degraded"
      ? `Slow connection (${bridgeLatency ?? "?"}ms)`
      : connectionQuality === "poor"
        ? `Poor connection (${bridgeLatency ?? "?"}ms)`
        : `Connected (${bridgeLatency ?? "?"}ms)`;

  const statusColor = !connected
    ? connecting
      ? "text-yellow-500"
      : "text-red-500"
    : connectionQuality === "degraded"
      ? "text-yellow-500"
      : connectionQuality === "poor"
        ? "text-red-500"
        : "text-green-500";

  const workflowName = overlayWorkflowName ?? "ComfyUI Workflow";

  return (
    <div className="flex items-center gap-2 px-4 h-12 flex-shrink-0 border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] relative">
      {/* Back to ComfyUI */}
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 pl-2 pr-3 py-1.5 rounded-full text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
        title="Back to ComfyUI (Ctrl+Shift+J)"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        ComfyUI
      </button>

      {/* Bridge status */}
      <div className="flex items-center" title={statusTitle}>
        <Circle className={`w-2 h-2 fill-current ${statusColor}`} />
      </div>

      {/* Tools launcher: run a tool on the image selected in the graph */}
      <OverlayToolsLauncher connected={connected} />

      {/* Workflow pill — name + popover with details */}
      {!!overlayWorkflow && (
        <div className="relative" ref={detailsRef}>
          <div
            className={`flex items-center gap-1.5 pl-3 pr-1.5 py-1 rounded-full border transition-colors ${
              workflowAccepted
                ? "bg-[var(--success)]/10 border-[var(--success)]/30"
                : "bg-[var(--bg-tertiary)] border-[var(--border-primary)]"
            }`}
          >
            {workflowAccepted ? (
              <Check className="w-3 h-3 text-[var(--success)]" />
            ) : (
              <Layers className="w-3 h-3 text-[var(--text-muted)]" />
            )}
            <button
              onClick={() => setDetailsOpen((o) => !o)}
              className="flex items-center gap-1 text-xs font-medium text-[var(--text-primary)] max-w-[220px]"
              title={workflowName}
              aria-expanded={detailsOpen}
            >
              <span className="truncate">{workflowName}</span>
              <span className="text-[10px] text-[var(--text-muted)] tabular-nums">
                {nodeTypes.length}
              </span>
              <ChevronDown
                className={`w-3 h-3 text-[var(--text-muted)] transition-transform ${detailsOpen ? "rotate-180" : ""}`}
              />
            </button>
            {!workflowAccepted && (
              <button
                onClick={() => onUseWorkflow(overlayWorkflow, workflowName)}
                className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-[var(--accent-primary)] text-white hover:opacity-85 transition-opacity"
              >
                Use
              </button>
            )}
            <button
              onClick={dismissWorkflow}
              className="p-1 rounded-full text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              title="Dismiss workflow"
              aria-label="Dismiss workflow"
            >
              <X className="w-3 h-3" />
            </button>
          </div>

          {detailsOpen && (
            <div className="absolute top-full left-0 mt-2 w-80 p-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] shadow-xl z-50">
              <div className="text-[10px] text-[var(--text-muted)] mb-2">
                Nodes ({nodeTypes.length})
              </div>
              <div className="flex flex-wrap gap-1 max-h-40 overflow-y-auto noScrollbar">
                {nodeTypes.map((ct) => (
                  <span
                    key={ct}
                    className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[var(--bg-tertiary)] text-[var(--text-muted)] border border-[var(--border-primary)]"
                  >
                    {ct}
                  </span>
                ))}
              </div>
              {connected && (
                <button
                  onClick={() => {
                    onSendWorkflow(overlayWorkflow);
                    setDetailsOpen(false);
                  }}
                  className="mt-3 w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] transition-colors"
                  title="Send current workflow to the ComfyUI graph editor"
                >
                  <Send className="w-3 h-3" />
                  Send to ComfyUI
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Selected node indicator */}
      {selectedNode && selectedNode.nodeId >= 0 && (
        <div
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-primary)]"
          title={`Selected in ComfyUI: ${selectedNode.nodeTitle}`}
        >
          <Zap className="w-3 h-3 text-[var(--text-muted)]" />
          <span className="text-[10px] font-mono text-[var(--text-secondary)] truncate max-w-[150px]">
            {selectedNode.nodeType}
          </span>
        </div>
      )}

      {/* Sync conflict banner */}
      {syncConflict && (
        <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30">
          <AlertCircle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
          <span className="text-xs text-amber-500 font-medium whitespace-nowrap">
            ComfyUI workflow changed
          </span>
          <button
            onClick={acceptRemoteWorkflow}
            className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors"
          >
            Accept
          </button>
          <button
            onClick={keepLocalWorkflow}
            className="px-2 py-0.5 rounded-full text-[10px] font-medium text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            Keep Mine
          </button>
        </div>
      )}

      {/* Right side: progress + settings */}
      <div className="flex items-center gap-2 ml-auto">
        {progress && overlaySettings.showComfyProgress && (
          <div className="flex items-center gap-2">
            <div className="w-24 h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
              <div
                className="h-full bg-[var(--accent-primary)] rounded-full transition-all duration-300"
                style={{
                  width: `${Math.round((progress.value / progress.max) * 100)}%`,
                }}
              />
            </div>
            <span className="text-xs text-[var(--text-muted)] tabular-nums">
              {progress.value}/{progress.max}
            </span>
          </div>
        )}

        {/* Full viewport <-> docked panel. Only hosts that report a layout
            (cj:layout) understand cj:set-layout, so older ones show nothing. */}
        {hostLayout && (
          <button
            type="button"
            onClick={() =>
              requestHostLayout(hostLayout === "panel" ? "full" : "panel")
            }
            className="p-1.5 rounded-full text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
            title={
              hostLayout === "panel"
                ? "Expand to full screen"
                : "Dock as side panel over the graph"
            }
            aria-label={
              hostLayout === "panel"
                ? "Expand overlay to full screen"
                : "Dock overlay as side panel"
            }
          >
            {hostLayout === "panel" ? (
              <Maximize2 className="w-3.5 h-3.5" />
            ) : (
              <PanelRight className="w-3.5 h-3.5" />
            )}
          </button>
        )}

        <button
          onClick={() => setSettingsPanelOpen(!settingsPanelOpen)}
          className={`p-1.5 rounded-full text-xs transition-colors ${
            settingsPanelOpen
              ? "text-[var(--accent-primary)] bg-[var(--accent-primary)]/10"
              : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          }`}
          title="Overlay settings"
          aria-label="Overlay settings"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Overlay settings dropdown */}
      {settingsPanelOpen && <OverlaySettingsPanel />}
    </div>
  );
}
