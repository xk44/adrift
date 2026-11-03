"use client";

import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  Heart,
  Loader2,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { CivitaiModel, CivitaiModelVersion, CivitaiSource } from "@/lib/civitai";
import {
  isCivitaiFileDownloaded,
  isCivitaiModelFullyDownloaded,
} from "@/lib/civitaiDownloadedStatus";
import { destLabel } from "@/lib/civitaiFolders";
import { civitaiThumbUrl, shouldBlurMedia } from "@/lib/explore/imageFeed";
import { useDownloadStore, type DownloadedModel } from "@/store/downloadStore";
import { primaryFileForVersion, useCivitaiDownload } from "./useCivitaiDownload";
import { ImportIntoAdriftButton } from "./ImportIntoAdriftButton";
import type { BackendProfile } from "@/lib/models/compat";
import {
  civitaiModelCompat,
  civitaiVersionCompat,
  compatChip,
  FILE_VERDICT_SHORT,
} from "@/lib/models/exploreCompat";
import { BestQuantBadge, CompatChip } from "@/components/models/CompatChip";

interface ThumbInfo {
  url: string;
  /** Start blurred (mature rating, or unrated on a mature-allowed feed). */
  mature: boolean;
}

function thumbnailFor(model: CivitaiModel, feedAllowsMature: boolean): ThumbInfo | null {
  const image = model.modelVersions?.find((version) => version.images?.[0]?.url)
    ?.images?.[0];
  if (!image?.url) return null;
  return {
    // Civitai CDN-resized variant instead of the full-res original
    url: civitaiThumbUrl(image.url),
    mature: shouldBlurMedia(
      { nsfw: image.nsfw ?? model.nsfw, nsfwLevel: image.nsfwLevel },
      feedAllowsMature,
    ),
  };
}

function MatureRevealButton({ onReveal }: { onReveal: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onReveal();
      }}
      aria-label="Reveal mature preview"
      className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-white"
    >
      <span className="rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-semibold">
        18+
      </span>
      <span className="text-xs text-white/85">Click to reveal</span>
    </button>
  );
}

function creatorFor(model: CivitaiModel): string | null {
  const candidate = model as CivitaiModel & {
    creator?: { username?: string };
    user?: { username?: string };
    username?: string;
  };
  return candidate.creator?.username ?? candidate.user?.username ?? candidate.username ?? null;
}

function versionStats(
  model: CivitaiModel,
  downloads: DownloadedModel[],
): string {
  const versions = model.modelVersions ?? [];
  if (versions.length === 0) return "No version metadata";
  const downloaded = versions.filter((version) =>
    downloads.some(
      (download) =>
        download.civitaiModelId === model.id &&
        download.civitaiVersionId === version.id,
    ),
  ).length;
  return `${downloaded}/${versions.length} versions local`;
}

