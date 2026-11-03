"use client";

import { useMemo, useState } from "react";
import { useGenerationStore } from "@/store";
import { showToast } from "@/components/Toast";
import {
  availableEngines,
  compileBatchPrompts,
  compileTemplatePrompt,
  templateSetIds,
  type EditEngineId,
  type EngineContext,
  type TemplateDef,
  preferredEngine,
} from "@/lib/tools/templates";
import {
  submitEngineEdit,
  type PreparedSource,
  type ToolImage,
} from "@/lib/tools/runTool";
import type { HubCard } from "@/lib/tools/hub";
import { ToolImageInput } from "./ToolImageInput";
import { useToolHandoff } from "./useToolHandoff";
import { EditorReturnNote, useEditorOrigin } from "./EditorReturn";
import { CharacterProfilePicker } from "./CharacterProfilePicker";
import { EnginePicker } from "./EnginePicker";
import { RunFooter, RunnerShell, errorMessage } from "./RunnerShell";
import { Segmented, field } from "./ToolRunner";
import { PresetGrid } from "./RunnerStudio";

/**
 * Preset-prompt tools (Remove Text, Headshot, Skin Enhancer, Photo Dump,
 * What If, Commercial Faces, AI Stylist):
 * one photo → one edit per chosen preset on an existing edit engine.
 */
