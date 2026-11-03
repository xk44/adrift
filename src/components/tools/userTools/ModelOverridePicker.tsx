"use client";

import { AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react";
import {
  Chip,
  CHIP_NEUTRAL,
  CHIP_OK,
  VerdictChip,
} from "@/components/onboarding/ui";
import type {
  ModelOverride,
  ModelOverrideCandidate,
  OverrideMatch,
} from "@/lib/userTools/modelOverrides";
import type { MissingModelReport } from "@/lib/userTools/types";

/** Key of one missing-model row (node + input). */
export function overrideKey(m: Pick<MissingModelReport, "nodeId" | "input">) {
  return `${m.nodeId}.${m.input}`;
}

/** Initial picks: the confident suggestions. */
export function initialOverridePicks(
  missing: MissingModelReport[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of missing) if (m.suggested) out[overrideKey(m)] = m.suggested;
  return out;
}

/** Picks -> the save body's modelOverrides (empty pick = keep as is). */
export function overridesFromPicks(
  missing: MissingModelReport[],
  picks: Record<string, string>,
): ModelOverride[] {
  const out: ModelOverride[] = [];
  for (const m of missing) {
    const v = picks[overrideKey(m)];
    if (v) out.push({ nodeId: m.nodeId, input: m.input, value: v });
  }
  return out;
}

/** "gguf_q6_k" -> "GGUF Q6_K", "fp8_e4m3fn" -> "fp8". */
export function quantLabel(id: string | undefined): string | null {
  if (!id || id === "unknown") return null;
  if (id.startsWith("gguf_")) return `GGUF ${id.slice(5).toUpperCase()}`;
  if (id === "gguf") return "GGUF";
  if (id.startsWith("fp8")) return "fp8";
  return id;
}

export function matchLabel(c: ModelOverrideCandidate): string {
  const MATCH_LABEL: Record<OverrideMatch, string> = {
    same_file: "Same file",
    same_model: "Same model",
    same_family: "Same family",
    similar: "Similar name",
    other: "Different model",
  };
  const q = quantLabel(c.quant);
  return c.match === "same_model" && q
    ? `${MATCH_LABEL[c.match]} · ${q}`
    : MATCH_LABEL[c.match];
}

const GROUPS: Array<{ label: string; matches: OverrideMatch[] }> = [
  { label: "Best match", matches: ["same_file", "same_model"] },
  { label: "Same family", matches: ["same_family"] },
  { label: "Other installed files", matches: ["similar", "other"] },
];

function ModelRow({
  m,
  pick,
  onPick,
}: {
  m: MissingModelReport;
  pick: string;
  onPick: (value: string) => void;
}) {
  const candidates = m.candidates ?? [];
  const chosen = candidates.find((c) => c.value === pick) ?? null;
  const id = `model-override-${m.nodeId}-${m.input}`;
  return (
    <li
      className="space-y-1.5 py-2 first:pt-0 last:pb-0"
      data-testid="model-override-row"
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <label
          htmlFor={id}
          className="min-w-0 truncate font-mono text-light-primary dark:text-dark-primary"
          title={m.file}
        >
          {m.file}
        </label>
        <a
          href={m.searchUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex flex-shrink-0 items-center gap-1 font-medium text-splash hover:underline"
        >
          Find on Civitai <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      {candidates.length > 0 ? (
        <select
          id={id}
          value={pick}
          onChange={(e) => onPick(e.target.value)}
          data-testid="model-override-select"
          className="w-full rounded-lg bg-light-bg px-2 py-1.5 text-xs text-light-primary shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)] focus:outline-none focus:ring-2 focus:ring-splash dark:bg-dark-bg dark:text-dark-primary dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
        >
          <option value="">Keep as is (missing)</option>
          {GROUPS.map((g) => {
            const rows = candidates.filter((c) => g.matches.includes(c.match));
            if (rows.length === 0) return null;
            return (
              <optgroup key={g.label} label={g.label}>
                {rows.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.value}
                    {c.value === m.suggested ? " (suggested)" : ""}
                    {c.verdict === "unsupported" ? " (won't run here)" : ""}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
      ) : (
        <p className="text-xs text-light-500 dark:text-dark-400">
          Nothing installed for this slot yet.
        </p>
      )}
      {chosen ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip
            className={
              chosen.match === "same_file" || chosen.match === "same_model"
                ? CHIP_OK
                : CHIP_NEUTRAL
            }
          >
            {matchLabel(chosen)}
          </Chip>
          {chosen.value === m.suggested && (
            <Chip className={CHIP_NEUTRAL}>Suggested</Chip>
          )}
          {chosen.verdict && chosen.verdict !== "unknown" && (
            <VerdictChip verdict={chosen.verdict} reason={chosen.reason} />
          )}
          {chosen.match !== "same_file" && chosen.match !== "same_model" && (
            <span className="text-[11px] text-light-500 dark:text-dark-400">
              A different model can change the look.
            </span>
          )}
        </div>
      ) : (
        <p
          className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400"
          data-testid="model-override-unresolved"
        >
          <AlertTriangle className="h-3 w-3 flex-shrink-0" />
          Still missing. The tool won&apos;t run until you add this file
          {candidates.length > 0 ? " or pick one above" : ""}.
        </p>
      )}
    </li>
  );
}

/** Missing models with a stand-in picker each (review screen). */
export function ModelOverrideList({
  missing,
  picks,
  onPick,
}: {
  missing: MissingModelReport[];
  picks: Record<string, string>;
  onPick: (key: string, value: string) => void;
}) {
  const resolved = missing.filter((m) => picks[overrideKey(m)]).length;
  return (
    <div className="space-y-1.5" data-testid="model-overrides">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
          Models ({missing.length})
        </span>
        {resolved > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-3 w-3" />
            {resolved} of {missing.length} swapped for files you have
          </span>
        )}
      </div>
      <p className="text-[11px] text-light-500 dark:text-dark-400">
        Pick a file you already have to use instead, or keep it and download it
        later.
      </p>
      <ul className="divide-y divide-amber-500/15">
        {missing.map((m) => (
          <ModelRow
            key={overrideKey(m)}
            m={m}
            pick={picks[overrideKey(m)] ?? ""}
            onPick={(v) => onPick(overrideKey(m), v)}
          />
        ))}
      </ul>
    </div>
  );
}