function fileSizeLabel(sizeKB: number | undefined): string {
  if (!sizeKB) return "";
  if (sizeKB < 1024) return `${sizeKB} KB`;
  const mb = sizeKB / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function TriggerWords({ words }: { words: string[] }) {
  if (words.length === 0) {
    return (
      <span className="text-[10px] text-[var(--text-muted)]">
        No trigger words
      </span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {words.slice(0, 8).map((word) => (
        <span
          key={word}
          title={word}
          className="max-w-full truncate rounded-full border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]"
        >
          {word}
        </span>
      ))}
      {words.length > 8 && (
        <span className="text-[10px] text-[var(--text-muted)]">
          +{words.length - 8}
        </span>
      )}
    </div>
  );
}

/** " · fits · best for your GPU" suffix for a file picker option. */
function fileVerdictSuffix(
  verdict: keyof typeof FILE_VERDICT_SHORT | undefined,
  recommended: boolean,
): string {
  const short = verdict ? FILE_VERDICT_SHORT[verdict] : "";
  return `${short ? ` · ${short}` : ""}${recommended ? " · best for your GPU" : ""}`;
}

function VersionDownloadRow({
  model,
  version,
  source,
  nsfw,
  downloads,
  variant,
  profile,
}: {
  model: CivitaiModel;
  version: CivitaiModelVersion;
  source: CivitaiSource;
  nsfw: boolean;
  downloads: DownloadedModel[];
  variant: "browser" | "explore";
  profile: BackendProfile | null;
}) {
  const active = useDownloadStore((s) => s.activeDownloads[version.id]);
  const compat = useMemo(
    () => (profile ? civitaiVersionCompat(model.type, version, profile) : null),
    [model.type, version, profile],
  );
  const { cancel, download, filename, files, plan, selectedFile, selectFile, state } =
    useCivitaiDownload({
      model,
      version,
      source,
      nsfw,
      preferredFileName: compat?.recommendedKey,
    });
  const selectedCompat = selectedFile
    ? compat?.perFile[selectedFile.name]
    : undefined;
  const alreadyLocal = isCivitaiFileDownloaded(
    model.id,
    version.id,
    filename,
    downloads,
  );
  const isActive =
    state.status === "downloading" || state.status === "verifying";
  const shellClass =
    variant === "explore"
      ? "flex items-center gap-2 rounded-sm border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2"
      : "flex items-center gap-2 rounded-lg border border-light-100 bg-light-bg/50 px-3 py-2 dark:border-dark-750 dark:bg-dark-900/50";

  return (
    <div className={shellClass}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium text-[var(--text-primary)]">
            {version.name}
          </span>
          {version.baseModel && (
            <span className="shrink-0 rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
              {version.baseModel}
            </span>
          )}
          <BestQuantBadge
            label={compat?.bestQuantLabel ?? null}
            all={compat?.quantLabels ?? []}
          />
          {selectedFile?.sizeKB && (
            <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
              {fileSizeLabel(selectedFile.sizeKB)}
            </span>
          )}
        </div>
        {files.length > 1 ? (
          <select
            value={filename}
            onChange={(e) => selectFile(e.target.value)}
            disabled={isActive}
            aria-label="File to download"
            className="mt-0.5 w-full truncate rounded border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-1 py-0.5 text-[10px] text-[var(--text-secondary)]"
          >
            {files.map(({ file, plan: filePlan }) => (
              <option key={file.id ?? file.name} value={file.name}>
                {file.name}
                {file.type && file.type !== "Model" ? ` (${file.type})` : ""}
                {isCivitaiFileDownloaded(model.id, version.id, file.name, downloads)
                  ? " - downloaded"
                  : !filePlan.ok
                    ? " - browse only"
                    : ""}
                {fileVerdictSuffix(
                  compat?.perFile[file.name]?.verdict,
                  compat?.recommendedKey === file.name,
                )}
              </option>
            ))}
          </select>
        ) : (
          <p className="truncate text-[10px] text-[var(--text-muted)]">
            {filename}
          </p>
        )}
        {selectedCompat && selectedCompat.verdict !== "unknown" && (
          <p
            className="truncate text-[10px] text-[var(--text-muted)]"
            title={selectedCompat.reason}
            data-testid="file-compat-reason"
          >
            {selectedCompat.reason}
          </p>
        )}
        {plan.ok ? (
          <p
            className="truncate text-[10px] text-[var(--text-muted)]"
            title={plan.note}
          >
            Saves to {destLabel(plan.dest)}
            {plan.note ? ` · ${plan.note}` : ""}
          </p>
        ) : (
          <p className="text-[10px] text-[var(--text-muted)]">{plan.reason}</p>
        )}

        {state.status === "confirmPickle" && (
          <div className="mt-1.5 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-300">
            <p className="flex items-start gap-1">
              <AlertCircle className="mt-px h-3 w-3 shrink-0" />
              <span>
                This file uses an older format (.{filename.split(".").pop()}) that can
                run code when it loads. Only download it if you trust the creator.
              </span>
            </p>
            <div className="mt-1.5 flex gap-2">
              <button
                onClick={() => void download({ acceptPickle: true })}
                className="rounded-full bg-amber-500/20 px-2 py-0.5 font-medium text-amber-200 hover:bg-amber-500/30"
              >
                Download anyway
              </button>
              <button
                onClick={cancel}
                className="rounded-full px-2 py-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                Not now
              </button>
            </div>
          </div>
        )}

        {state.status === "conflict" && (
          <div className="mt-1.5 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-300">
            <p>{state.error ?? "A different file with this name is already there."}</p>
            <button
              onClick={() =>
                void download({ acceptPickle: plan.ok && plan.pickle, overwrite: true })
              }
              className="mt-1 rounded-full bg-amber-500/20 px-2 py-0.5 font-medium text-amber-200 hover:bg-amber-500/30"
            >
              Replace it
            </button>
          </div>
        )}

        {isActive && (
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
            {active && active.progress >= 0 ? (
              <div
                className="h-full rounded-full bg-[var(--accent-primary)] transition-[width] duration-300"
                style={{ width: `${Math.min(active.progress, 100)}%` }}
              />
            ) : (
              <div className="h-full animate-civitai-progress rounded-full bg-[var(--accent-primary)]" />
            )}
          </div>
        )}

        {state.status === "error" && state.error && (
          <p className="mt-1 flex items-center gap-1 text-[10px] text-red-400">
            <AlertCircle className="h-3 w-3 shrink-0" />
            <span className="truncate">{state.error}</span>
          </p>
        )}
      </div>

      <div className="shrink-0">
        {!plan.ok ? (
          <span
            title={plan.reason}
            className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-tertiary)] px-2 py-1 text-[10px] font-medium text-[var(--text-muted)]"
          >
            Browse only
          </span>
        ) : alreadyLocal || state.status === "done" ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-400">
            <Check className="h-3 w-3" />
            {state.skipped ? "Already local" : "Downloaded"}
          </span>
        ) : isActive ? (
          <button
            onClick={cancel}
            className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-1 text-[10px] font-medium text-red-400 transition-colors hover:bg-red-500/20"
            title="Cancel download"
          >
            <X className="h-3 w-3" />
            Cancel
          </button>
        ) : state.status === "error" ? (
          <button
            onClick={() => void download()}
            className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-400 transition-colors hover:bg-amber-500/20"
          >
            <RefreshCw className="h-3 w-3" />
            Retry
          </button>
        ) : (
          <button
            onClick={() => void download()}
            className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-primary)]/10 px-2 py-1 text-[10px] font-medium text-[var(--accent-primary)] transition-colors hover:bg-[var(--accent-primary)]/20"
          >
            <Download className="h-3 w-3" />
            Download
          </button>
        )}
      </div>
    </div>
  );
}

