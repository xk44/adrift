/**
 * Every weight file a shipped pack graph loads must be downloadable from the
 * public model download list (models/download-list.json, generated from the
 * pinned Hugging Face rows), or be marked in modelSizes.json as not in the
 * list (`set: null`) with a note saying why.
 *
 * The list is generated at export time, so the test reads whichever source is
 * present: models/download-list.json (public export) or the private TSVs it is
 * generated from (monorepo checkout). With neither it is skipped.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { MODEL_SIZES } from "@/lib/tools/modelsDoc";
import { workflowWeightRefs } from "@/lib/tools/toolsDoc";
import type { Workflow } from "@/types";

const ROOT = path.resolve(__dirname, "../..");
const PACKS = path.join(ROOT, "public/workflows/packs");
const LIST_JSON = path.join(ROOT, "models/download-list.json");
const PRIVATE = path.join(ROOT, "models");
const LIST_TSV = path.join(PRIVATE, "download_list.tsv");
const EXTRA_TSV = path.join(PRIVATE, "download_list_extra.tsv");

/** Pack graphs the public export leaves out (scripts export_public.sh). */
const NOT_SHIPPED = [/^minimax\/t2v_cached\.json$/];

interface Row {
  set: "minimal" | "full" | "other" | "convert";
  dest: string;
  size: number;
}

function tsvLines(file: string): string[][] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => l.split("\t"));
}

function loadRows(): Row[] | null {
  if (existsSync(LIST_JSON)) {
    const doc = JSON.parse(readFileSync(LIST_JSON, "utf8")) as {
      files: { set: Row["set"]; dest: string; size: number; also?: string[] }[];
      other: { dest: string; size: number }[];
      convert: { dest: string; size: number }[];
    };
    return [
      ...doc.files.flatMap((f) =>
        [f.dest, ...(f.also ?? [])].map((dest) => ({ ...f, dest })),
      ),
      ...doc.other.map((o) => ({ set: "other" as const, ...o })),
      ...doc.convert.map((c) => ({ set: "convert" as const, ...c })),
    ];
  }
  if (!existsSync(LIST_TSV)) return null;
  const rows: Row[] = tsvLines(LIST_TSV).map((f) => ({
    set: f[1] as Row["set"],
    size: Number(f[5]),
    dest: f[6],
  }));
  if (existsSync(EXTRA_TSV))
    for (const f of tsvLines(EXTRA_TSV))
      rows.push({ set: "other", dest: f[1], size: Number(f[4]) });
  // The key-conversion rows live in gen_download_list.py; modelSizes.json
  // marks those files with `convert`.
  return rows;
}

function packGraphs(dir = PACKS): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...packGraphs(p));
    else if (name.endsWith(".json"))
      out.push(path.relative(PACKS, p).split(path.sep).join("/"));
  }
  return out;
}

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const ROWS = loadRows();
const SHIPPED = packGraphs().filter((g) => !NOT_SHIPPED.some((r) => r.test(g)));

describe.skipIf(ROWS === null)("download list covers the shipped packs", () => {
  const rows = ROWS ?? [];
  const byBase = new Map<string, Row[]>();
  for (const r of rows) {
    const b = base(r.dest);
    byBase.set(b, [...(byBase.get(b) ?? []), r]);
  }

  it("every loader file in every shipped pack graph has a row", () => {
    const missing: string[] = [];
    let seen = 0;
    for (const rel of SHIPPED) {
      const wf = JSON.parse(
        readFileSync(path.join(PACKS, rel), "utf8"),
      ) as Workflow;
      for (const ref of workflowWeightRefs(wf, { includeInert: true })) {
        const file = base(ref.file);
        seen++;
        if (byBase.has(file)) continue;
        const info = MODEL_SIZES.files[file];
        if (info?.convert) continue;
        // Not in the list on purpose: modelSizes.json says so and why.
        if (info && info.set === null && info.note) continue;
        missing.push(`${rel}: ${file}`);
      }
    }
    expect(seen).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });

  it("modelSizes.json set and size agree with the list", () => {
    const wrong: string[] = [];
    for (const [file, info] of Object.entries(MODEL_SIZES.files)) {
      const hits = byBase.get(file);
      if (info.set === null) continue;
      if (!hits) {
        wrong.push(`${file}: set ${info.set} but no download-list row`);
        continue;
      }
      const set = hits.some((h) => h.set === "minimal") ? "minimal" : "full";
      if (hits.some((h) => h.set !== "other") && set !== info.set)
        wrong.push(`${file}: set ${info.set}, list ${set}`);
      if (
        info.bytes !== null &&
        !info.measured &&
        hits.every((h) => Math.abs(h.size - info.bytes!) / h.size > 0.01)
      )
        wrong.push(`${file}: ${info.bytes} bytes, list ${hits[0].size}`);
    }
    expect(wrong).toEqual([]);
  });

  it("every by-name model folder has rows", () => {
    for (const m of MODEL_SIZES.byName) {
      if (!m.folder.endsWith("/")) continue; // fetched by its node pack
      expect(
        rows.some((r) => r.dest.startsWith(m.folder)),
        m.folder,
      ).toBe(true);
    }
  });
});
