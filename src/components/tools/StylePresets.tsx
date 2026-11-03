"use client";

import { useState } from "react";
import { Paintbrush, PenLine, Plus } from "lucide-react";
import { useUIStore } from "@/store";
import { useImagine } from "@/hooks/useImagine";
import {
  STYLE_CATEGORIES,
  addStyleToPrompt,
  compileStylePrompt,
  getStylePreset,
  stylesIn,
  type StyleCategory,
} from "@/lib/tools/stylePresets";
import { findStyleLora } from "@/lib/krea2/styleLoras";
import { detectModelFamilyStrict } from "@/lib/oj/packs";
import { RunFooter, RunnerShell, errorMessage } from "./RunnerShell";
import { Segmented, field } from "./ToolRunner";

/**
 * Make sure a catalog style LoRA is on disk (admin download on demand).
 * Returns false when the viewer may not download (non-admin): the caller
 * then renders without the LoRA instead of failing.
 */
async function ensureStyleLora(id: string): Promise<boolean> {
  const res = await fetch("/api/krea2-style-loras/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (res.ok) return true;
  if (res.status === 401 || res.status === 403) return false;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(
    data.error ?? `Style LoRA download failed (HTTP ${res.status})`,
  );
}

/** Named style menu → one t2i prompt → Imagine (default pack). */
export function StylePresets({ onBack }: { onBack: () => void }) {
  const setActiveNav = useUIStore((s) => s.setActiveNav);
  const setPromptValue = useUIStore((s) => s.setPromptValue);
  const { imagine, isLoading } = useImagine();
  const settings = useUIStore((s) => s.settings);
  // Style LoRAs are Krea 2 LoRAs: only offer them when Krea 2 is active.
  const isKrea2 =
    settings.modelVersion === "krea-2-direct" ||
    settings.krea2Backend === "direct" ||
    detectModelFamilyStrict(settings.model ?? "") === "krea2";

  const [category, setCategory] = useState<StyleCategory>(STYLE_CATEGORIES[0]);
  const [styleId, setStyleId] = useState(stylesIn(STYLE_CATEGORIES[0])[0].id);
  const [subject, setSubject] = useState("");
  const [notes, setNotes] = useState("");
  const [withLora, setWithLora] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<string | null>(null);

  const preset = getStylePreset(styleId) ?? stylesIn(category)[0];
  const lora = preset.lora ? findStyleLora(preset.lora) : undefined;
  const [loraDenied, setLoraDenied] = useState(false);
  const useLora = withLora && isKrea2 && !loraDenied && Boolean(lora);
  const prompt = compileStylePrompt(preset, {
    subject,
    notes,
    withLora: useLora,
  });

  const pickCategory = (id: string) => {
    const c = id as StyleCategory;
    setCategory(c);
    setStyleId(stylesIn(c)[0].id);
  };

  /** Returns the prompt to send (LoRA flag dropped if download is denied). */
  const prepare = async (): Promise<string> => {
    if (useLora && lora && !(await ensureStyleLora(lora.id))) {
      setLoraDenied(true);
      return compileStylePrompt(preset, { subject, notes, withLora: false });
    }
    return prompt;
  };

  const generate = async () => {
    setError(null);
    setQueued(null);
    setBusy(true);
    try {
      const r = await imagine(await prepare());
      if (r.ok) setQueued("Queued. Progress shows in Create.");
      else setError(r.error ?? "Generation failed.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const openInCreate = async () => {
    setError(null);
    try {
      setPromptValue(await prepare());
      setActiveNav("create");
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  /** Add just the style (fragment + LoRA flag) to whatever is in Create. */
  const addToPrompt = async () => {
    setError(null);
    try {
      const withStyleLora = (await prepare()) === prompt && useLora;
      setPromptValue(
        addStyleToPrompt(
          useUIStore.getState().promptValue,
          preset,
          withStyleLora,
        ),
      );
      setQueued(`Added "${preset.name}" to the Create prompt.`);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <RunnerShell
      title="Style Presets"
      subtitle="Pick a named look, describe your subject, and render it."
      model="Runs on your default Imagine pack · open weights"
      onBack={onBack}
      testId="style-presets"
      studio="image"
    >
      <Segmented
        label="Category"
        value={category}
        options={STYLE_CATEGORIES.map((c) => ({ id: c, label: c }))}
        onChange={pickCategory}
      />
      <Segmented
        label="Style"
        value={preset.id}
        options={stylesIn(category).map((p) => ({ id: p.id, label: p.name }))}
        onChange={setStyleId}
      />

      <section className="space-y-1.5">
        <label
          htmlFor="style-subject"
          className="text-xs font-medium text-light-primary dark:text-dark-primary"
        >
          Subject
        </label>
        <input
          id="style-subject"
          className={field}
          maxLength={300}
          placeholder="e.g. a cyclist crossing a bridge at dawn"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </section>

      <section className="space-y-1.5">
        <label
          htmlFor="style-notes"
          className="text-xs font-medium text-light-primary dark:text-dark-primary"
        >
          Extra details (optional)
        </label>
        <input
          id="style-notes"
          className={field}
          maxLength={300}
          placeholder="e.g. red raincoat, wide shot"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </section>

      {lora && isKrea2 && !loraDenied && (
        <label className="flex items-start gap-2 text-xs text-light-500 dark:text-dark-400">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={withLora}
            onChange={(e) => setWithLora(e.target.checked)}
          />
          <span>
            Add the matching style LoRA ({lora.name}). Downloads on first
            use (admin).
          </span>
        </label>
      )}

      <div className="rounded-xl border border-light-100 dark:border-dark-750 p-3 text-xs font-mono text-light-500 dark:text-dark-400">
        {prompt}
      </div>

      <div className="flex flex-wrap items-start gap-2">
        <RunFooter
          label="Generate"
          icon={<Paintbrush className="w-4 h-4" />}
          busy={busy || isLoading}
          disabled={false}
          validation={null}
          error={error}
          queuedText={queued}
          onRun={generate}
        />
        <button
          type="button"
          onClick={openInCreate}
          className="flex items-center gap-1.5 rounded-xl border border-light-100 dark:border-dark-750 px-4 py-2.5 text-sm text-light-500 dark:text-dark-400 hover:text-splash"
        >
          <PenLine className="w-4 h-4" /> Open in Create
        </button>
        <button
          type="button"
          onClick={addToPrompt}
          className="flex items-center gap-1.5 rounded-xl border border-light-100 dark:border-dark-750 px-4 py-2.5 text-sm text-light-500 dark:text-dark-400 hover:text-splash"
        >
          <Plus className="w-4 h-4" /> Add style to my prompt
        </button>
      </div>
    </RunnerShell>
  );
}
