"use client";

/**
 * DatasetCaptionPanel — caption knobs for a LoRA dataset board:
 * trigger word, caption dropout, caption shuffle (+ keep first N tags),
 * batch caption edits over the selected images, and metadata.jsonl export.
 *
 * Knobs persist on the board (`captionSettings`, PUT /api/moodboards); the
 * train route threads them into the trainer params + the dataset manifest.
 */

import { useEffect, useMemo, useState } from "react";
import { Download, Loader2, Save, Wand2 } from "lucide-react";
import type { Moodboard } from "@/types";
import { updateMoodboard } from "@/lib/sref/moodboardClient";
import {
  MAX_KEEP_TOKENS,
  applyCaptionBatchEdit,
  buildMetadataJsonl,
  datasetFileName,
  normalizeCaptionSettings,
  type CaptionBatchOp,
  type CaptionSettings,
} from "@/lib/moodboards/captions";
import { showToast } from "@/components/Toast";

type BatchMode = CaptionBatchOp["kind"];

export interface DatasetCaptionPanelProps {
  board: Moodboard;
  selected: number[];
  onSelectionChange: (indices: number[]) => void;
  onBoardUpdated: (board: Moodboard) => void;
}

function settingsEqual(a: CaptionSettings, b: CaptionSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Pure op builder (exported for tests): null when the inputs are a no-op. */
export function buildBatchOp(
  mode: BatchMode,
  find: string,
  replace: string,
  token: string,
): CaptionBatchOp | null {
  if (mode === "replace") {
    return find ? { kind: "replace", find, replace } : null;
  }
  return token.trim() ? { kind: mode, token } : null;
}

export function DatasetCaptionPanel({
  board,
  selected,
  onSelectionChange,
  onBoardUpdated,
}: DatasetCaptionPanelProps) {
  const saved = useMemo(
    () => normalizeCaptionSettings(board.captionSettings),
    [board.captionSettings],
  );
  const [triggerWord, setTriggerWord] = useState(saved.triggerWord ?? "");
  const [dropoutPct, setDropoutPct] = useState(
    String(Math.round((saved.dropoutRate ?? 0) * 100)),
  );
  const [shuffle, setShuffle] = useState(saved.shuffle ?? false);
  const [keepTokens, setKeepTokens] = useState(String(saved.keepTokens ?? 1));
  const [savingSettings, setSavingSettings] = useState(false);

  const [mode, setMode] = useState<BatchMode>("replace");
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [token, setToken] = useState("");
  const [applying, setApplying] = useState(false);

  // Re-seed the form when switching boards.
  useEffect(() => {
    const s = normalizeCaptionSettings(board.captionSettings);
    setTriggerWord(s.triggerWord ?? "");
    setDropoutPct(String(Math.round((s.dropoutRate ?? 0) * 100)));
    setShuffle(s.shuffle ?? false);
    setKeepTokens(String(s.keepTokens ?? 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.id]);

  const draft = useMemo(
    () =>
      normalizeCaptionSettings({
        triggerWord,
        dropoutRate: Number(dropoutPct) / 100,
        shuffle,
        keepTokens: Number(keepTokens),
      }),
    [dropoutPct, keepTokens, shuffle, triggerWord],
  );
  const dirty = !settingsEqual(draft, saved);

  const total = board.images.length;
  const selectedCount = selected.length;
  const op = buildBatchOp(mode, find, replace, token);

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      const res = await updateMoodboard({
        id: board.id,
        captionSettings: Object.keys(draft).length ? draft : null,
      });
      if (!res.ok || !res.moodboard) {
        showToast(res.error ?? "Could not save caption settings.", "error");
        return;
      }
      onBoardUpdated(res.moodboard);
      showToast("Caption settings saved.", "success");
    } catch {
      showToast("Could not save caption settings.", "error");
    } finally {
      setSavingSettings(false);
    }
  };

  const applyBatch = async () => {
    if (!op || selectedCount === 0) return;
    const { images, changed } = applyCaptionBatchEdit(
      board.images,
      selected,
      op,
    );
    if (changed === 0) {
      showToast("No selected captions changed.", "info");
      return;
    }
    setApplying(true);
    try {
      const res = await updateMoodboard({ id: board.id, images });
      if (!res.ok || !res.moodboard) {
        showToast(res.error ?? "Could not update captions.", "error");
        return;
      }
      onBoardUpdated(res.moodboard);
      showToast(
        `Updated ${changed} caption${changed === 1 ? "" : "s"}.`,
        "success",
      );
    } catch {
      showToast("Could not update captions.", "error");
    } finally {
      setApplying(false);
    }
  };

  const exportJsonl = () => {
    const jsonl = buildMetadataJsonl(
      board.images.map((image, index) => ({
        fileName: datasetFileName(image.url, index),
        caption: image.caption,
      })),
      saved.triggerWord ?? "",
    );
    if (!jsonl) {
      showToast("No captions to export yet.", "info");
      return;
    }
    const blob = new Blob([jsonl], { type: "application/x-ndjson" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = "metadata.jsonl";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  };

  const captionedCount = board.images.filter((i) => i.caption?.trim()).length;

  return (
    <section
      data-testid="dataset-caption-panel"
      aria-label="Caption settings"
      className="space-y-3 text-sm"
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--text-muted)]">Trigger word</span>
          <input
            aria-label="Trigger word"
            type="text"
            value={triggerWord}
            maxLength={100}
            onChange={(e) => setTriggerWord(e.target.value)}
            placeholder="e.g. ohwx"
            className="input w-40 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--text-muted)]">
            Caption dropout %
          </span>
          <input
            aria-label="Caption dropout percent"
            type="number"
            min={0}
            max={100}
            step={5}
            value={dropoutPct}
            onChange={(e) => setDropoutPct(e.target.value)}
            className="input w-24 text-sm"
            title="Share of steps trained with an empty caption (0 = off)"
          />
        </label>
        <label className="flex items-center gap-2 pb-2">
          <input
            aria-label="Shuffle caption tags"
            type="checkbox"
            checked={shuffle}
            onChange={(e) => setShuffle(e.target.checked)}
          />
          <span>Shuffle tags</span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--text-muted)]">
            Keep first N tags
          </span>
          <input
            aria-label="Keep first N tags"
            type="number"
            min={0}
            max={MAX_KEEP_TOKENS}
            value={keepTokens}
            disabled={!shuffle}
            onChange={(e) => setKeepTokens(e.target.value)}
            className="input w-20 text-sm disabled:opacity-40"
            title="Tags kept in place while shuffling (1 keeps the trigger first)"
          />
        </label>
        <button
          type="button"
          onClick={() => void saveSettings()}
          disabled={!dirty || savingSettings}
          className="flex items-center gap-1.5 rounded-lg border border-[var(--border-primary)] px-3 py-1.5 font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] disabled:opacity-40"
        >
          {savingSettings ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Save
        </button>
        <button
          type="button"
          onClick={exportJsonl}
          disabled={captionedCount === 0}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-[var(--border-primary)] px-3 py-1.5 font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] disabled:opacity-40"
          title="Download image↔caption pairs as metadata.jsonl"
        >
          <Download className="h-4 w-4" />
          metadata.jsonl
        </button>
      </div>

      {total > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs tabular-nums text-[var(--text-muted)]">
            {selectedCount}/{total} selected
          </span>
          <button
            type="button"
            onClick={() =>
              onSelectionChange(
                selectedCount === total
                  ? []
                  : board.images.map((_, index) => index),
              )
            }
            className="rounded-md px-2 py-1 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]"
          >
            {selectedCount === total ? "Select none" : "Select all"}
          </button>
          <select
            aria-label="Batch caption edit"
            value={mode}
            onChange={(e) => setMode(e.target.value as BatchMode)}
            className="input w-auto py-1 text-xs"
          >
            <option value="replace">Find / replace</option>
            <option value="prepend">Prepend tag</option>
            <option value="append">Append tag</option>
          </select>
          {mode === "replace" ? (
            <>
              <input
                aria-label="Find"
                type="text"
                value={find}
                onChange={(e) => setFind(e.target.value)}
                placeholder="find"
                className="input w-32 py-1 text-xs"
              />
              <input
                aria-label="Replace with"
                type="text"
                value={replace}
                onChange={(e) => setReplace(e.target.value)}
                placeholder="replace (empty = remove)"
                className="input w-44 py-1 text-xs"
              />
            </>
          ) : (
            <input
              aria-label="Tag"
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="tag"
              className="input w-40 py-1 text-xs"
            />
          )}
          <button
            type="button"
            onClick={() => void applyBatch()}
            disabled={!op || selectedCount === 0 || applying}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--accent-primary)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {applying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wand2 className="h-3.5 w-3.5" />
            )}
            Apply to selected
          </button>
        </div>
      )}
    </section>
  );
}