export function TemplateRunner({
  template,
  card,
  ctx,
  onBack,
}: {
  template: TemplateDef;
  card: HubCard;
  ctx: EngineContext;
  onBack: () => void;
}) {
  const clientId = useGenerationStore((s) => s.clientId);
  const addRun = useGenerationStore((s) => s.addRun);

  const engines = useMemo(
    () => availableEngines(template.engines, ctx),
    [template, ctx],
  );
  const [engineId, setEngineId] = useState<EditEngineId | null>(null);
  const engine =
    engines.find((e) => e.id === engineId) ?? preferredEngine(engines);

  const multi = template.multi;
  const [presetId, setPresetId] = useState(template.presets[0].id);
  const [selected, setSelected] = useState<string[]>(() =>
    template.presets.slice(0, multi?.defaultCount ?? 1).map((p) => p.id),
  );
  const [image, setImage] = useState<ToolImage | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Lightbox "Tools" panel: the open image arrives as the main input.
  const editorOrigin = useEditorOrigin(card.title);
  useToolHandoff(card.key, {
    onImage: setImage,
    onError: setError,
    onHandoff: editorOrigin.onHandoff,
  });
  const [queued, setQueued] = useState<string | null>(null);

  const jobs = useMemo(() => {
    if (!engine) return [];
    return multi
      ? compileBatchPrompts(template, selected, engine, notes)
      : [
          {
            presetId,
            label: template.presets.find((p) => p.id === presetId)?.label ?? "",
            prompt: compileTemplatePrompt(template, presetId, engine, notes),
          },
        ];
  }, [engine, multi, template, selected, presetId, notes]);

  const toggle = (id: string) =>
    setSelected((prev) =>
      prev.includes(id)
        ? prev.filter((x) => x !== id)
        : prev.length >= (multi?.max ?? 1)
          ? prev
          : [...prev, id],
    );

  let validation: string | null = null;
  if (engine) {
    if (!image) validation = "Add a photo to start.";
    else if (jobs.length === 0) validation = "Pick at least one look.";
  }

  const run = async () => {
    if (!engine || !image) return;
    setBusy(true);
    setError(null);
    setQueued(null);
    const prepared: PreparedSource = {};
    let done = 0;
    try {
      for (const job of jobs) {
        const r = await submitEngineEdit({
          fetchImpl: fetch,
          engine,
          prompt: job.prompt,
          image,
          ctx,
          clientId,
          title: `${template.title}: ${job.label}`,
          prepared,
          onWarnings: (w) => w.forEach((m) => showToast(m, "info", 8000)),
        });
        addRun(r);
        editorOrigin.track(r.run_id);
        done += 1;
      }
      setQueued(done > 1 ? `Queued ${done} jobs.` : "Queued.");
      showToast(
        `${template.title} queued. Progress shows in Create.`,
        "success",
      );
    } catch (e) {
      setError(
        done > 0
          ? `${errorMessage(e)} (${done} of ${jobs.length} were queued)`
          : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <RunnerShell
      title={card.title}
      subtitle={card.subtitle}
      blockedReason={
        engine
          ? null
          : (card.unavailableReason ??
            "No edit model is installed on this server.")
      }
      checking={!engine && card.checking}
      onBack={onBack}
      testId={`template-runner-${template.id}`}
      studio="image"
    >
      <CharacterProfilePicker
        toolKey={card.key}
        disabled={busy}
        onApply={(img, _next, prev) => {
          if (img) setImage(img);
          else if (prev?.refs.some((r) => r.id === image?.id)) setImage(null);
        }}
      />
      <ToolImageInput label="Photo" value={image} onChange={setImage} />

      {multi ? (
        <section className="space-y-1.5">
          <span className="text-[11px] tabular-nums text-light-500 dark:text-dark-400">
            Pick up to {multi.max} looks
          </span>
          {template.sets && template.sets.length > 0 && (
            <div
              className="flex flex-wrap gap-1.5 pb-1"
              role="group"
              aria-label="Outfit sets"
              data-testid="template-sets"
            >
              {template.sets.map((set) => {
                const ids = templateSetIds(template, set.id);
                const on =
                  ids.length === selected.length &&
                  ids.every((id, i) => selected[i] === id);
                return (
                  <button
                    key={set.id}
                    type="button"
                    aria-pressed={on}
                    title={`${ids.length} looks`}
                    onClick={() => setSelected(ids)}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                      on
                        ? "border-splash bg-splash text-white"
                        : "border-light-100 dark:border-dark-750 text-light-primary dark:text-dark-primary hover:border-splash/60"
                    }`}
                  >
                    {set.label}
                    <span className="ml-1 opacity-70">{ids.length}</span>
                  </button>
                );
              })}
            </div>
          )}
          <PresetGrid
            label="Looks"
            pickerKey={`template:${template.id}`}
            options={template.presets}
            selected={selected}
            onToggle={toggle}
            disabled={busy}
          />
        </section>
      ) : (
        template.presets.length > 1 &&
        (template.presets.length >= 4 ? (
          <PresetGrid
            label="Style"
            pickerKey={`template:${template.id}`}
            value={presetId}
            options={template.presets}
            onChange={setPresetId}
            disabled={busy}
          />
        ) : (
          <Segmented
            label="Style"
            value={presetId}
            options={template.presets}
            onChange={setPresetId}
          />
        ))
      )}

      {engine?.promptStyle !== "none" && (
        <section className="space-y-1.5">
          <label
            htmlFor="template-notes"
            className="text-xs font-medium text-light-primary dark:text-dark-primary"
          >
            {template.notesLabel}
          </label>
          <input
            id="template-notes"
            className={field}
            maxLength={300}
            placeholder={template.notesPlaceholder}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </section>
      )}

      {engines.length > 0 && (
        <EnginePicker engines={engines} value={engine} onChange={setEngineId} />
      )}

      {jobs.length === 1 && jobs[0].prompt && (
        <details className="text-[11px] text-light-500 dark:text-dark-400">
          <summary className="cursor-pointer">Prompt sent</summary>
          <p className="mt-1 font-mono">{jobs[0].prompt}</p>
        </details>
      )}

      {editorOrigin.fromEditor && <EditorReturnNote />}
      <RunFooter
        label={jobs.length > 1 ? `Generate ${jobs.length}` : "Generate"}
        busy={busy}
        disabled={!engine}
        validation={validation}
        error={error}
        queuedText={queued}
        onRun={run}
      />
    </RunnerShell>
  );
}