function ExploreModelCard({
  model,
  source,
  nsfw,
  downloads,
  profile,
}: {
  model: CivitaiModel;
  source: CivitaiSource;
  nsfw: boolean;
  downloads: DownloadedModel[];
  profile: BackendProfile | null;
}) {
  const [selectedVersionId, setSelectedVersionId] = useState(
    model.modelVersions?.[0]?.id ?? 0,
  );
  const thumb = thumbnailFor(model, nsfw);
  const [revealed, setRevealed] = useState(false);
  const blurred = Boolean(thumb?.mature) && !revealed;
  const versions = model.modelVersions ?? [];
  const selectedVersion =
    versions.find((version) => version.id === selectedVersionId) ?? versions[0];
  const creator = creatorFor(model);
  const fullyDownloaded = isCivitaiModelFullyDownloaded(model, downloads);
  const words = selectedVersion?.trainedWords ?? [];
  const chip = useMemo(
    () =>
      profile
        ? compatChip(
            civitaiVersionCompat(model.type, selectedVersion, profile),
            profile,
          )
        : null,
    [model.type, selectedVersion, profile],
  );

  return (
    <article className="group/modelCard overflow-hidden rounded-sm border border-[var(--border-primary)] bg-[var(--bg-secondary)] transition-colors hover:border-[var(--border-secondary)]">
      <div
        className="relative w-full bg-[var(--bg-tertiary)]"
        style={{ aspectRatio: "4 / 3" }}
      >
        {thumb ? (
          <div className="h-full w-full overflow-hidden">
            <img
              src={thumb.url}
              alt={model.name}
              className={`h-full w-full object-cover ${blurred ? "scale-110 blur-2xl" : ""}`}
              loading="lazy"
              decoding="async"
            />
            {blurred && <MatureRevealButton onReveal={() => setRevealed(true)} />}
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <SlidersHorizontal className="h-8 w-8 text-[var(--text-muted)]" />
          </div>
        )}
        <div className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-1 text-[10px] font-medium text-white backdrop-blur-sm">
          {model.type}
        </div>
        {fullyDownloaded && (
          <div className="absolute right-2 top-2 rounded-full bg-emerald-500/80 px-2 py-1 text-[10px] font-medium text-white backdrop-blur-sm">
            Local
          </div>
        )}
      </div>

      <div className="space-y-2 p-3">
        <div className="min-w-0">
          <h3
            className="truncate text-sm font-semibold text-[var(--text-primary)]"
            title={model.name}
          >
            {model.name}
          </h3>
          <p className="truncate text-xs text-[var(--text-muted)]">
            {creator ? `by ${creator}` : "Unknown creator"}
          </p>
        </div>

        <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-1">
            <Download className="h-3.5 w-3.5" />
            {model.stats?.downloadCount?.toLocaleString?.() ?? 0}
          </span>
          <span className="inline-flex items-center gap-1">
            <Heart className="h-3.5 w-3.5" />
            {(model.stats?.thumbsUpCount ?? model.stats?.favoriteCount ?? 0).toLocaleString()}
          </span>
          <span className="ml-auto">
            <CompatChip chip={chip} />
          </span>
        </div>

        {versions.length > 1 && (
          <select
            value={selectedVersion?.id ?? ""}
            onChange={(event) => setSelectedVersionId(Number(event.target.value))}
            aria-label="Model version"
            className="w-full rounded-full border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--text-secondary)] focus:border-[var(--border-secondary)] focus:outline-none"
          >
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                {version.name}
              </option>
            ))}
          </select>
        )}

        <TriggerWords words={words} />

        {selectedVersion && (
          <VersionDownloadRow
            model={model}
            version={selectedVersion}
            source={source}
            nsfw={nsfw}
            downloads={downloads}
            variant="explore"
            profile={profile}
          />
        )}
        <ImportIntoAdriftButton
          model={model}
          versionId={selectedVersion?.id}
          source={source}
        />
      </div>
    </article>
  );
}

