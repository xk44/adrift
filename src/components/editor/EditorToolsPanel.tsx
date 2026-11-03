"use client";

/**
 * Edit page "Tools" panel: the lightbox Tools list (same rows, same look),
 * run on the current canvas. Inline rows queue straight from here; the rest
 * open their Tools page card with the canvas (and the selection, for tools
 * that take a mask) preloaded. Results come back via useEditorToolReturns.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { useGenerationStore, useUIStore } from "@/store";
import { useEditorStore } from "@/store/editorStore";
import { useToolHandoffStore } from "@/store/toolHandoffStore";
import { useOverlayToolsStore } from "@/store/overlayToolsStore";
import { navigateTo } from "@/hooks/useNavSync";
import { showToast, toastNodeWarnings } from "@/components/Toast";
import {
  InlineToolRow,
  OpenToolRow,
  loadToolCatalog,
} from "@/components/LightboxToolsPanel";
import { urlToDataUrl } from "@/components/tools/ToolImageInput";
import type { CatalogTool } from "@/lib/tools/toolsPage";
import type { InlineRun } from "@/lib/ui/lightboxTools";
import { sourceRunFor } from "@/lib/tools/runTool";
import {
  buildEditorTools,
  editorHandoff,
  editorSourceRun,
  filterEditorTools,
  groupEditorTools,
  type EditorSourceRun,
  type EditorTool,
} from "@/lib/editorTools";
import { editorMaskBinaryDataUrl } from "@/lib/editorMask";
import { userToolEditorEntries } from "@/lib/userTools/registry";
import { useUserTools } from "@/store/userToolsStore";
import {
  mergeActionAndSlotAssignments,
  resolveWorkflowForAction,
} from "@/lib/workflowAssignments";

const MASK_NOTE = {
  region: "Selection",
  inpaint: "Selection",
} as const;

const runKey = (run: InlineRun) =>
  run.kind === "action" ? `action:${run.action}` : run.kind;

export function EditorToolsPanel({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<CatalogTool[] | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    void loadToolCatalog().then((tools) => {
      if (live) setCatalog(tools);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const userTools = useUserTools();
  const all = useMemo(
    () => [...buildEditorTools(catalog), ...userToolEditorEntries(userTools)],
    [catalog, userTools],
  );
  const sections = useMemo(
    () => groupEditorTools(filterEditorTools(all, query)),
    [all, query],
  );
  const byKey = useMemo(() => new Map(all.map((t) => [t.key, t])), [all]);

  /** Run behind the canvas; uploads / pastes are seeded once. */
  const canvasRun = useCallback(
    async (title: string): Promise<EditorSourceRun> => {
      const editor = useEditorStore.getState();
      const known = editorSourceRun(
        editor.sourceRun,
        editor.sourceImageId,
        useGenerationStore.getState().gallery,
      );
      if (known) return known;
      const url = editor.sourceImage;
      if (!url) throw new Error("Load an image first.");
      const dataUrl = url.startsWith("data:") ? url : await urlToDataUrl(url);
      const dims = editor.sourceDimensions;
      const seeded = await sourceRunFor(
        fetch,
        {
          id: `editor:${Date.now()}`,
          source: "upload",
          previewUrl: url,
          dataUrl,
          label: "Editor canvas",
          width: dims?.width ?? 0,
          height: dims?.height ?? 0,
        },
        title,
      );
      // Reuse the seeded run for the next tool on the same canvas.
      if (useEditorStore.getState().sourceImage === url)
        useEditorStore.setState({ sourceRun: seeded });
      return seeded;
    },
    [],
  );

  const runInline = useCallback(
    async (tool: EditorTool, run: InlineRun) => {
      if (run.kind !== "action") return;
      const key = runKey(run);
      setRunning((prev) => new Set(prev).add(key));
      const variant =
        tool.target.kind === "inline"
          ? tool.target.variants.find((v) => runKey(v.run) === key)
          : undefined;
      const title =
        variant?.label && variant.label !== tool.title
          ? `${tool.title}: ${variant.label}`
          : tool.title;
      try {
        const src = await canvasRun(title);
        const ui = useUIStore.getState();
        const workflowPath = resolveWorkflowForAction(run.action, {
          assignments: mergeActionAndSlotAssignments(ui.actionWorkflowMap),
          selectedWorkflowPath: ui.selectedWorkflowPath,
          selectedWorkflowName: ui.selectedWorkflowName,
          defaultWorkflowPath: ui.defaultWorkflowPath,
          defaultWorkflowName: ui.defaultWorkflowName,
        })?.workflowPath;
        const overrides = ui.workflowControlOverrides;
        const gen = useGenerationStore.getState();
        const response = await fetch("/api/jobs/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            run_id: src.runId,
            job_index: src.jobIndex,
            action: run.action,
            client_id: gen.clientId,
            workflow_path: workflowPath,
            params: run.params,
            ...(overrides && Object.keys(overrides).length > 0
              ? { workflow_control_overrides: overrides }
              : {}),
          }),
        });
        const data = await response.json();
        if (!data.ok || !data.run)
          throw new Error(data.error ?? `${title} failed to queue`);
        gen.addRun(data.run);
        useEditorStore.getState().trackToolRun({
          runId: data.run.run_id,
          title,
          origin: "inline",
          at: Date.now(),
        });
        toastNodeWarnings(data);
        showToast(
          tool.output === "image"
            ? `${title} queued. The result comes back here as a new layer.`
            : `${title} queued. It opens when ready.`,
          "success",
        );
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e), "error", 8000);
      } finally {
        setRunning((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [canvasRun],
  );

  const openTool = useCallback(
    (toolKey: string) => {
      const tool = byKey.get(toolKey);
      const editor = useEditorStore.getState();
      if (!tool || !editor.sourceImage) return;
      const mask = tool.mask
        ? editorMaskBinaryDataUrl(editor.maskCanvas)
        : null;
      const handoff = editorHandoff(
        tool,
        {
          url: editor.sourceImage,
          id: editor.sourceImageId,
          width: editor.sourceDimensions?.width ?? 0,
          height: editor.sourceDimensions?.height ?? 0,
          run: editorSourceRun(
            editor.sourceRun,
            editor.sourceImageId,
            useGenerationStore.getState().gallery,
          ),
        },
        mask,
        Date.now(),
      );
      useToolHandoffStore.getState().offer(handoff);
      useOverlayToolsStore.getState().openToolFromLauncher(toolKey, false);
      onClose();
      navigateTo("tools");
    },
    [byKey, onClose],
  );

  return (
    <div
      id="editor-tools-panel"
      data-editor-tools
      role="dialog"
      aria-label="Tools"
      className="fixed inset-x-4 top-24 z-40 space-y-2 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 shadow-xl md:absolute md:inset-x-auto md:left-full md:top-2 md:ml-2 md:w-80"
    >
      <div className="flex items-center gap-2">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg bg-[var(--bg-secondary)] px-2.5 focus-within:ring-1 focus-within:ring-[var(--border-secondary)]">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools"
            aria-label="Search tools"
            className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus-visible:outline-none"
          />
          <kbd className="hidden md:inline text-[10px] text-[var(--text-muted)]">
            Esc
          </kbd>
        </label>
        <button
          type="button"
          onClick={onClose}
          className="btn-ghost btn-icon"
          title="Close tools"
          aria-label="Close tools"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="px-2 text-[11px] text-[var(--text-muted)]">
        Runs on the canvas. Tools tagged Selection use your painted area;
        image results return as a new layer.
      </p>

      <div className="max-h-[min(30rem,65dvh)] space-y-4 overflow-y-auto overscroll-contain pr-0.5">
        {sections.length === 0 && (
          <p className="px-2 py-3 text-xs text-[var(--text-muted)]">
            {query ? `Nothing matches "${query}".` : "Loading tools..."}
          </p>
        )}
        {sections.map((section) => (
          <section
            key={section.output}
            aria-label={section.label}
            data-editor-tools-section={section.output}
          >
            <h3 className="px-2 pb-1 text-xs font-semibold text-[var(--text-primary)]">
              {section.label}
            </h3>
            <div className="space-y-2">
              {section.groups.map(({ group, tools }) => (
                <div key={group} aria-label={`${section.label}: ${group}`}>
                  {group !== section.label && (
                    <h4 className="px-2 pb-1 text-[10px] font-medium text-[var(--text-muted)]">
                      {group}
                    </h4>
                  )}
                  <ul className="space-y-0.5">
                    {(tools as EditorTool[]).map((t) =>
                      t.target.kind === "inline" ? (
                        <InlineToolRow
                          key={t.key}
                          tool={t}
                          onRun={(run) => void runInline(t, run)}
                          isRunning={(run) => running.has(runKey(run))}
                        />
                      ) : (
                        <OpenToolRow
                          key={t.key}
                          tool={t}
                          onOpenTool={openTool}
                          note={t.mask ? MASK_NOTE[t.mask] : undefined}
                          openTitle={`Open ${t.title} with the canvas${t.mask ? " and selection" : ""}`}
                        />
                      ),
                    )}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export default EditorToolsPanel;
