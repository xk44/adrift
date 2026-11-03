"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  ExternalLink,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  fetchCommand,
  formatGb,
  missingRequirements,
  selectionDownload,
} from "@/lib/onboarding/starterPacks";
import type { PackView, PacksResponse } from "./api";
import { PackDownloadWatch } from "./PackDownloadWatch";
import { ToolPicker } from "./ToolPicker";
import { NO_TOOL_PICKS, type ToolPicks } from "@/lib/onboarding/toolPicker";
import { LicenseLink } from "@/components/models/LicenseLink";
import {
  BTN,
  CHIP_NEUTRAL,
  CHIP_OK,
  CHIP_WARN,
  Chip,
  CommandBox,
  MUTED,
  VerdictChip,
  useCopy,
} from "./ui";

function fileName(dest: string): string {
  return dest.slice(dest.lastIndexOf("/") + 1);
}

/** "Non-commercial" only when a license forbids it; NC beats restricted. */
export function licenseChipLabel(
  licenses: { commercial: "yes" | "restricted" | "no" | "unverified" }[],
): string {
  if (licenses.some((l) => l.commercial === "no")) return "Non-commercial";
  if (licenses.some((l) => l.commercial === "restricted"))
    return "License limits";
  return "Check license";
}

/** Licenses to list on a pack card: per file, else the pack's own. */
export function packLicenseLinks(
  pack: Pick<PackView, "licenses" | "licenseName" | "licenseUrl">,
): { name: string; url: string | null }[] {
  if (pack.licenses.length)
    return pack.licenses.map((l) => ({ name: l.license, url: l.url ?? null }));
  return pack.licenseName
    ? [{ name: pack.licenseName, url: pack.licenseUrl }]
    : [];
}

/** The license behind the warning chip: the first one not cleared for
 * commercial use (NC first), else the pack's own. */
export function restrictiveLicense(
  pack: Pick<PackView, "licenses" | "licenseName" | "licenseUrl">,
): { name: string; url: string | null } {
  const l =
    pack.licenses.find((x) => x.commercial === "no") ??
    pack.licenses.find((x) => x.commercial !== "yes");
  if (l) return { name: l.license, url: l.url ?? null };
  return {
    name: pack.licenseName ?? licenseChipLabel(pack.licenses),
    url: pack.licenseUrl,
  };
}

interface SharedFile {
  others: number;
  uses: string | null;
}

function SharedChip({ shared }: { shared: SharedFile }) {
  const packs = `${shared.others} other pack${shared.others === 1 ? "" : "s"}`;
  return (
    <Chip className={CHIP_NEUTRAL}>
      {shared.uses
        ? `Gets ${fileName(shared.uses)} instead, shared with ${packs}`
        : `Shared with ${packs}`}
    </Chip>
  );
}

