"use client";

import { useState } from "react";
import { Pencil, Plus, Trash2, UserRound, X } from "lucide-react";
import { useCharacterProfileStore } from "@/store/characterProfileStore";
import {
  IDENTITY_ENGINES,
  PROFILE_LOOK_FIELDS,
  PROFILE_MAX_REFS,
  PROFILE_NAME_MAX,
  PROFILE_SUFFIX_MAX,
  DEFAULT_IDENTITY_ENGINE,
  compileProfileLook,
  fromStoredRef,
  identityEngine,
  profilePromptSuffix,
  profileRefShrink,
  validateProfileDraft,
  type CharacterProfile,
  type ProfileLook,
  type ProfileLookKey,
} from "@/lib/tools/characterProfiles";
import type { ToolImage } from "@/lib/tools/runTool";
import { resampleToCanvas } from "@/lib/canvasResample";
import { RUN_BUTTON, RunnerShell } from "./RunnerShell";
import { ToolImageInput } from "./ToolImageInput";
import { Segmented, field } from "./ToolRunner";

/**
 * Fit an upload into browser storage: kept byte for byte when already small,
 * else resampled (high quality, in halving steps) to PROFILE_REF_MAX_SIDE.
 */
function shrinkUpload(img: ToolImage): Promise<ToolImage> {
  if (img.source !== "upload" || !img.dataUrl) return Promise.resolve(img);
  const src = img.dataUrl;
  return new Promise((resolve) => {
    const el = new Image();
    el.onload = () => {
      const w = el.naturalWidth;
      const h = el.naturalHeight;
      const target = profileRefShrink(w, h, src.length);
      if (!target) return resolve({ ...img, width: w, height: h });
      try {
        const canvas = resampleToCanvas(
          el,
          w,
          h,
          target.width,
          target.height,
          "#fff",
        );
        const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
        resolve({
          ...img,
          dataUrl,
          previewUrl: dataUrl,
          width: target.width,
          height: target.height,
        });
      } catch {
        resolve(img);
      }
    };
    el.onerror = () => resolve(img);
    el.src = src;
  });
}

interface Draft {
  id?: string;
  name: string;
  refs: ToolImage[];
  look: ProfileLook;
  suffix: string;
  engine: string;
}

const emptyDraft = (): Draft => ({
  name: "",
  refs: [],
  look: {},
  suffix: "",
  engine: DEFAULT_IDENTITY_ENGINE,
});

const fromProfile = (p: CharacterProfile): Draft => ({
  id: p.id,
  name: p.name,
  refs: p.refs.map(fromStoredRef),
  look: { ...p.look },
  suffix: p.suffix,
  engine: p.engine,
});

let refSeq = 0;

/**
 * Character Profiles: save a reusable identity (references + look + prompt
 * suffix + engine) and use it from any tool that takes a reference image.
 */
