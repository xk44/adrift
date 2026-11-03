"use client";

import { useMemo, useState } from "react";
import registry from "@/lib/oj/registry.json";
import { getParamValueHint } from "@/lib/promptAutocomplete";
import { Search, Copy, SlidersHorizontal } from "lucide-react";
import { showToast } from "@/components/Toast";

type RegistryParam = {
  flags?: string[];
  kind?: string;
  description?: string;
  min?: number;
  max?: number;
  default?: string | number | boolean;
  multi?: boolean;
  hidden?: boolean;
};

// Display grouping for the stock parameter reference. Params missing from
// this map (e.g. newly added ones) land in "Other" so nothing silently
// disappears from the list.
const PARAM_GROUPS: Record<string, string[]> = {
  Basics: [
    "ar",
    "seed",
    "steps",
    "cfg",
    "no",
    "region",
    "quality",
    "stylize",
    "chaos",
    "raw",
    "tile",
    "stop",
    "repeat",
    "grid",
    "hd",
    "sd",
  ],
  "Model & Pipeline": [
    "model",
    "version",
    "niji",
    "vmodel",
    "packId",
    "lora",
    "vae",
    "sampler",
    "scheduler",
    "denoise",
    "turbo",
    "relax",
    "speedTier",
    "draft",
    "draft_scale",
    "refiner",
  ],
  "Style & Reference": [
    "sref",
    "sw",
    "sv",
    "cref",
    "cw",
    "oref",
    "iw",
    "profile",
    "pa",
    "dose",
    "stylization",
    "minimalism_maximalism",
    "moodboard_strength",
  ],
  "Video & 3D": [
    "video",
    "vb",
    "motion",
    "loop",
    "end",
    "bs",
    "duration",
    "audio",
    "3d",
  ],
  ControlNet: [
    "controlnet",
    "cn-strength",
    "cn-image",
    "cn-depthmap",
    "cn-start",
    "cn-end",
  ],
};

type ParamRow = {
  name: string;
  flags: string[];
  description: string;
  valueHint: string;
  defaultValue?: string;
};

export function buildGroups(): Array<{ group: string; rows: ParamRow[] }> {
  const params =
    (registry as { params?: Record<string, RegistryParam> }).params ?? {};

  const toRow = (name: string): ParamRow | null => {
    const p = params[name];
    if (!p?.flags?.length || p.hidden) return null;
    return {
      name,
      flags: p.flags,
      description: p.description ?? name,
      valueHint: getParamValueHint(p),
      defaultValue: p.default !== undefined ? String(p.default) : undefined,
    };
  };

  const grouped = new Set<string>();
  const result: Array<{ group: string; rows: ParamRow[] }> = [];

  for (const [group, names] of Object.entries(PARAM_GROUPS)) {
    const rows = names
      .filter((n) => params[n])
      .map((n) => {
        grouped.add(n);
        return toRow(n);
      })
      .filter((r): r is ParamRow => r !== null);
    if (rows.length) result.push({ group, rows });
  }

  const leftovers = Object.keys(params)
    .filter((n) => !grouped.has(n))
    .map(toRow)
    .filter((r): r is ParamRow => r !== null);
  if (leftovers.length) result.push({ group: "Other", rows: leftovers });

  return result;
}

export function ParamReference() {
  const [query, setQuery] = useState("");
  const groups = useMemo(buildGroups, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map(({ group, rows }) => ({
        group,
        rows: rows.filter(
          (r) =>
            r.flags.some((f) => f.toLowerCase().includes(q)) ||
            r.description.toLowerCase().includes(q) ||
            r.name.toLowerCase().includes(q),
        ),
      }))
      .filter(({ rows }) => rows.length > 0);
  }, [groups, query]);

  const copyFlag = async (flag: string) => {
    try {
      await navigator.clipboard.writeText(`${flag} `);
      showToast(`Copied ${flag}`, "success", 1500);
    } catch {
      showToast("Copy failed", "error");
    }
  };

  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-medium text-[var(--text-primary)] flex items-center gap-2">
            <SlidersHorizontal className="w-5 h-5" />
            Prompt Parameters
          </h2>
          <p className="text-sm text-[var(--text-secondary)]">
            All {total} built-in prompt codes. Append them to any prompt, e.g.{" "}
            <code className="text-[var(--accent-primary)]">
              a red fox --ar 16:9 --draft
            </code>
            . Typing <code className="text-[var(--accent-primary)]">--</code> in
            the prompt bar autocompletes these. Click a code to copy it.
          </p>
        </div>
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-secondary)]" />
          <input
            aria-label="Filter parameters"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter parameters..."
            className="input pl-9 w-64"
          />
        </div>
      </div>

      {filtered.length === 0 && (
        <p className="text-sm text-[var(--text-secondary)]">
          No parameters match “{query}”.
        </p>
      )}

      {filtered.map(({ group, rows }) => (
        <div key={group} className="card p-4">
          <h3 className="font-medium text-[var(--text-primary)] mb-3">
            {group}
            <span className="ml-2 text-xs text-[var(--text-secondary)]">
              {rows.length}
            </span>
          </h3>
          <div className="divide-y divide-[var(--border-primary)]">
            {rows.map((row) => (
              <div
                key={row.name}
                className="py-2.5 grid grid-cols-[200px_110px_1fr] gap-4 items-baseline max-md:grid-cols-1 max-md:gap-1"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  {row.flags.map((flag, i) => (
                    <button
                      key={flag}
                      onClick={() => copyFlag(flag)}
                      title={`Copy ${flag}`}
                      className={`group inline-flex items-center gap-1 font-mono text-sm rounded px-1.5 py-0.5 transition-colors hover:bg-[var(--bg-tertiary)] ${
                        i === 0
                          ? "text-[var(--accent-primary)]"
                          : "text-[var(--text-secondary)]"
                      }`}
                    >
                      {flag}
                      <Copy className="w-3 h-3 opacity-0 group-hover:opacity-60" />
                    </button>
                  ))}
                </div>
                <div className="text-xs text-[var(--text-secondary)] font-mono">
                  {row.valueHint}
                  {row.defaultValue !== undefined && (
                    <span className="block opacity-70">
                      default {row.defaultValue}
                    </span>
                  )}
                </div>
                <p className="text-sm text-[var(--text-secondary)]">
                  {row.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
