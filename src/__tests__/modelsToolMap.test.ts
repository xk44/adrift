/**
 * docs/models-by-tool.json: per-tool weight files for scripts/fetch-models.mjs
 * (`--tool <id>`). Built from the same tool -> workflow -> loader resolution
 * as docs/models.md (buildModelsDoc), so the script fetches exactly the files
 * the Tools page checks for. Regenerate with `npm run docs:models`.
 */
import { describe, it, expect } from "vitest";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { buildModelsDoc, MODEL_SIZES } from "@/lib/tools/modelsDoc";
import type { Workflow } from "@/types";

const ROOT = path.resolve(__dirname, "../..");
const WF_DIR = path.join(ROOT, "public/workflows");
const OUT = path.join(ROOT, "docs/models-by-tool.json");

function loadWorkflow(rel: string): Workflow | null {
  const p = path.join(WF_DIR, rel);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Workflow;
}

function packGraphs(dir = path.join(WF_DIR, "packs")): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...packGraphs(p));
    else if (name.endsWith(".json"))
      out.push(path.relative(WF_DIR, p).split(path.sep).join("/"));
  }
  return out;
}

export interface ToolMapEntry {
  id: string;
  kind: "action" | "pipeline" | "catalog";
  title: string;
  category: string;
  /** Paths under ComfyUI/models/ (folder + file name). */
  files: string[];
  /** Folders under ComfyUI/models/ a node loads by name (whole folder). */
  dirs?: string[];
}

/** Tool titles named in a modelSizes.json byName "tools" cell. */
function byNameTitles(cell: string): string[] {
  return cell.split(",").map((t) => t.replace(/\(.*\)/, "").trim());
}

export function buildToolMap(): { about: string; tools: ToolMapEntry[] } {
  const result = buildModelsDoc(loadWorkflow, packGraphs());
  const folders = new Map(result.files.map((f) => [f.file, f.folders]));
  const tools = result.tools.map((t) => {
    const [kind, id] = [t.kind, t.key.slice(t.key.indexOf(":") + 1)];
    const files: string[] = [];
    for (const base of t.files)
      for (const dir of folders.get(base) ?? [])
        if (!files.includes(dir + base)) files.push(dir + base);
    const dirs = MODEL_SIZES.byName
      .filter(
        (b) =>
          b.folder.endsWith("/") && byNameTitles(b.tools).includes(t.title),
      )
      .map((b) => b.folder);
    const entry: ToolMapEntry = {
      id,
      kind,
      title: t.title,
      category: t.category,
      files,
    };
    if (dirs.length) entry.dirs = dirs;
    return entry;
  });
  return {
    about:
      "Weight files each Tools-page card loads, as paths under ComfyUI/models/. " +
      "Generated from the tool graphs (src/__tests__/modelsToolMap.test.ts); " +
      "read by scripts/fetch-models.mjs --tool. Regenerate: npm run docs:models",
    tools,
  };
}

const MAP = buildToolMap();
const TEXT = `${JSON.stringify(MAP, null, 2)}\n`;

describe("docs/models-by-tool.json", () => {
  it("has a unique id per kind and resolves files for the core tools", () => {
    const keys = MAP.tools.map((t) => `${t.kind}:${t.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(MAP.tools.length).toBeGreaterThan(50);
    const withFiles = MAP.tools.filter((t) => t.files.length > 0);
    expect(withFiles.length).toBeGreaterThan(40);
    for (const t of MAP.tools)
      for (const f of t.files) {
        expect(f.startsWith("/") || f.includes(".."), f).toBe(false);
        expect(f.endsWith("/"), f).toBe(false);
      }
  });

  it("maps by-name model folders onto their tools", () => {
    const dub = MAP.tools.find(
      (t) => t.kind === "pipeline" && t.id === "dub_video",
    );
    expect(dub?.dirs).toContain("stt/whisper/whisper-large-v3-turbo/");
  });

  it("committed docs/models-by-tool.json is up to date (npm run docs:models)", () => {
    if (process.env.UPDATE_MODELS_DOC === "1") writeFileSync(OUT, TEXT);
    expect(readFileSync(OUT, "utf8")).toBe(TEXT);
  });
});
