"use client";

/**
 * Renders the outputs the media pipeline drops: text (PreviewAny / ShowText),
 * latents and unknown custom-node payloads — and, for jobs that produced no
 * image/video/mesh at all, audio. Data comes from /api/comfy/history, whose
 * `outputs` list is built by lib/comfy/outputs.ts extractOutputs().
 */

import { memo, useEffect, useState } from "react";
import { Check, Copy, Download, FileText, Braces } from "lucide-react";
import type { ComfyOutputKind } from "@/lib/comfy/outputs";

export interface HistoryOutput {
  nodeId: string;
  nodeTitle: string;
  kind: ComfyOutputKind;
  key: string;
  text?: string;
  raw?: unknown;
  url?: string;
  view?: { filename: string };
}

const historyCache = new Map<string, Promise<HistoryOutput[]>>();

function loadOutputs(promptId: string): Promise<HistoryOutput[]> {
  const cached = historyCache.get(promptId);
  if (cached) return cached;
  const pending = fetch(`/api/comfy/history/${encodeURIComponent(promptId)}`)
    .then((res) => (res.ok ? res.json() : null))
    .then((data: { outputs?: HistoryOutput[] } | null) =>
      Array.isArray(data?.outputs) ? data!.outputs : [],
    )
    .catch(() => {
      historyCache.delete(promptId);
      return [] as HistoryOutput[];
    });
  historyCache.set(promptId, pending);
  if (historyCache.size > 200) {
    const oldest = historyCache.keys().next().value;
    if (oldest !== undefined) historyCache.delete(oldest);
  }
  return pending;
}

export function useHistoryOutputs(
  promptId: string | undefined,
  enabled = true,
): HistoryOutput[] {
  const [outputs, setOutputs] = useState<HistoryOutput[]>([]);
  useEffect(() => {
    if (!promptId || !enabled) {
      setOutputs([]);
      return;
    }
    let cancelled = false;
    void loadOutputs(promptId).then((list) => {
      if (!cancelled) setOutputs(list);
    });
    return () => {
      cancelled = true;
    };
  }, [promptId, enabled]);
  return outputs;
}

function prettyRaw(raw: unknown): string {
  try {
    return JSON.stringify(raw, null, 2) ?? String(raw);
  } catch {
    return String(raw);
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="p-1 rounded hover:bg-white/10 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      aria-label="Copy output"
      title="Copy"
    >
      {copied ? (
        <Check className="w-3.5 h-3.5" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
    </button>
  );
}

export interface ExtraOutputListProps {
  outputs: HistoryOutput[];
  /** Also render audio players (for jobs whose media slots are empty). */
  includeAudio?: boolean;
  compact?: boolean;
}

/** Pure renderer — exported for tests and callers that already hold outputs. */
export const ExtraOutputList = memo(function ExtraOutputList({
  outputs,
  includeAudio = false,
  compact = false,
}: ExtraOutputListProps) {
  const shown = outputs.filter(
    (o) =>
      o.kind === "text" ||
      o.kind === "unknown" ||
      (includeAudio && o.kind === "audio" && o.url),
  );
  if (shown.length === 0) return null;

  return (
    <div
      className={`flex flex-col gap-2 ${compact ? "p-2 w-full h-full overflow-auto" : ""}`}
    >
      {shown.map((o, i) => {
        const label = `${o.nodeTitle} · ${o.key}`;
        if (o.kind === "audio") {
          return (
            <div key={`${o.nodeId}-${i}`} className="flex flex-col gap-1">
              <span className="text-[11px] text-[var(--text-muted)] truncate">
                {label}
              </span>
              <audio src={o.url} controls className="w-full h-8" />
            </div>
          );
        }
        if (o.kind === "unknown" && o.url && o.view?.filename) {
          // A saved file the media slots cannot show (e.g. an .svg from
          // Vectorize): offer it as a download instead of dumping its JSON.
          return (
            <a
              key={`${o.nodeId}-${i}`}
              href={o.url}
              download={o.view.filename}
              data-output-kind="file"
              className="flex items-center gap-1.5 rounded-md border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-tertiary)] px-2 py-1.5 text-xs text-[var(--text-primary)] hover:bg-white/10"
            >
              <Download className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
              <span className="truncate flex-1">{o.view.filename}</span>
              <span className="text-[11px] text-[var(--text-muted)] truncate">
                {label}
              </span>
            </a>
          );
        }
        const body = o.kind === "text" ? (o.text ?? "") : prettyRaw(o.raw);
        const Icon = o.kind === "text" ? FileText : Braces;
        return (
          <div
            key={`${o.nodeId}-${i}`}
            className="rounded-md border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-tertiary)]"
            data-output-kind={o.kind}
          >
            <div className="flex items-center gap-1.5 px-2 py-1 border-b border-white/5">
              <Icon className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
              <span className="text-[11px] text-[var(--text-muted)] truncate flex-1">
                {label}
              </span>
              <CopyButton text={body} />
            </div>
            <pre
              className={`px-2 py-1.5 text-xs text-[var(--text-primary)] whitespace-pre-wrap break-words font-mono overflow-auto ${
                compact ? "max-h-32" : "max-h-64"
              }`}
            >
              {body}
            </pre>
          </div>
        );
      })}
    </div>
  );
});

/** Fetches a prompt's history and renders its text/unknown (and opt. audio) outputs. */
export const ExtraOutputs = memo(function ExtraOutputs({
  promptId,
  includeAudio,
  compact,
  title,
}: {
  promptId: string | undefined;
  includeAudio?: boolean;
  compact?: boolean;
  title?: string;
}) {
  const outputs = useHistoryOutputs(promptId);
  const hasExtras = outputs.some(
    (o) =>
      o.kind === "text" ||
      o.kind === "unknown" ||
      (includeAudio && o.kind === "audio"),
  );
  if (!hasExtras) return null;
  return (
    <div className={compact ? "w-full h-full" : "px-4 py-2"}>
      {title && (
        <div className="text-xs text-[var(--text-muted)] mb-1.5">{title}</div>
      )}
      <ExtraOutputList
        outputs={outputs}
        includeAudio={includeAudio}
        compact={compact}
      />
    </div>
  );
});

export default ExtraOutputs;