export function CharacterProfiles({
  onBack,
  onOpenTool,
}: {
  onBack: () => void;
  onOpenTool?: (key: string) => void;
}) {
  const profiles = useCharacterProfileStore((s) => s.profiles);
  const saveProfile = useCharacterProfileStore((s) => s.saveProfile);
  const removeProfile = useCharacterProfileStore((s) => s.removeProfile);
  const armProfile = useCharacterProfileStore((s) => s.armProfile);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const editing = draft !== null;
  const validation = draft ? validateProfileDraft(draft) : null;

  const addRef = async (img: ToolImage | null) => {
    if (!img || !draft) return;
    if (draft.refs.some((r) => r.source === "gallery" && r.id === img.id))
      return;
    const small = await shrinkUpload(img);
    refSeq += 1;
    const ref =
      small.source === "upload"
        ? { ...small, id: `upload:${Date.now().toString(36)}${refSeq}` }
        : small;
    setDraft((d) =>
      d && d.refs.length < PROFILE_MAX_REFS
        ? { ...d, refs: [...d.refs, ref] }
        : d,
    );
  };

  const save = () => {
    if (!draft) return;
    const r = saveProfile(draft);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setError(null);
    setDraft(null);
  };

  const use = (p: CharacterProfile) => {
    armProfile(p.id);
    onOpenTool?.(identityEngine(p.engine).toolKey);
  };

  return (
    <RunnerShell
      title="Character Profiles"
      subtitle="Save a character once (references, look, prompt suffix, engine) and reuse it in any tool that takes a reference image."
      model="Reference identity · Krea 2 identity edit / Character Reference · no training"
      onBack={onBack}
      testId="character-profiles"
    >
      {!editing && (
        <section className="space-y-3">
          <button
            type="button"
            onClick={() => {
              setError(null);
              setDraft(emptyDraft());
            }}
            className="flex items-center gap-1.5 rounded-xl border border-light-100 dark:border-dark-750 px-4 py-2.5 text-sm text-light-primary dark:text-dark-primary hover:border-splash"
          >
            <Plus className="w-4 h-4" /> New profile
          </button>
          {profiles.length === 0 && (
            <p className="text-xs text-light-500 dark:text-dark-400">
              No profiles yet. A profile keeps 1-{PROFILE_MAX_REFS} reference
              images of one character; pick it from the Character profile row in
              image and video tools. Profiles are stored in this browser.
            </p>
          )}
          <ul className="grid gap-2 sm:grid-cols-2">
            {profiles.map((p) => {
              const look = profilePromptSuffix(p);
              return (
                <li
                  key={p.id}
                  className="flex gap-3 rounded-xl border border-light-100 dark:border-dark-750 p-2"
                >
                  <div className="grid h-16 w-16 flex-shrink-0 grid-cols-2 gap-0.5 overflow-hidden rounded-lg">
                    {p.refs.map((r, i) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={r.id}
                        src={fromStoredRef(r).previewUrl}
                        alt=""
                        className={`h-full w-full object-cover ${
                          p.refs.length === 1
                            ? "col-span-2 row-span-2"
                            : p.refs.length === 2 ||
                                (p.refs.length === 3 && i === 0)
                              ? "row-span-2"
                              : ""
                        }`}
                      />
                    ))}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="truncate text-sm font-medium text-light-primary dark:text-dark-primary">
                      {p.name}
                    </p>
                    <p className="truncate text-[11px] text-light-500 dark:text-dark-400">
                      {identityEngine(p.engine).label} · {p.refs.length} ref
                      {p.refs.length === 1 ? "" : "s"}
                    </p>
                    {look && (
                      <p className="line-clamp-2 text-[11px] text-light-500 dark:text-dark-400">
                        {look}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => use(p)}
                        className="rounded-lg bg-splash px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90"
                      >
                        Use
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setError(null);
                          setDraft(fromProfile(p));
                        }}
                        aria-label={`Edit ${p.name}`}
                        className="flex items-center gap-1 text-[11px] text-light-500 dark:text-dark-400 hover:text-splash"
                      >
                        <Pencil className="h-3 w-3" /> Edit
                      </button>
                      {confirmDelete === p.id ? (
                        <button
                          type="button"
                          onClick={() => {
                            removeProfile(p.id);
                            setConfirmDelete(null);
                          }}
                          className="text-[11px] font-medium text-red-500"
                        >
                          Confirm delete
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(p.id)}
                          aria-label={`Delete ${p.name}`}
                          className="flex items-center gap-1 text-[11px] text-light-500 dark:text-dark-400 hover:text-red-500"
                        >
                          <Trash2 className="h-3 w-3" /> Delete
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {draft && (
        <section className="space-y-5" aria-label="Profile editor">
          <section className="space-y-1.5">
            <label
              htmlFor="profile-name"
              className="text-xs font-medium text-light-primary dark:text-dark-primary"
            >
              Name
            </label>
            <input
              id="profile-name"
              className={field}
              maxLength={PROFILE_NAME_MAX}
              placeholder="e.g. Mara, travel creator"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </section>

          <section className="space-y-2">
            <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
              Reference images ({draft.refs.length}/{PROFILE_MAX_REFS})
            </span>
            {draft.refs.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {draft.refs.map((r, i) => (
                  <div key={r.id} className="relative h-20 w-20">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={r.previewUrl}
                      alt={r.label}
                      className="h-full w-full rounded-lg object-cover"
                    />
                    <button
                      type="button"
                      aria-label={`Remove reference ${i + 1}`}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          refs: draft.refs.filter((_, j) => j !== i),
                        })
                      }
                      className="absolute -right-1.5 -top-1.5 rounded-full bg-black/70 p-0.5 text-white hover:bg-red-500"
                    >
                      <X className="h-3 w-3" />
                    </button>
                    {i === 0 && (
                      <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[10px] text-white">
                        main
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {draft.refs.length < PROFILE_MAX_REFS && (
              <ToolImageInput
                key={draft.refs.length}
                label="Add a reference (your upload or a gallery image)"
                value={null}
                maxSide={null}
                onChange={(img) => void addRef(img)}
              />
            )}
            <p className="text-[11px] text-light-500 dark:text-dark-400">
              Clear, well-lit shots of one person or character. The first image
              is the default reference. Uploads are stored downscaled in this
              browser.
            </p>
          </section>

          {PROFILE_LOOK_FIELDS.map((f) => (
            <Segmented
              key={f.key}
              label={f.label}
              value={draft.look[f.key as ProfileLookKey] ?? f.options[0].id}
              options={f.options}
              onChange={(id) =>
                setDraft({ ...draft, look: { ...draft.look, [f.key]: id } })
              }
            />
          ))}

          <section className="space-y-1.5">
            <label
              htmlFor="profile-suffix"
              className="text-xs font-medium text-light-primary dark:text-dark-primary"
            >
              Prompt suffix (optional)
            </label>
            <input
              id="profile-suffix"
              className={field}
              maxLength={PROFILE_SUFFIX_MAX}
              placeholder="e.g. copper hair, small nose ring, green eyes"
              value={draft.suffix}
              onChange={(e) => setDraft({ ...draft, suffix: e.target.value })}
            />
            {(compileProfileLook(draft.look) || draft.suffix.trim()) && (
              <p className="text-[11px] text-light-500 dark:text-dark-400">
                Adds to prompts:{" "}
                <span className="font-mono">{profilePromptSuffix(draft)}</span>
              </p>
            )}
          </section>

          <section className="space-y-1.5">
            <Segmented
              label="Identity engine"
              value={draft.engine}
              options={IDENTITY_ENGINES}
              onChange={(id) => setDraft({ ...draft, engine: id })}
            />
            <p className="text-[11px] text-light-500 dark:text-dark-400">
              {identityEngine(draft.engine).hint} Identity comes from the
              reference images at run time; nothing is trained.
            </p>
          </section>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={validation !== null}
              className={RUN_BUTTON}
            >
              <UserRound className="w-4 h-4" />
              {draft.id ? "Save changes" : "Save profile"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
              className="rounded-full px-4 py-2.5 text-sm text-light-500 dark:text-dark-400 hover:text-splash"
            >
              Cancel
            </button>
          </div>
          {validation && (
            <p className="text-[11px] text-light-500 dark:text-dark-400">
              {validation}
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-red-500">
              {error}
            </p>
          )}
        </section>
      )}
    </RunnerShell>
  );
}
