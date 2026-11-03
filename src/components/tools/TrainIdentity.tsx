"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, PenLine, Rocket, UserSquare, X } from "lucide-react";
import { useUIStore } from "@/store";
import { useStyleStore } from "@/store/styleStore";
import { LoraRunPanel } from "@/components/training/LoraRunPanel";
import {
  IDENTITY_FAMILIES,
  IDENTITY_MAX_PHOTOS,
  IDENTITY_MIN_PHOTOS,
  IDENTITY_PRESETS,
  IDENTITY_SUBJECTS,
  buildIdentityJob,
  findIdentityLora,
  identityPrompt,
  validateIdentityInput,
  type IdentityCaptionMode,
  type IdentityPreset,
  type IdentitySubject,
} from "@/lib/training/identityJob";
import {
  getTrainerStatus,
  submitIdentityTraining,
  type IdentityPhoto,
  type IdentityStage,
  type TrainerStatus,
} from "@/lib/training/identitySubmit";
import {
  readProfileSeeds,
  type ProfileSeed,
} from "@/lib/training/identityProfiles";
import type { TrainingModelFamily } from "@/lib/sref/apiClient";
import type { Moodboard } from "@/types";
import { RunFooter, RunnerShell } from "./RunnerShell";
import { Segmented, field } from "./ToolRunner";
import { TrainerSetupLink } from "@/components/settings/TrainerSetupLink";

interface PhotoItem {
  key: string;
  /** Preview + source: object URL (file), data: or same-origin URL (profile). */
  url: string;
  blob?: Blob;
  note: string;
}

const ACCEPT = "image/png,image/jpeg,image/webp";

const CAPTION_MODES: { id: IdentityCaptionMode; label: string }[] = [
  { id: "trigger", label: "Trigger + notes" },
  { id: "auto", label: "Auto-caption" },
];

function stageText(stage: IdentityStage, done?: number, total?: number) {
  switch (stage) {
    case "check":
      return "Checking the trainer...";
    case "upload":
      return `Uploading photos (${done ?? 0}/${total ?? 0})...`;
    case "dataset":
      return "Saving the dataset...";
    default:
      return "Starting training...";
  }
}

/**
 * Train Identity: 10-30 photos -> captions -> LoRA job spec sized for a
 * 24 GB card -> StyleVault trainer. Progress and deploy reuse LoraRunPanel;
 * a deployed LoRA lands in the LoRA shortcodes (`--lora name`).
 */
