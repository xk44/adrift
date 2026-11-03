"use client";

import { useEffect, useRef, useState } from "react";
import { AudioLines, ChevronDown, FilePlus2, Square, X } from "lucide-react";
import { showToast } from "@/components/Toast";
import {
  AUDIO_LORA_ACCEPT,
  AUDIO_LORA_ADAPTERS,
  AUDIO_LORA_BASES,
  AUDIO_LORA_LIMITS,
  AUDIO_LORA_MAX_CAPTION,
  AUDIO_LORA_MAX_CLIPS,
  AUDIO_LORA_MIN_CLIPS,
  AUDIO_LORA_PRESETS,
  audioClipExt,
  audioLoraStageText,
  clipUploadName,
  defaultCaption,
  presetSettings,
  sanitizeLoraName,
  validateAudioLoraInput,
  type AudioLoraAdapter,
  type AudioLoraBase,
  type AudioLoraPreset,
  type AudioLoraProgress,
} from "@/lib/training/audioLora";
import {
  cancelAudioLoraTraining,
  getAudioLoraAvailability,
  getAudioLoraStatus,
  startAudioLoraTraining,
  uploadAudioLoraClips,
  watchAudioLoraProgress,
  type AudioLoraAvailability,
} from "@/lib/training/audioLoraSubmit";
import { RunFooter, RunnerShell } from "./RunnerShell";
import { Segmented, field } from "./ToolRunner";

interface ClipItem {
  key: string;
  file: File;
  url: string;
  caption: string;
}

export interface ActiveRun {
  promptId: string;
  clientId: string;
  name: string;
  /** What the run was started with, so a resumed page shows the truth. */
  base?: AudioLoraBase;
  adapter?: AudioLoraAdapter;
  preset?: AudioLoraPreset;
}

export const RUN_KEY = "adrift.trainAudioLora.run";
const POLL_MS = 5000;

const oneOf = <T extends string>(
  v: unknown,
  opts: { id: T }[],
): T | undefined =>
  typeof v === "string" ? opts.find((o) => o.id === v)?.id : undefined;

/** Parse the stored run; unknown base/adapter/preset values are dropped. */
export function parseStoredRun(raw: string | null): ActiveRun | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Record<string, unknown> | null;
    if (!r || typeof r.promptId !== "string") return null;
    return {
      promptId: r.promptId,
      clientId: typeof r.clientId === "string" ? r.clientId : "",
      name: typeof r.name === "string" ? r.name : "",
      base: oneOf(r.base, AUDIO_LORA_BASES),
      adapter: oneOf(r.adapter, AUDIO_LORA_ADAPTERS),
      preset: oneOf(r.preset, AUDIO_LORA_PRESETS),
    };
  } catch {
    return null;
  }
}

function loadRun(): ActiveRun | null {
  try {
    return parseStoredRun(localStorage.getItem(RUN_KEY));
  } catch {
    return null;
  }
}

function saveRun(r: ActiveRun | null) {
  try {
    if (r) localStorage.setItem(RUN_KEY, JSON.stringify(r));
    else localStorage.removeItem(RUN_KEY);
  } catch {
    /* storage blocked: the run just will not resume after a reload */
  }
}

/**
 * Train audio LoRA: 5-50 clips + captions -> CJSA3TrainAudioLoRA on
 * ComfyUI -> models/loras/audio/<name>.safetensors, which the Stable Audio 3
 * tools list as a LoRA.
 */