export function PackCard({
  pack,
  selected,
  onToggle,
  copied,
  onCopy,
  sharedWith,
}: {
  pack: PackView;
  selected: boolean;
  onToggle: () => void;
  copied: string | null;
  onCopy: (id: string, text: string) => void;
  /** The pack's file dest -> how many other selected packs download it, and
   *  the drop-in option fetched instead when another pack already takes it. */
  sharedWith?: Map<string, SharedFile>;
}) {
  const done = pack.allInstalled;
  const inputId = `pack-${pack.id}`;
  return (
    <li
      id={`pack-card-${pack.id}`}
      data-testid={`pack-card-${pack.id}`}
      className={`rounded-xl border p-3 transition-colors ${
        selected && !done
          ? "border-splash bg-splash/5"
          : "border-light-200 dark:border-dark-750"
      }`}
    >
      <div className="flex items-start gap-3">
        <input
          id={inputId}
          type="checkbox"
          checked={done || selected}
          disabled={done}
          onChange={onToggle}
          className="mt-0.5 h-5 w-5 flex-shrink-0 accent-splash"
        />
        <label htmlFor={inputId} className="min-w-0 flex-1 cursor-pointer">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-[14px] font-semibold">{pack.title}</span>
            {done ? (
              <Chip className={CHIP_OK}>Installed</Chip>
            ) : (
              pack.verdict && (
                <VerdictChip
                  verdict={pack.verdict}
                  reason={pack.verdictReason}
                />
              )
            )}
            {pack.nonCommercial && (
              <LicenseLink
                {...restrictiveLicense(pack)}
                className="hover:opacity-80"
              >
                <Chip
                  className={CHIP_WARN}
                  title={
                    pack.licenseNote ??
                    pack.licenses.map((l) => l.license).join(", ")
                  }
                >
                  {licenseChipLabel(pack.licenses)}
                </Chip>
              </LicenseLink>
            )}
          </span>
          <span className={`mt-0.5 block text-[12px] ${MUTED}`}>
            {pack.blurb}
          </span>
          <span className={`mt-1 block text-[12px] ${MUTED}`}>
            {done
              ? "All files are already in ComfyUI."
              : pack.needBytes < pack.totalBytes
                ? `${formatGb(pack.needBytes)} to download (${formatGb(pack.totalBytes)} total)`
                : `${formatGb(pack.totalBytes)} download`}
            {packLicenseLinks(pack).map((l, i) => (
              <span key={l.name}>
                {i === 0 ? " · " : ", "}
                <LicenseLink
                  name={l.name}
                  url={l.url}
                  className={`${MUTED} underline underline-offset-2 hover:text-splash`}
                />
              </span>
            ))}
          </span>
          {pack.licenseNote && (
            <span className={`mt-1 block text-[12px] ${MUTED}`}>
              {pack.licenseNote}
            </span>
          )}
          {!done &&
            pack.verdict &&
            pack.verdict !== "fits" &&
            pack.verdictReason && (
              <span className="mt-1 block text-[12px] text-amber-700 dark:text-amber-300">
                {pack.verdictReason}
              </span>
            )}
        </label>
      </div>
      <details className="group mt-1 pl-8">
        <summary
          className={`flex min-h-[32px] cursor-pointer list-none items-center gap-1 text-[12px] ${MUTED} [&::-webkit-details-marker]:hidden`}
        >
          <ChevronRight
            aria-hidden
            className="-ml-0.5 h-3.5 w-3.5 flex-shrink-0 transition-transform group-open:rotate-90"
          />
          {pack.files.length} file{pack.files.length === 1 ? "" : "s"}
          {pack.unlocks.length > 0 && ` · unlocks ${pack.unlocks.join(", ")}`}
        </summary>
        <ul className="mt-1 space-y-2">
          {pack.files.map((f) => (
            <li key={f.dest} className="space-y-1 text-[12px]">
              <p className="flex flex-wrap items-center gap-1.5">
                <span className="break-all font-mono">{fileName(f.dest)}</span>
                <span className={MUTED}>{formatGb(f.bytes)}</span>
                {f.installed ? (
                  <Chip className={CHIP_OK}>
                    <Check className="mr-0.5 h-3 w-3" /> Installed
                  </Chip>
                ) : (
                  f.compat && (
                    <VerdictChip
                      verdict={f.compat.verdict}
                      reason={f.compat.reason}
                    />
                  )
                )}
                {f.compat && f.compat.quant.kind !== "unknown" && (
                  <Chip className={CHIP_NEUTRAL}>{f.compat.quant.id}</Chip>
                )}
                {f.optional && <Chip className={CHIP_NEUTRAL}>Optional</Chip>}
                {!f.installed && sharedWith?.get(f.dest) && (
                  <SharedChip shared={sharedWith.get(f.dest)!} />
                )}
                {f.gated && <Chip className={CHIP_NEUTRAL}>Login needed</Chip>}
                {f.license && f.license.commercial !== "yes" && (
                  <LicenseLink
                    name={f.license.license}
                    url={f.license.url}
                    className="hover:opacity-80"
                  >
                    <Chip className={CHIP_WARN}>{f.license.license}</Chip>
                  </LicenseLink>
                )}
                {f.license && f.license.commercial === "yes" && (
                  <LicenseLink
                    name={f.license.license}
                    url={f.license.url}
                    className={`${MUTED} underline underline-offset-2 hover:text-splash`}
                  />
                )}
              </p>
              {f.optional && f.optionalNote && (
                <p className={MUTED}>{f.optionalNote}</p>
              )}
              {f.alternative && (
                <p className={MUTED}>
                  Picked for your GPU instead of{" "}
                  {f.otherOptions.map(fileName).join(", ")}.
                </p>
              )}
              {!f.installed && f.hfCommand && (
                <CommandBox
                  id={`hf-${f.dest}`}
                  text={f.hfCommand}
                  copied={copied}
                  onCopy={onCopy}
                  label="Copy Hugging Face command"
                />
              )}
              {!f.installed && !f.repo && f.page && (
                <a
                  href={f.page}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex min-h-[32px] items-center gap-1 text-splash underline underline-offset-2"
                >
                  Download page <ExternalLink className="h-3 w-3" />
                  <span className="sr-only">(put it in models/{f.dest})</span>
                </a>
              )}
              {!f.installed && !f.repo && (
                <p className={MUTED}>Save it as models/{f.dest}</p>
              )}
            </li>
          ))}
          {pack.nodePacks.length > 0 && (
            <li className={`text-[12px] ${MUTED}`}>
              Also needs the {pack.nodePacks.join(", ")} custom node
              {pack.nodePacks.length > 1 ? "s" : ""}. Install with:{" "}
              <code className="font-mono">
                python3 docker/install-comfy-packs.py
                &lt;ComfyUI&gt;/custom_nodes --only
                krea2t-enhancer,krea2-conditioning,gguf
              </code>
            </li>
          )}
        </ul>
      </details>
    </li>
  );
}