function BrowserModelCard({
  model,
  source,
  nsfw,
  downloads,
  profile,
}: {
  model: CivitaiModel;
  source: CivitaiSource;
  nsfw: boolean;
  downloads: DownloadedModel[];
  profile: BackendProfile | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const chip = useMemo(
    () =>
      profile
        ? compatChip(civitaiModelCompat(model, profile), profile)
        : null,
    [model, profile],
  );
  const thumb = thumbnailFor(model, nsfw);
  // Expanding the card is an explicit click on it: it also reveals
  const blurred = Boolean(thumb?.mature) && !expanded;
  const fullyDownloaded = isCivitaiModelFullyDownloaded(model, downloads);
  const versions = model.modelVersions ?? [];
  const activeDownloads = useDownloadStore(
    useShallow((s) => versions.map((version) => s.activeDownloads[version.id])),
  );
  const hasActiveDownload = activeDownloads.some(Boolean);

  return (
    <article className="group overflow-hidden rounded-sm border border-transparent bg-light-input dark:bg-dark-input">
      <div
        className="flex cursor-pointer gap-3 p-3 transition-colors hover:bg-light-bg/50 dark:hover:bg-dark-900/30"
        onClick={() => versions.length > 0 && setExpanded((prev) => !prev)}
        role="button"
        tabIndex={0}
        aria-expanded={versions.length > 0 ? expanded : undefined}
        aria-label={`${model.name}: ${expanded ? "hide" : "show"} versions`}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          if (versions.length > 0) setExpanded((prev) => !prev);
        }}
      >
        <div className="h-24 w-24 shrink-0 overflow-hidden rounded-sm bg-light-bg dark:bg-dark-900">
          {thumb ? (
            <img
              src={thumb.url}
              alt=""
              className={`h-full w-full object-cover ${blurred ? "scale-110 blur-xl" : ""}`}
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-light-500 dark:text-dark-400">
              <SlidersHorizontal className="h-6 w-6" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <h3
              className="truncate text-sm font-semibold text-light-primary dark:text-dark-primary"
              title={model.name}
            >
              {model.name}
            </h3>
            <p className="text-xs text-light-500 dark:text-dark-400">
              {model.type} · {versionStats(model, downloads)}
            </p>
          </div>
          <div className="flex flex-wrap gap-1">
            <CompatChip chip={chip} />
            {(model.tags ?? []).slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-light-bg px-2 py-0.5 text-[10px] text-light-500 dark:bg-dark-900 dark:text-dark-400"
              >
                {tag}
              </span>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1">
              {hasActiveDownload && (
                <Loader2 className="h-3 w-3 animate-spin text-splash" />
              )}
              <span
                className={
                  fullyDownloaded
                    ? "text-emerald-400"
                    : "text-light-500 dark:text-dark-400"
                }
              >
                {fullyDownloaded
                  ? "Fully local"
                  : hasActiveDownload
                    ? "Downloading..."
                    : "Needs files"}
              </span>
            </span>
            <span className="inline-flex items-center gap-1 text-light-500 dark:text-dark-400">
              {versions.length > 0 &&
                (expanded ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                ))}
              <Download className="h-3.5 w-3.5" />{" "}
              {model.stats?.downloadCount?.toLocaleString?.() ?? 0}
            </span>
          </div>
        </div>
      </div>

      {expanded && versions.length > 0 && (
        <div className="space-y-1 border-t border-light-100 px-3 pb-3 pt-2 dark:border-dark-750">
          <p className="mb-1.5 text-[10px] font-medium text-light-500 dark:text-dark-400">
            Versions ({versions.length})
          </p>
          {versions.map((version) => (
            <div key={version.id} className="space-y-1.5">
              {(version.trainedWords ?? []).length > 0 && (
                <TriggerWords words={version.trainedWords ?? []} />
              )}
              <VersionDownloadRow
                model={model}
                version={version}
                source={source}
                nsfw={nsfw}
                downloads={downloads}
                variant="browser"
                profile={profile}
              />
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

export function ModelCard({
  model,
  source,
  nsfw,
  downloads,
  variant = "browser",
  profile = null,
}: {
  model: CivitaiModel;
  source: CivitaiSource;
  nsfw: boolean;
  downloads: DownloadedModel[];
  variant?: "browser" | "explore";
  /** Connected GPU profile; null hides compat chips / badges. */
  profile?: BackendProfile | null;
}) {
  return variant === "explore" ? (
    <ExploreModelCard
      model={model}
      source={source}
      nsfw={nsfw}
      downloads={downloads}
      profile={profile}
    />
  ) : (
    <BrowserModelCard
      model={model}
      source={source}
      nsfw={nsfw}
      downloads={downloads}
      profile={profile}
    />
  );
}

export { primaryFileForVersion };