export function TrainAudioLora({ onBack }: { onBack: () => void }) {
  const [avail, setAvail] = useState<AudioLoraAvailability | null>(null);
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [rejected, setRejected] = useState<string | null>(null);
  const [nameRaw, setNameRaw] = useState("");
  const [base, setBase] = useState<AudioLoraBase>("medium-base");
  const [preset, setPreset] = useState<AudioLoraPreset>("balanced");
  const [adapter, setAdapter] = useState<AudioLoraAdapter>("lora");
  const [settings, setSettings] = useState(() => presetSettings("balanced"));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<AudioLoraProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<ActiveRun | null>(null);
  // Stopping throws away the whole run: ask once before doing it.
  const [confirmStop, setConfirmStop] = useState(false);
  const [result, setResult] = useState<{
    lora: string;
    summary: string;
  } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const keySeq = useRef(0);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const live = useRef(true);
  const stopUpload = useRef({ aborted: false });

  const name = sanitizeLoraName(nameRaw);
  const locked = busy || !!result;

  useEffect(() => {
    live.current = true;
    void getAudioLoraAvailability().then((a) => live.current && setAvail(a));
    const pending = loadRun();
    if (pending) {
      setNameRaw(pending.name);
      if (pending.base) setBase(pending.base);
      if (pending.adapter) setAdapter(pending.adapter);
      if (pending.preset) setPreset(pending.preset);
      void follow(pending);
    }
    return () => {
      live.current = false;
      stopUpload.current.aborted = true;
      for (const c of clipsRef.current) URL.revokeObjectURL(c.url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFiles = (files: FileList | File[] | null) => {
    if (!files) return;
    const list = [...files];
    const ok = list.filter((f) => audioClipExt(f.name));
    const bad = list.length - ok.length;
    setRejected(
      bad > 0
        ? `${bad} file${bad === 1 ? "" : "s"} skipped: use WAV, MP3 or FLAC.`
        : null,
    );
    setClips((prev) => {
      const room = AUDIO_LORA_MAX_CLIPS - prev.length;
      const kept = ok.slice(0, Math.max(0, room));
      return [
        ...prev,
        ...kept.map((file) => ({
          key: `c${keySeq.current++}`,
          file,
          url: URL.createObjectURL(file),
          caption: defaultCaption(file.name),
        })),
      ];
    });
    if (fileRef.current) fileRef.current.value = "";
  };

  const remove = (key: string) =>
    setClips((prev) => {
      const hit = prev.find((c) => c.key === key);
      if (hit) URL.revokeObjectURL(hit.url);
      return prev.filter((c) => c.key !== key);
    });

  const setCaption = (key: string, caption: string) =>
    setClips((prev) =>
      prev.map((c) => (c.key === key ? { ...c, caption } : c)),
    );

  const pickPreset = (id: AudioLoraPreset) => {
    setPreset(id);
    setSettings(presetSettings(id));
  };

  const validation = validateAudioLoraInput({
    name,
    base,
    adapter,
    rank: settings.rank,
    lr: settings.lr,
    steps: settings.steps,
    clips: clips.map((c) => ({
      filename: c.file.name,
      size: c.file.size,
      caption: c.caption,
    })),
  });

  /** Follow a queued prompt until it finishes (status poll + SSE steps). */
  async function follow(r: ActiveRun) {
    setRun(r);
    setBusy(true);
    setError(null);
    setProgress({ phase: "queued" });
    let lastStep = 0;
    let woke: (() => void) | null = null;
    const close = watchAudioLoraProgress(r.clientId, r.promptId, (e) => {
      if (e.kind === "step") {
        lastStep = e.step;
        setProgress(
          e.step >= e.max
            ? { phase: "saving" }
            : { phase: "training", done: e.step, total: e.max },
        );
      } else if (e.kind === "end") {
        woke?.();
      }
    });
    try {
      let misses = 0;
      let unknown = 0;
      while (live.current) {
        let st;
        try {
          st = await getAudioLoraStatus(r.promptId);
          misses = 0;
        } catch (e) {
          if (++misses >= 6) throw e;
          st = null;
        }
        if (st?.state === "done") {
          setResult({ lora: st.lora ?? "", summary: st.summary ?? "" });
          setProgress({ phase: "done" });
          showToast("Audio LoRA saved.", "success");
          break;
        }
        if (st?.state === "error") {
          const stopped = st.error === "Training was stopped.";
          setProgress({ phase: stopped ? "cancelled" : "error" });
          if (!stopped) setError(st.error ?? "Training failed.");
          else showToast("Training stopped.", "info");
          break;
        }
        // One "unknown" can be the gap between leaving the queue and history.
        unknown = st?.state === "unknown" ? unknown + 1 : 0;
        if (unknown >= 2) {
          setError(
            "This training run is no longer known to ComfyUI (was it restarted?).",
          );
          break;
        }
        if (st?.state === "running" && lastStep === 0)
          setProgress({ phase: "preparing" });
        await new Promise<void>((res) => {
          woke = res;
          setTimeout(res, POLL_MS);
        });
        woke = null;
      }
    } catch (e) {
      if (live.current)
        setError(
          e instanceof Error ? e.message : "Lost track of the training run.",
        );
    } finally {
      close();
      if (live.current) {
        saveRun(null);
        setRun(null);
        setBusy(false);
        setConfirmStop(false);
      }
    }
  }

  const train = async () => {
    if (validation) return;
    setBusy(true);
    setError(null);
    setResult(null);
    stopUpload.current = { aborted: false };
    try {
      const named = clips.map((c, i) => ({
        c,
        uploadName: clipUploadName(i, c.file.name),
      }));
      await uploadAudioLoraClips(
        name,
        named.map((n) => ({ blob: n.c.file, uploadName: n.uploadName })),
        {
          signal: stopUpload.current,
          onProgress: (done, total) =>
            live.current && setProgress({ phase: "uploading", done, total }),
        },
      );
      const captions: Record<string, string> = {};
      for (const n of named) captions[n.uploadName] = n.c.caption.trim();
      const started = await startAudioLoraTraining({
        name,
        base,
        adapter,
        rank: settings.rank,
        lr: settings.lr,
        steps: settings.steps,
        captions,
      });
      const r: ActiveRun = { ...started, name, base, adapter, preset };
      saveRun(r);
      await follow(r);
    } catch (e) {
      if (live.current) {
        setError(e instanceof Error ? e.message : "Training failed to start.");
        setBusy(false);
        setProgress(null);
      }
    }
  };

  const stop = async () => {
    setConfirmStop(false);
    stopUpload.current.aborted = true;
    if (!run) return;
    try {
      await cancelAudioLoraTraining(run.promptId);
    } catch (e) {
      showToast(
        e instanceof Error ? e.message : "Could not stop training.",
        "error",
      );
    }
  };

  const reset = () => {
    for (const c of clips) URL.revokeObjectURL(c.url);
    setClips([]);
    setResult(null);
    setProgress(null);
    setNameRaw("");
  };

  const presetHint = AUDIO_LORA_PRESETS.find((p) => p.id === preset)?.hint;
  const L = AUDIO_LORA_LIMITS;

  return (
    <RunnerShell
      title="Train Audio LoRA"
      subtitle="Teach Stable Audio 3 a sound from your own clips: an instrument, a genre, a type of effect. Train once, then pick it in the audio tools."
      model="Stable Audio 3 LoRA · sized for a 24 GB GPU"
      blockedReason={
        avail && !avail.available
          ? (avail.reason ?? "Trainer not available.")
          : null
      }
      checking={avail === null}
      onBack={onBack}
      testId="train-audio-lora"
    >
      <section className="space-y-1.5">
        <label
          htmlFor="tal-name"
          className="text-xs font-medium text-light-primary dark:text-dark-primary"
        >
          Name
        </label>
        <input
          id="tal-name"
          className={field}
          maxLength={64}
          placeholder="e.g. dusty_drums"
          value={nameRaw}
          disabled={locked}
          onChange={(e) => setNameRaw(e.target.value)}
        />
        {name && name !== nameRaw.trim() && (
          <p className="text-xs text-light-500 dark:text-dark-400">
            Saved as <span className="font-mono">{name}</span>
          </p>
        )}
      </section>

      <Segmented
        label="Base model"
        value={base}
        options={AUDIO_LORA_BASES}
        disabled={locked}
        onChange={(id) => setBase(id as AudioLoraBase)}
      />
      <p className="-mt-4 text-xs text-light-500 dark:text-dark-400">
        Use the LoRA with the same base you train it on.
      </p>

      <Segmented
        label="Training length"
        value={preset}
        options={AUDIO_LORA_PRESETS}
        disabled={locked}
        onChange={(id) => pickPreset(id as AudioLoraPreset)}
      />
      <p className="-mt-4 text-xs text-light-500 dark:text-dark-400">
        {presetHint}
      </p>

      <section className="space-y-3">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
          className="flex items-center gap-1 text-xs font-medium text-light-500 dark:text-dark-400 hover:text-splash"
        >
          <ChevronDown
            className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? "" : "-rotate-90"}`}
          />
          Advanced
        </button>
        {showAdvanced && (
          <div className="space-y-3">
            <Segmented
              label="Adapter"
              value={adapter}
              options={AUDIO_LORA_ADAPTERS}
              disabled={locked}
              onChange={(id) => setAdapter(id as AudioLoraAdapter)}
            />
            <div className="grid grid-cols-3 gap-2">
              <label className="space-y-1 text-xs text-light-500 dark:text-dark-400">
                Rank
                <input
                  type="number"
                  className={field}
                  min={L.rank.min}
                  max={L.rank.max}
                  value={settings.rank}
                  disabled={locked}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, rank: Number(e.target.value) }))
                  }
                />
              </label>
              <label className="space-y-1 text-xs text-light-500 dark:text-dark-400">
                Learning rate
                <input
                  type="number"
                  className={field}
                  step="0.00001"
                  min={L.lr.min}
                  max={L.lr.max}
                  value={settings.lr}
                  disabled={locked}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, lr: Number(e.target.value) }))
                  }
                />
              </label>
              <label className="space-y-1 text-xs text-light-500 dark:text-dark-400">
                Steps
                <input
                  type="number"
                  className={field}
                  min={L.steps.min}
                  max={L.steps.max}
                  step={100}
                  value={settings.steps}
                  disabled={locked}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      steps: Number(e.target.value),
                    }))
                  }
                />
              </label>
            </div>
            <p className="text-xs text-light-500 dark:text-dark-400">
              DoRA can learn a little more from the same clips but trains
              slower. Higher rank learns more detail and needs more memory.
            </p>
          </div>
        )}
      </section>

      <section
        className={`space-y-2 rounded-xl ${dragOver ? "ring-2 ring-splash" : ""}`}
        onDragOver={(e) => {
          if (locked) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!locked) addFiles(e.dataTransfer.files);
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
            Clips ({clips.length}/{AUDIO_LORA_MAX_CLIPS}, at least{" "}
            {AUDIO_LORA_MIN_CLIPS})
          </span>
          <button
            type="button"
            disabled={locked || clips.length >= AUDIO_LORA_MAX_CLIPS}
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1.5 rounded-lg border border-light-100 dark:border-dark-750 px-3 py-1.5 text-sm text-light-500 dark:text-dark-400 hover:text-splash disabled:opacity-50"
          >
            <FilePlus2 className="w-4 h-4" /> Add clips
          </button>
          <input
            ref={fileRef}
            type="file"
            aria-label="Add audio clips"
            accept={AUDIO_LORA_ACCEPT}
            multiple
            hidden
            onChange={(e) => addFiles(e.target.files)}
          />
        </div>
        <p className="text-xs text-light-500 dark:text-dark-400">
          Drop WAV, MP3 or FLAC files here (up to 32 MB each). Clips of 10-60
          seconds work best; each step hears up to 30 seconds of a clip.
          Describe each clip in a few words: what plays, the mood, the tempo.
        </p>
        {rejected && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {rejected}
          </p>
        )}
        {clips.length > 0 && (
          <ul className="space-y-2">
            {clips.map((c, i) => (
              <li
                key={c.key}
                className="space-y-1.5 rounded-lg border border-light-100 dark:border-dark-750 p-2"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-light-500 dark:text-dark-400">
                    {i + 1}. {c.file.name}
                  </span>
                  {!locked && (
                    <button
                      type="button"
                      aria-label={`Remove clip ${i + 1}`}
                      onClick={() => remove(c.key)}
                      className="rounded-full p-1 text-light-500 dark:text-dark-400 hover:text-splash"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <audio
                  src={c.url}
                  controls
                  preload="none"
                  className="h-8 w-full"
                />
                <input
                  aria-label={`Caption for clip ${i + 1}`}
                  className={`${field} px-2 py-1 text-xs`}
                  maxLength={AUDIO_LORA_MAX_CAPTION}
                  placeholder="e.g. warm rhodes chords, slow, lo-fi"
                  value={c.caption}
                  disabled={locked}
                  onChange={(e) => setCaption(c.key, e.target.value)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {!result ? (
        <div className="space-y-2">
          <RunFooter
            label="Train audio LoRA"
            icon={<AudioLines className="w-4 h-4" />}
            busy={busy}
            disabled={avail === null || !avail.available}
            validation={run ? null : validation}
            error={error}
            queuedText={progress && busy ? audioLoraStageText(progress) : null}
            onRun={() => void train()}
          />
          {busy && !run && (
            <button
              type="button"
              onClick={() => void stop()}
              className="flex items-center gap-1.5 rounded-xl border border-light-100 px-4 py-2.5 text-sm dark:border-dark-750"
            >
              <X className="h-3.5 w-3.5" /> Cancel upload
            </button>
          )}
          {busy && run && !confirmStop && (
            <button
              type="button"
              onClick={() => setConfirmStop(true)}
              className="flex items-center gap-1.5 rounded-xl border border-light-100 px-4 py-2.5 text-sm dark:border-dark-750"
            >
              <Square className="h-3.5 w-3.5" /> Stop training
            </button>
          )}
          {busy && run && confirmStop && (
            <div
              role="group"
              aria-label="Confirm stop"
              className="flex flex-wrap items-center gap-2"
            >
              <span className="text-xs text-light-500 dark:text-dark-400">
                Stop now? The progress so far is lost.
              </span>
              <button
                type="button"
                onClick={() => void stop()}
                className="flex items-center gap-1.5 rounded-xl border border-red-300 px-4 py-2.5 text-sm text-red-600 dark:border-red-800 dark:text-red-400"
              >
                <Square className="h-3.5 w-3.5" /> Yes, stop training
              </button>
              <button
                type="button"
                onClick={() => setConfirmStop(false)}
                className="rounded-xl border border-light-100 px-4 py-2.5 text-sm dark:border-dark-750"
              >
                Keep training
              </button>
            </div>
          )}
          {busy && run && (
            <p className="text-xs text-light-500 dark:text-dark-400">
              Training uses the whole GPU, so other jobs wait until it ends. You
              can leave this page; come back here to see how it is going.
            </p>
          )}
        </div>
      ) : (
        <section className="space-y-3" data-testid="train-audio-lora-result">
          <p className="text-sm text-light-primary dark:text-dark-primary">
            Done. Your LoRA is saved as{" "}
            <span className="font-mono">{result.lora}</span> and is now
            selectable in the Stable Audio 3 audio tools. Use it with the same
            base model you trained on.
          </p>
          {result.summary && (
            <p className="text-xs font-mono text-light-500 dark:text-dark-400">
              {result.summary}
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            className="flex items-center gap-1.5 rounded-xl border border-light-100 dark:border-dark-750 px-4 py-2.5 text-sm text-light-500 dark:text-dark-400 hover:text-splash"
          >
            <AudioLines className="w-4 h-4" /> Train another
          </button>
        </section>
      )}
    </RunnerShell>
  );
}