export function TrainIdentity({ onBack }: { onBack: () => void }) {
  const setActiveNav = useUIStore((s) => s.setActiveNav);
  const setPromptValue = useUIStore((s) => s.setPromptValue);
  const loraShortcodes = useStyleStore((s) => s.loraShortcodes);

  const [status, setStatus] = useState<TrainerStatus | null>(null);
  const [profiles, setProfiles] = useState<ProfileSeed[]>([]);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState("");
  const [subject, setSubject] = useState<IdentitySubject>("person");
  const [family, setFamily] = useState<TrainingModelFamily>("krea2");
  const [preset, setPreset] = useState<IdentityPreset>("balanced");
  const [captionMode, setCaptionMode] =
    useState<IdentityCaptionMode>("trigger");
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [board, setBoard] = useState<Moodboard | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const keySeq = useRef(0);
  const photosRef = useRef(photos);
  photosRef.current = photos;

  useEffect(() => {
    let live = true;
    void getTrainerStatus().then((s) => live && setStatus(s));
    setProfiles(readProfileSeeds());
    return () => {
      live = false;
      for (const p of photosRef.current) if (p.blob) URL.revokeObjectURL(p.url);
    };
  }, []);

  const input = {
    name,
    triggerWord: trigger,
    subject,
    photoCount: photos.length,
    family,
    preset,
    captionMode,
    notes: photos.map((p) => p.note),
  };
  const validation = validateIdentityInput(input);
  const spec = useMemo(
    () => (validation ? null : buildIdentityJob(input)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [validation, name, trigger, subject, family, preset, captionMode, photos],
  );

  const blockedReason =
    status && !status.configured
      ? (status.error ?? "Trainer not configured.")
      : status && !status.families.includes(family)
        ? `Trainer not configured for this model (available: ${status.families.join(", ") || "none"}).`
        : null;

  const addItems = (items: Omit<PhotoItem, "key">[]) => {
    setPhotos((prev) => {
      const room = IDENTITY_MAX_PHOTOS - prev.length;
      const kept = items.slice(0, Math.max(0, room));
      for (const dropped of items.slice(kept.length))
        if (dropped.blob) URL.revokeObjectURL(dropped.url);
      return [
        ...prev,
        ...kept.map((it) => ({ ...it, key: `p${keySeq.current++}` })),
      ];
    });
  };

  const onFiles = (files: FileList | null) => {
    if (!files) return;
    addItems(
      [...files]
        .filter((f) => ACCEPT.split(",").includes(f.type))
        .map((f) => ({ url: URL.createObjectURL(f), blob: f, note: "" })),
    );
    if (fileRef.current) fileRef.current.value = "";
  };

  const addProfile = (id: string) => {
    const p = profiles.find((x) => x.id === id);
    if (!p) return;
    if (!name.trim()) setName(p.name.slice(0, 60));
    const have = new Set(photos.map((x) => x.url));
    addItems(
      p.photos.filter((u) => !have.has(u)).map((url) => ({ url, note: "" })),
    );
  };

  const remove = (key: string) =>
    setPhotos((prev) => {
      const hit = prev.find((p) => p.key === key);
      if (hit?.blob) URL.revokeObjectURL(hit.url);
      return prev.filter((p) => p.key !== key);
    });

  const setNote = (key: string, note: string) =>
    setPhotos((prev) => prev.map((p) => (p.key === key ? { ...p, note } : p)));

  const train = async () => {
    if (!spec) return;
    setBusy(true);
    setError(null);
    try {
      const sources: IdentityPhoto[] = photos.map((p) =>
        p.blob ? { blob: p.blob } : { url: p.url },
      );
      const res = await submitIdentityTraining(spec, sources, {
        onStage: (s, d, t) => setProgress(stageText(s, d, t)),
      });
      setBoard(res.board);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Training failed to start.");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const triggerWord = spec?.triggerWord ?? "";
  const deployed = triggerWord
    ? findIdentityLora(loraShortcodes, triggerWord)
    : null;

  const openInCreate = () => {
    if (!spec || !deployed) return;
    setPromptValue(identityPrompt(spec, deployed));
    setActiveNav("create");
  };

  return (
    <RunnerShell
      title="Train Identity"
      subtitle="Turn 10-30 photos of one person into a personal LoRA. Train once, then call them by trigger word in any prompt."
      model="Krea 2 LoRA via musubi-tuner · sized for a 24 GB GPU"
      blockedReason={blockedReason}
      checking={status === null}
      onBack={onBack}
      testId="train-identity"
    >
      {blockedReason?.includes("Settings → Training") && (
        <TrainerSetupLink className="text-xs" />
      )}
      <section className="space-y-1.5">
        <label
          htmlFor="ti-name"
          className="text-xs font-medium text-light-primary dark:text-dark-primary"
        >
          Name
        </label>
        <input
          id="ti-name"
          className={field}
          maxLength={60}
          placeholder="e.g. Ana"
          value={name}
          disabled={busy || !!board}
          onChange={(e) => setName(e.target.value)}
        />
      </section>

      <section className="space-y-1.5">
        <label
          htmlFor="ti-trigger"
          className="text-xs font-medium text-light-primary dark:text-dark-primary"
        >
          Trigger word (optional)
        </label>
        <input
          id="ti-trigger"
          className={`${field} font-mono`}
          maxLength={40}
          placeholder={spec?.triggerWord ?? "derived from the name"}
          value={trigger}
          disabled={busy || !!board}
          onChange={(e) =>
            setTrigger(e.target.value.toLowerCase().replace(/\s+/g, ""))
          }
        />
      </section>

      <Segmented
        label="Subject"
        value={subject}
        options={IDENTITY_SUBJECTS}
        disabled={busy || !!board}
        onChange={(id) => setSubject(id as IdentitySubject)}
      />
      <Segmented
        label="Model"
        value={family}
        options={IDENTITY_FAMILIES}
        disabled={busy || !!board}
        onChange={(id) => setFamily(id as TrainingModelFamily)}
      />
      <Segmented
        label="Training length"
        value={preset}
        options={IDENTITY_PRESETS}
        disabled={busy || !!board}
        onChange={(id) => setPreset(id as IdentityPreset)}
      />
      <p className="-mt-4 text-xs text-light-500 dark:text-dark-400">
        {IDENTITY_PRESETS.find((p) => p.id === preset)?.hint}
      </p>
      <Segmented
        label="Captions"
        value={captionMode}
        options={CAPTION_MODES}
        disabled={busy || !!board}
        onChange={(id) => setCaptionMode(id as IdentityCaptionMode)}
      />

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
            Photos ({photos.length}/{IDENTITY_MAX_PHOTOS}, at least{" "}
            {IDENTITY_MIN_PHOTOS})
          </span>
          <div className="flex flex-wrap gap-2">
            {profiles.length > 0 && (
              <select
                aria-label="Add photos from a character profile"
                className={`${field} w-auto py-1.5`}
                value=""
                disabled={busy || !!board}
                onChange={(e) => addProfile(e.target.value)}
              >
                <option value="">From a profile...</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.photos.length})
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              disabled={busy || !!board || photos.length >= IDENTITY_MAX_PHOTOS}
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-1.5 rounded-lg border border-light-100 dark:border-dark-750 px-3 py-1.5 text-sm text-light-500 dark:text-dark-400 hover:text-splash disabled:opacity-50"
            >
              <ImagePlus className="w-4 h-4" /> Add photos
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              multiple
              hidden
              onChange={(e) => onFiles(e.target.files)}
            />
          </div>
        </div>
        <p className="text-xs text-light-500 dark:text-dark-400">
          Mix close-ups, half-body and full-body shots with different light,
          clothes and backgrounds. One person per photo, face visible.
        </p>
        {photos.length > 0 && (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {photos.map((p, i) => (
              <li
                key={p.key}
                className="space-y-1 rounded-lg border border-light-100 dark:border-dark-750 p-1.5"
              >
                <div className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.url}
                    alt={`Training photo ${i + 1}`}
                    className="aspect-square w-full rounded-md object-cover"
                  />
                  {!busy && !board && (
                    <button
                      type="button"
                      aria-label={`Remove photo ${i + 1}`}
                      onClick={() => remove(p.key)}
                      className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
                <input
                  aria-label={`Caption note for photo ${i + 1}`}
                  className={`${field} px-2 py-1 text-xs`}
                  maxLength={200}
                  placeholder="note (optional)"
                  value={p.note}
                  disabled={busy || !!board}
                  onChange={(e) => setNote(p.key, e.target.value)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {spec && (
        <div
          className="space-y-1 rounded-xl border border-light-100 dark:border-dark-750 p-3 text-xs font-mono text-light-500 dark:text-dark-400"
          data-testid="train-identity-spec"
        >
          <div>
            trigger {spec.triggerWord} · {spec.request.steps} steps · rank{" "}
            {spec.request.rank} · {spec.request.resolution}px · lr{" "}
            {spec.request.lr} · block swap {spec.request.blocks_to_swap}
          </div>
          <div>
            caption:{" "}
            {spec.captions[0] || "auto (trainer captioner, trigger first)"}
          </div>
          <div>prompt: {spec.activation}, ...</div>
        </div>
      )}

      {!board ? (
        <RunFooter
          label="Train identity"
          masterFile={false}
          icon={<Rocket className="w-4 h-4" />}
          busy={busy}
          disabled={status === null || blockedReason !== null}
          validation={validation}
          error={error}
          queuedText={progress}
          onRun={train}
        />
      ) : (
        <section className="space-y-3">
          <p className="text-sm text-light-primary dark:text-dark-primary">
            Training started on the dataset &ldquo;{board.name}&rdquo;. When it
            finishes, deploy it below; it then shows up in your LoRAs and the
            trigger <span className="font-mono">{triggerWord}</span> calls it.
            You can leave this page; the run keeps going and is listed under
            Characters.
          </p>
          <LoraRunPanel board={board} active />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!deployed}
              onClick={openInCreate}
              title={deployed ? undefined : "Deploy the LoRA first"}
              className="flex items-center gap-1.5 rounded-xl border border-light-100 dark:border-dark-750 px-4 py-2.5 text-sm text-light-500 dark:text-dark-400 hover:text-splash disabled:opacity-50"
            >
              <PenLine className="w-4 h-4" /> Open in Create
            </button>
            <button
              type="button"
              onClick={() => {
                for (const p of photos) if (p.blob) URL.revokeObjectURL(p.url);
                setPhotos([]);
                setBoard(null);
                setName("");
                setTrigger("");
              }}
              className="flex items-center gap-1.5 rounded-xl border border-light-100 dark:border-dark-750 px-4 py-2.5 text-sm text-light-500 dark:text-dark-400 hover:text-splash"
            >
              <UserSquare className="w-4 h-4" /> Train another
            </button>
          </div>
        </section>
      )}
    </RunnerShell>
  );
}
