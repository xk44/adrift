"use client";

/**
 * "Show graph": builds the tool's exact ComfyUI API workflow with the job
 * route's dry_run mode (nothing is queued, no GPU time) and shows it in a
 * modal with a Copy button. For people who want to see or reuse the graph
 * in ComfyUI. Native <dialog>: focus trapped, Esc closes.
 */
import { useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, Network, X } from "lucide-react";
import type { ApiWorkflowJson } from "@/lib/tools/runTool";
import { graphJson, graphSummary } from "@/lib/tools/graphPreview";

const BUTTON =
  "w-full flex items-center justify-center gap-1.5 rounded-xl border border-light-100 dark:border-dark-750 bg-light-input dark:bg-dark-input px-3 py-2 text-xs font-medium text-light-primary dark:text-dark-primary hover:opacity-85 disabled:opacity-50 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-splash";

/** Modal body (summary, node classes, JSON, copy). Exported for tests. */
export function GraphPreviewBody({
  workflow,
  copied,
  onCopy,
}: {
  workflow: ApiWorkflowJson;
  copied: boolean;
  onCopy: () => void;
}) {
  const { nodeCount, classes } = graphSummary(workflow);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p
          data-testid="graph-node-count"
          className="text-[12px] text-light-500 dark:text-dark-400"
        >
          {nodeCount} node{nodeCount === 1 ? "" : "s"} · ComfyUI API format ·
          nothing was queued
        </p>
        <button
          type="button"
          onClick={onCopy}
          data-testid="graph-copy"
          className="inline-flex flex-shrink-0 items-center gap-1 rounded-lg bg-splash/10 px-2 py-1 text-[11px] font-semibold text-splash transition-colors hover:bg-splash/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-splash"
        >
          {copied ? (
            <Check className="h-3 w-3" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
          {copied ? "Copied" : "Copy JSON"}
        </button>
      </div>
      <ul className="flex flex-wrap gap-1" aria-label="Node types">
        {classes.map((c) => (
          <li
            key={c.classType}
            className="rounded-full bg-light-input px-2 py-0.5 font-mono text-[10px] text-light-primary dark:bg-dark-input dark:text-dark-primary"
          >
            {c.classType}
            {c.count > 1 ? ` ×${c.count}` : ""}
          </li>
        ))}
      </ul>
      <pre
        data-testid="graph-json"
        tabIndex={0}
        className="max-h-[50dvh] overflow-auto rounded-xl bg-light-input p-3 font-mono text-[11px] leading-relaxed text-light-primary dark:bg-dark-input dark:text-dark-primary"
      >
        {graphJson(workflow)}
      </pre>
      <p className="text-[11px] text-light-500 dark:text-dark-400">
        Save it as a .json file to open or tweak it in ComfyUI. Your images
        appear as uploaded file names.
      </p>
    </div>
  );
}

export function ShowGraphButton({
  title,
  build,
  disabled,
}: {
  title: string;
  /** Dry-run build (exportActionToolWorkflow / exportCatalogToolWorkflow). */
  build: () => Promise<ApiWorkflowJson>;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [workflow, setWorkflow] = useState<ApiWorkflowJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    } else if (!open && d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    }
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  const show = async () => {
    setBusy(true);
    setError(null);
    setWorkflow(null);
    setOpen(true);
    try {
      setWorkflow(await build());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    if (!workflow) return;
    try {
      navigator.clipboard.writeText(graphJson(workflow)).then(
        () => setCopied(true),
        () => {},
      );
    } catch {
      /* no clipboard API (insecure origin): the JSON stays selectable */
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void show()}
        disabled={disabled || busy}
        className={BUTTON}
        data-testid="show-graph"
        aria-haspopup="dialog"
        title="See the exact ComfyUI graph this run would queue, without running it"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Network className="h-3.5 w-3.5" />
        )}
        Show graph
      </button>
      <dialog
        ref={ref}
        aria-labelledby="graph-preview-title"
        data-testid="graph-preview"
        onClose={() => setOpen(false)}
        onCancel={(e) => {
          e.preventDefault();
          setOpen(false);
        }}
        onClick={(e) => {
          if (e.target === ref.current) setOpen(false);
        }}
        className="m-auto w-[min(720px,calc(100vw-32px))] max-w-full overflow-hidden rounded-2xl bg-light-bg p-0 text-light-primary shadow-2xl backdrop:bg-black/50 dark:bg-dark-bg dark:text-dark-primary"
      >
        <div className="flex max-h-[85dvh] flex-col">
          <header className="flex items-center gap-3 border-b border-light-100 px-4 py-3 dark:border-dark-750">
            <Network className="h-4 w-4 flex-shrink-0 text-splash" />
            <h2
              id="graph-preview-title"
              className="min-w-0 flex-1 truncate text-[15px] font-semibold"
            >
              {title} graph
            </h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="rounded-lg p-1.5 text-light-500 hover:bg-light-100 hover:text-light-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-splash dark:text-dark-400 dark:hover:bg-dark-750 dark:hover:text-dark-primary"
            >
              <X className="h-4 w-4" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <p aria-live="polite" className="sr-only">
              {copied ? "Copied to clipboard" : ""}
            </p>
            {busy && (
              <p
                role="status"
                className="flex items-center gap-2 text-[13px] text-light-500 dark:text-dark-400"
              >
                <Loader2 className="h-4 w-4 animate-spin" /> Building the
                graph...
              </p>
            )}
            {error && (
              <p
                role="alert"
                className="text-[13px] text-red-600 dark:text-red-400"
              >
                {error}
              </p>
            )}
            {workflow && (
              <GraphPreviewBody
                workflow={workflow}
                copied={copied}
                onCopy={copy}
              />
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}