export function PacksStep({
  data,
  loading,
  onReload,
  selected,
  onSelect,
  focus = null,
  toolPicks = NO_TOOL_PICKS,
  onToolPicks,
}: {
  data: PacksResponse | null;
  loading: boolean;
  onReload: () => void;
  selected: string[];
  onSelect: (ids: string[]) => void;
  /** Pack a caller deep-linked to: shown even off-tier, ticked, scrolled to. */
  focus?: string | null;
  toolPicks?: ToolPicks;
  onToolPicks?: (next: ToolPicks) => void;
}) {
  const [copied, copy] = useCopy();
  const [showAllClicked, setShowAll] = useState(false);
  const packs = useMemo(() => data?.packs ?? [], [data]);
  const focusPack = focus ? packs.find((p) => p.id === focus) : undefined;
  // A deep link must never land on a list that hides its pack.
  const showAll = showAllClicked || !!focusPack;

  const focusDone = useRef<string | null>(null);
  useEffect(() => {
    if (!focusPack || focusDone.current === focusPack.id) return;
    focusDone.current = focusPack.id;
    if (!focusPack.allInstalled && !selected.includes(focusPack.id))
      onSelect([...selected, focusPack.id]);
    const id = focusPack.id;
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb: () => void) => setTimeout(cb, 0);
    raf(() => {
      const card = document.getElementById(`pack-card-${id}`);
      if (card && typeof card.scrollIntoView === "function")
        card.scrollIntoView({ block: "center", behavior: "smooth" });
      const box = document.getElementById(`pack-${id}`);
      box?.focus({ preventScroll: true });
    });
  }, [focusPack, selected, onSelect]);
  const recommended = useMemo(() => {
    if (!data?.tier) return null;
    // The tier's list, in pack order, plus anything already chosen.
    return new Set([...data.preselected, ...selected]);
  }, [data, selected]);
  const visible =
    showAll || !recommended
      ? packs
      : packs.filter((p) => recommended.has(p.id) || p.allInstalled);

  const needs = missingRequirements(selected, packs);
  useEffect(() => {
    // Picking a pack that builds on another (Edit -> Images) picks that too.
    if (needs.length) onSelect([...selected, ...needs]);
  }, [needs, selected, onSelect]);

  const chosen = packs.filter((p) => selected.includes(p.id));
  const command = data ? fetchCommand(chosen, data.comfyDir) : null;
  const gated = chosen.some((p) => !p.allInstalled && p.gated);
  // Files several picked packs share download once (fetch-models --pack).
  const download = selectionDownload(chosen.filter((c) => !c.allInstalled));
  const total = download.needBytes;
  const sharedWith = new Map<string, Map<string, SharedFile>>();
  for (const f of download.files) {
    if (f.packs.length < 2) continue;
    for (const id of f.packs) {
      const own = packs
        .find((p) => p.id === id)
        ?.files.find(
          (r) => r.dest === f.dest || r.otherOptions.includes(f.dest),
        );
      if (!own) continue;
      if (!sharedWith.has(id)) sharedWith.set(id, new Map());
      sharedWith.get(id)!.set(own.dest, {
        others: f.packs.length - 1,
        uses: own.dest === f.dest ? null : f.dest,
      });
    }
  }
  const manual = chosen.flatMap((p) =>
    p.files.filter((f) => !f.installed && !f.repo),
  );

  if (!data)
    return (
      <div className="space-y-3">
        {loading ? (
          <p
            role="status"
            className={`flex items-center gap-2 text-[13px] ${MUTED}`}
          >
            <Loader2 className="h-4 w-4 animate-spin" /> Checking your GPU and
            installed models...
          </p>
        ) : (
          <>
            <p
              role="alert"
              className="text-[13px] text-red-600 dark:text-red-400"
            >
              Couldn&apos;t load the starter packs.
            </p>
            <button type="button" onClick={onReload} className={BTN.secondary}>
              Try again
            </button>
          </>
        )}
      </div>
    );

  const p = data.profile;
  return (
    <div className="space-y-4">
      <p className="text-[13px]" data-testid="packs-intro">
        Models are the large files ComfyUI uses to draw images, video and
        sound. Each pack below is a ready-made set, with a note when it may
        be too big for your graphics card.
      </p>
      <div className="flex items-start gap-2">
        <p className={`min-w-0 flex-1 text-[13px] ${MUTED}`}>
          {p ? (
            <>
              <span className="font-semibold text-light-primary dark:text-dark-primary">
                {p.displayName}
              </span>
              {p.unified
                ? ` · ${Math.round(p.memoryTotalBytes / 1024 ** 3)} GB unified memory. Macs share it with the system, so we plan for about 70% of it.`
                : ` · ${Math.round(p.memoryTotalBytes / 1024 ** 3)} GB ${p.device === "cpu" ? "RAM (no GPU found, so it will be slow)" : "VRAM"}.`}{" "}
              {data.tierLabel && `Picks for ${data.tierLabel}.`}
            </>
          ) : (
            "ComfyUI isn't connected, so we can't check your GPU or what's installed. Here is everything; pick what you like."
          )}
        </p>
        <button
          type="button"
          onClick={onReload}
          disabled={loading}
          aria-label="Check again"
          title="Check again"
          className={`${BTN.ghost} -mt-2.5 w-10 px-0`}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <p className={`text-[12px] ${MUTED}`}>
        Choose one or more, pick single tools further down, or skip. Nothing
        downloads from here: you get a command to run.
        {data.installedKnown || !p ? "" : " (Couldn't see installed models.)"}
      </p>

      <ul className="space-y-2">
        {visible.map((pack) => (
          <PackCard
            key={pack.id}
            pack={pack}
            selected={selected.includes(pack.id)}
            onToggle={() =>
              onSelect(
                selected.includes(pack.id)
                  ? // Dropping a pack drops the ones built on it too.
                    selected.filter(
                      (id) =>
                        id !== pack.id &&
                        !packs.find((x) => x.id === id)?.requires.includes(pack.id),
                    )
                  : [...selected, pack.id],
              )
            }
            copied={copied}
            onCopy={copy}
            sharedWith={sharedWith.get(pack.id)}
          />
        ))}
      </ul>
      {recommended && packs.length > visible.length && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className={BTN.ghost}
        >
          Show all {packs.length} packs
        </button>
      )}

      {onToolPicks && (
        <ToolPicker
          picks={toolPicks}
          onPicks={onToolPicks}
          comfyDir={data.comfyDir}
          cardName={p?.displayName ?? null}
          alreadyFetched={download.files.map((f) => f.dest)}
        />
      )}

      {chosen.length > 0 && (
        <section aria-label="How to download" className="space-y-2">
          <p aria-live="polite" className="sr-only">
            {copied ? "Copied to clipboard" : ""}
          </p>
          {command ? (
            <>
              <p className="text-[13px] font-semibold">
                Download {formatGb(total)}: run this in the Adrift folder
              </p>
              <CommandBox
                id="fetch"
                text={command}
                copied={copied}
                onCopy={copy}
              />
              {download.savedBytes > 0 && (
                <p className={`text-[12px] ${MUTED}`} data-testid="packs-shared">
                  Files your packs share download once (
                  {formatGb(download.savedBytes)} less).
                </p>
              )}
              {!data.comfyDirKnown && (
                <p className={`text-[12px] ${MUTED}`}>
                  Replace {data.comfyDir} with your ComfyUI folder (the one with
                  models/ inside), on the computer ComfyUI runs on.
                </p>
              )}
              {gated && (
                <p className="text-[12px] text-amber-700 dark:text-amber-300">
                  Some files need a free Hugging Face account: accept the
                  model&apos;s terms on its page, then run{" "}
                  <code className="font-mono">hf auth login</code> first.
                </p>
              )}
              {manual.length > 0 && (
                <p className={`text-[12px] ${MUTED}`}>
                  {manual.map((f) => fileName(f.dest)).join(", ")}: download by
                  hand (see the pack&apos;s files).
                </p>
              )}
              <p className={`text-[12px] ${MUTED}`}>
                Restart ComfyUI when it finishes. Prefer the Hugging Face CLI?
                Each pack&apos;s file list has a per-file command.
              </p>
              <PackDownloadWatch
                packIds={chosen.filter((c) => !c.allInstalled).map((c) => c.id)}
                onDone={onReload}
              />
            </>
          ) : (
            <p className={`text-[13px] ${MUTED}`}>
              Everything you picked is already installed.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
