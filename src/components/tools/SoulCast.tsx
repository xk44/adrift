"use client";

import { useState } from "react";
import { Clapperboard, PenLine } from "lucide-react";
import { useUIStore } from "@/store";
import { useImagine } from "@/hooks/useImagine";
import {
  CAST_FIELDS,
  compileCastPrompt,
  defaultCastSelection,
  type CastSelection,
} from "@/lib/tools/templates";
import { RunFooter, RunnerShell } from "./RunnerShell";
import { Segmented, field } from "./ToolRunner";

/** Actor builder: menus → one cinematic t2i prompt → Imagine (default pack). */
export function SoulCast({ onBack }: { onBack: () => void }) {
  const setActiveNav = useUIStore((s) => s.setActiveNav);
  const setPromptValue = useUIStore((s) => s.setPromptValue);
  const { imagine, isLoading } = useImagine();
  const [sel, setSel] = useState<CastSelection>(defaultCastSelection);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);

  const prompt = compileCastPrompt(sel, notes);

  const generate = async () => {
    setError(null);
    setQueued(false);
    const r = await imagine(prompt);
    if (r.ok) setQueued(true);
    else setError(r.error ?? "Generation failed.");
  };

  const openInCreate = () => {
    setPromptValue(prompt);
    setActiveNav("create");
  };

  return (
    <RunnerShell
      title="Cast Builder"
      subtitle="Build an original actor from genre, era, archetype and wardrobe, then render a casting still."
      model="Runs on your default Imagine pack · open weights"
      onBack={onBack}
      testId="soul-cast"
      studio="image"
    >
      {CAST_FIELDS.map((f) => (
        <Segmented
          key={f.key}
          label={f.label}
          value={sel[f.key] ?? f.options[0].id}
          options={f.options}
          onChange={(id) => setSel((s) => ({ ...s, [f.key]: id }))}
        />
      ))}

      <section className="space-y-1.5">
        <label
          htmlFor="cast-notes"
          className="text-xs font-medium text-light-primary dark:text-dark-primary"
        >
          Extra details (optional)
        </label>
        <input
          id="cast-notes"
          className={field}
          maxLength={300}
          placeholder="e.g. red hair, holding a lantern"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </section>

      <div className="rounded-xl border border-light-100 dark:border-dark-750 p-3 text-xs font-mono text-light-500 dark:text-dark-400">
        {prompt}
      </div>

      <div className="flex flex-wrap items-start gap-2">
        <RunFooter
          label="Generate"
          icon={<Clapperboard className="w-4 h-4" />}
          busy={isLoading}
          disabled={false}
          validation={null}
          error={error}
          queuedText={queued ? "Queued." : null}
          onRun={generate}
        />
        <button
          type="button"
          onClick={openInCreate}
          className="flex items-center gap-1.5 rounded-xl border border-light-100 dark:border-dark-750 px-4 py-2.5 text-sm text-light-500 dark:text-dark-400 hover:text-splash"
        >
          <PenLine className="w-4 h-4" /> Open in Create
        </button>
      </div>
    </RunnerShell>
  );
}
