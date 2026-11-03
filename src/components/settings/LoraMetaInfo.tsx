"use client";

/**
 * Per-LoRA metadata strip: base-model badge, dim/alpha, mismatch warning and
 * click-to-insert trigger-word chips. All header values are untrusted, so
 * they are rendered only as React text nodes (never as HTML).
 */

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useUIStore } from "@/store";
import { detectModelFamilyStrict } from "@/lib/oj/packs";
import { loraBaseMismatch, type LoraMetadata } from "@/lib/loraMetadata";
import { onComfyBackendChange } from "@/lib/comfy/backendChange";

const metaCache = new Map<string, LoraMetadata | null>();
onComfyBackendChange(() => metaCache.clear());

export function useLoraMetadata(filename: string): LoraMetadata | null {
  const [meta, setMeta] = useState<LoraMetadata | null>(
    metaCache.get(filename) ?? null,
  );
  useEffect(() => {
    if (!filename) {
      setMeta(null);
      return;
    }
    if (metaCache.has(filename)) {
      setMeta(metaCache.get(filename) ?? null);
      return;
    }
    const ctrl = new AbortController();
    fetch(`/api/comfy/lora-metadata?filename=${encodeURIComponent(filename)}`, {
      signal: ctrl.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const m = d?.ok ? (d.metadata as LoraMetadata) : null;
        metaCache.set(filename, m);
        setMeta(m);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [filename]);
  return meta;
}

export function appendTriggerToPrompt(current: string, word: string): string {
  const trimmed = current.replace(/[\s,]+$/, "");
  return trimmed ? `${trimmed}, ${word}` : word;
}

export function LoraMetaInfo({
  filename,
  selectedModel,
}: {
  filename: string;
  selectedModel?: string;
}) {
  const meta = useLoraMetadata(filename);
  const setPromptValue = useUIStore((s) => s.setPromptValue);
  if (!meta) return null;

  // Strict: an unrecognized model is "unknown" (no warning), not a guessed sdxl.
  const modelFamily = selectedModel
    ? detectModelFamilyStrict(selectedModel)
    : null;
  const { mismatch, loraFamily } = loraBaseMismatch(
    meta.baseFamily ?? meta.baseModel,
    modelFamily,
  );
  const hasAny =
    meta.baseModel || meta.networkDim || meta.title || meta.triggers.length > 0;
  if (!hasAny) return null;

  return (
    <div className="mt-1 space-y-1 text-xs text-[var(--text-muted)]">
      <div className="flex flex-wrap items-center gap-1.5">
        {meta.baseModel && (
          <span
            className="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5"
            title={meta.baseModel}
          >
            {loraFamily ?? meta.baseModel}
          </span>
        )}
        {meta.networkDim != null && (
          <span>
            dim {meta.networkDim}
            {meta.networkAlpha != null ? ` / alpha ${meta.networkAlpha}` : ""}
          </span>
        )}
        {meta.title && <span className="truncate">{meta.title}</span>}
      </div>
      {mismatch && (
        <div className="flex items-center gap-1 text-amber-400">
          <AlertTriangle className="h-3 w-3" />
          Base {loraFamily} does not match selected model ({modelFamily})
        </div>
      )}
      {meta.triggers.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {meta.triggers.map((t) => (
            <button
              key={t.word}
              type="button"
              title={`Insert into prompt (seen ${t.count}x in training)`}
              onClick={() =>
                setPromptValue(
                  appendTriggerToPrompt(useUIStore.getState().promptValue, t.word),
                )
              }
              className="rounded-full border border-[var(--border-primary)] px-2 py-0.5 hover:border-splash hover:text-splash"
            >
              {t.word}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
