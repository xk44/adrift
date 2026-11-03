"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import {
  isFileWanted,
  isHandDir,
  toolFetchCommand,
  toolSelection,
  tooBig,
  visibleToolRows,
  type ToolPicks,
  type ToolRow,
} from "@/lib/onboarding/toolPicker";
import { formatGb } from "@/lib/onboarding/starterPacks";
import { getToolRows } from "./api";
import {
  BTN,
  CHIP_NEUTRAL,
  CHIP_OK,
  CHIP_WARN,
  Chip,
  CommandBox,
  INPUT,
  MUTED,
  VerdictChip,
  useCopy,
} from "./ui";

function ToolRowItem({
  row,
  picks,
  onPicks,
}: {
  row: ToolRow;
  picks: ToolPicks;
  onPicks: (next: ToolPicks) => void;
}) {
  const [open, setOpen] = useState(false);
  const picked = picks.tools.includes(row.key);
  const missing = row.files.filter((f) => f.installed !== true);
  const need = missing
    .filter((f) => isFileWanted(f, picks))
    .reduce((n, f) => n + (f.bytes ?? 0), 0);
  const left = missing.filter(
    (f) => f.listed && !isFileWanted(f, picks) && tooBig(f.verdict),
  ).length;
  const id = `tool-${row.key.replace(/\W/g, "-")}`;
  return (
    <li className="rounded-md border border-light-100 p-2 dark:border-dark-700">
      <div className="flex items-start gap-2">
        <input
          id={id}
          type="checkbox"
          checked={row.allInstalled || picked}
          disabled={row.allInstalled}
          onChange={() =>
            onPicks({
              ...picks,
              tools: picked
                ? picks.tools.filter((k) => k !== row.key)
                : [...picks.tools, row.key],
            })
          }
          className="mt-0.5 h-5 w-5 flex-shrink-0 accent-splash"
        />
        <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold">{row.title}</span>
            {row.allInstalled ? (
              <Chip className={CHIP_OK}>Installed</Chip>
            ) : (
              row.fit && <VerdictChip verdict={row.fit} reason={row.fitReason} />
            )}
            {row.nonCommercial && (
              <Chip className={CHIP_WARN}>Non-commercial</Chip>
            )}
          </span>
          {!row.allInstalled && (
            <span className={`mt-0.5 block text-[12px] ${MUTED}`}>
              {formatGb(need)} to download
              {row.dirs.some((d) => !isHandDir(d)) && ", plus model folders"}
              {left > 0 && ` · ${left} too big for your card left out`}
            </span>
          )}
        </label>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={`Files of ${row.title}`}
          className={`${BTN.ghost} -mt-1.5 w-10 flex-shrink-0 px-0`}
        >
          <ChevronRight
            className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`}
          />
        </button>
      </div>
      {open && (
        <ul className="mt-2 space-y-1.5 pl-7">
          {row.files.map((f) => (
            <li
              key={f.dest}
              className="flex flex-wrap items-center gap-1.5 text-[12px]"
            >
              <input
                type="checkbox"
                aria-label={f.dest}
                disabled={f.installed === true || !f.listed || !picked}
                checked={f.installed === true || (f.listed && isFileWanted(f, picks))}
                onChange={(e) =>
                  onPicks({
                    ...picks,
                    files: { ...picks.files, [f.dest]: e.target.checked },
                  })
                }
                className="h-4 w-4 flex-shrink-0 accent-splash"
              />
              <span className="min-w-0 break-all font-mono">
                {f.dest.split("/").pop()}
              </span>
              {f.bytes !== null && (
                <span className={MUTED}>{formatGb(f.bytes)}</span>
              )}
              {f.installed === true ? (
                <Chip className={CHIP_OK}>Installed</Chip>
              ) : !f.listed ? (
                <Chip className={CHIP_NEUTRAL}>Download by hand</Chip>
              ) : (
                f.verdict && <VerdictChip verdict={f.verdict} reason={f.reason} />
              )}
            </li>
          ))}
          {row.dirs.map((d) => (
            <li key={d} className={`text-[12px] ${MUTED}`}>
              <span className="break-all font-mono">{d}</span> (whole folder)
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function ToolPicker({
  picks,
  onPicks,
  comfyDir,
  cardName,
  alreadyFetched,
}: {
  picks: ToolPicks;
  onPicks: (next: ToolPicks) => void;
  comfyDir: string;
  /** The GPU's name; null when ComfyUI isn't connected. */
  cardName: string | null;
  /** Files the packs picked above download anyway. */
  alreadyFetched: string[];
}) {
  const [open, setOpen] = useState(picks.tools.length > 0);
  const [rows, setRows] = useState<ToolRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [onlyFits, setOnlyFits] = useState(true);
  const [copied, copy] = useCopy();

  useEffect(() => {
    if (!open || rows) return;
    let live = true;
    setFailed(false);
    void getToolRows().then((res) => {
      if (!live) return;
      if (res) setRows(res.tools);
      else setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [open, rows]);

  const visible = useMemo(
    () => visibleToolRows(rows ?? [], query, onlyFits, picks.tools),
    [rows, query, onlyFits, picks.tools],
  );
  const groups = useMemo(() => {
    const out = new Map<string, ToolRow[]>();
    for (const r of visible)
      out.set(r.category, [...(out.get(r.category) ?? []), r]);
    return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [visible]);
  const sel = useMemo(
    () => toolSelection(rows ?? [], picks, alreadyFetched),
    [rows, picks, alreadyFetched],
  );
  const command = toolFetchCommand(sel, comfyDir);
  const matches = visibleToolRows(rows ?? [], query, false).length;

  return (
    <section aria-label="Pick single tools" className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={BTN.ghost}
      >
        <ChevronRight
          className={`mr-1 h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`}
        />
        Pick single tools instead
      </button>
      {open && !rows && !failed && (
        <p role="status" className={`flex items-center gap-2 text-[13px] ${MUTED}`}>
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the tools...
        </p>
      )}
      {open && failed && (
        <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">
          Couldn&apos;t load the tool list.
        </p>
      )}
      {open && rows && (
        <>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools"
            aria-label="Search tools"
            className={INPUT}
          />
          {cardName && (
            <label className="flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={onlyFits}
                onChange={(e) => setOnlyFits(e.target.checked)}
                className="h-4 w-4 accent-splash"
              />
              Hide tools too big for your {cardName}
            </label>
          )}
          <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
            {groups.map(([category, list]) => (
              <div key={category}>
                <p className={`mb-1 text-[12px] font-semibold ${MUTED}`}>
                  {category}
                </p>
                <ul className="space-y-1.5">
                  {list.map((r) => (
                    <ToolRowItem
                      key={r.key}
                      row={r}
                      picks={picks}
                      onPicks={onPicks}
                    />
                  ))}
                </ul>
              </div>
            ))}
            {groups.length === 0 && (
              <p className={`text-[13px] ${MUTED}`}>
                {onlyFits && matches > 0
                  ? "Nothing here fits your card. Untick the box above to see them all."
                  : "No tool matches that."}
              </p>
            )}
          </div>
          {sel.chosen.length > 0 && (
            <div className="space-y-2">
              <p aria-live="polite" className="sr-only">
                {copied ? "Copied to clipboard" : ""}
              </p>
              {command ? (
                <>
                  <p className="text-[13px] font-semibold">
                    Download {formatGb(sel.needBytes)}
                    {sel.dirs.length > 0 && " plus the model folders"}: run this
                    in the Adrift folder
                  </p>
                  <CommandBox
                    id="fetch-tools"
                    text={command}
                    copied={copied}
                    onCopy={copy}
                  />
                </>
              ) : (
                <p className="text-[13px]">
                  {sel.chosen.every((r) => r.allInstalled)
                    ? "Everything these tools need is already there."
                    : "Nothing to download with these choices. Files you left out or must fetch by hand are still missing."}
                </p>
              )}
              {sel.sharedBytes > 0 && (
                <p className={`text-[12px] ${MUTED}`} data-testid="tools-shared">
                  {formatGb(sel.sharedBytes)} of it comes with the packs you
                  picked and downloads once.
                </p>
              )}
              {sel.unknownSizes > 0 && (
                <p className={`text-[12px] ${MUTED}`}>
                  {sel.unknownSizes} file(s) have no known size yet; the command
                  shows the full total first.
                </p>
              )}
              {sel.gated && (
                <p className="text-[12px] text-amber-700 dark:text-amber-300">
                  Some files need a free Hugging Face account: accept the
                  model&apos;s terms on its page, then run{" "}
                  <code className="font-mono">hf auth login</code> first.
                </p>
              )}
              {sel.manual.length > 0 && (
                <p className={`text-[12px] ${MUTED}`} data-testid="tools-manual">
                  {sel.manual.map((d) => d.replace(/\/$/, "").split("/").pop()).join(", ")}: not on
                  the download list, see docs/models.md.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
