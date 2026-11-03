/**
 * "Set up this tool" requirement resolver
 * For one Tools-page card, lists every weight file it loads (folder under
 * ComfyUI/models/, size, license, source, a copyable download command) and
 * the node classes its graphs use. Same data path as docs/models.md
 * (modelsDoc.ts): tool -> actions -> pack graphs -> loader nodes ->
 * modelSizes.json, plus modelRepoPaths.json for the file's path inside its
 * Hugging Face repo.
 *
 * Pure: the caller passes a synchronous `load` for pack graphs. Presence on
 * the server (GET /models/<folder>) and missing node classes are added by
 * GET /api/tools/setup; this module never touches the network or disk.
 */

import repoPathsJson from "./modelRepoPaths.json";
import editRegistryJson from "./editToolRegistry.json";
import {
  folderForRef,
  formatBytes,
  MODEL_SIZES,
  PIPELINE_TOOLS,
  type ModelFileInfo,
} from "./modelsDoc";
import {
  ACTION_TOOLS,
  OUTPAINT_CARD_KEY,
  defaultPick,
  type ActionToolSpec,
} from "./toolsPage";
import {
  getEditTools,
  getKeepFramingLora,
  getSpeedLora,
  STATIC_WORKFLOWS,
  toolLicense,
  type EditToolDef,
} from "./editTools";
import {
  actionsForTool,
  familyFor,
  workflowRelForAction,
  workflowWeightRefs,
  type Commercial,
  type LoadWorkflow,
} from "./toolsDoc";
import { EDIT_ENGINES, getTemplate, type EditEngineId } from "./templates";
import { appEngines, getApp } from "./apps";
import { STORYBOARD_ENGINES } from "./storyboard";
import { licenseUrlFor } from "@/lib/models/licenseLinks";

// Types

export interface SetupFile {
  /** Weight basename ("wan_2.1_vae.safetensors"); a folder for by-name models. */
  file: string;
  /** The name the graph loads, relative to `type` ("wan_motion/x.safetensors"). */
  name: string;
  /** Folder under ComfyUI/models/ with trailing slash ("loras/wan_motion/"); null = unmapped loader. */
  folder: string | null;
  /** Top-level models folder ComfyUI lists via GET /models/<type> ("loras"). */
  type: string | null;
  bytes: number | null;
  /** "owner/repo" or a URL; null = unknown. */
  source: string | null;
  sourceUrl: string | null;
  gated: boolean;
  license: string;
  /** Link to the license text; null = no verified link. */
  licenseUrl?: string | null;
  commercial: Commercial;
  /** Non-commercial weights. */
  nc: boolean;
  /** Shell command (uses $COMFYUI); null when no scripted download is known. */
  command: string | null;
  /** The path inside the HF repo was not verified (assumed at the repo root). */
  pathGuessed: boolean;
  /** Only some modes / toggles load it (not needed for the default run). */
  optional: boolean;
  /** A model the node loads by folder name rather than by a weight file. */
  byName?: boolean;
  note?: string;
}

export interface SetupOption {
  /** "tool" for single-option cards, else the edit engine id. */
  id: string;
  label: string;
  /** Free-text model name (engine options). */
  model?: string;
  files: SetupFile[];
  /** Every node class the option's default graphs use (the route keeps the missing ones). */
  nodeClasses: string[];
  /** Node classes only the optional modes' graphs use. */
  optionalNodeClasses: string[];
  /** Custom node packs the tool declares (registry `requiresNodes`). */
  nodePacks: string[];
  /** Pack graphs the option queues. */
  workflows: string[];
  notes: string[];
}

export interface ToolSetup {
  key: string;
  /** True when any ONE option is enough (engine-picking cards). */
  anyOf: boolean;
  options: SetupOption[];
}

export interface SetupTotals {
  requiredBytes: number;
  allBytes: number;
  /** Files with no known size. */
  unknown: number;
}

// Download commands

const REPO_PATHS = (repoPathsJson as { files: Record<string, string> }).files;

const HF_REPO = /^[\w.-]+\/[\w.-]+$/;

function stripSlash(folder: string): string {
  return folder.replace(/\/+$/, "");
}

/** Single-quote for POSIX shells only when needed. */
function sh(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function sourceUrlFor(source: string | null | undefined): string | null {
  if (!source) return null;
  if (source.includes("://")) return source;
  return HF_REPO.test(source) ? `https://huggingface.co/${source}` : null;
}

/**
 * Download command for one weight file into $COMFYUI/models/<folder>.
 * `hf download --local-dir` keeps the repo's sub-path, so a nested file is
 * moved up into the folder the graph reads. A file published under another
 * name (modelRepoPaths.json maps it) is renamed to the name the graph loads.
 * A file that needs a key conversion first (`convert`) gets no command.
 */
export function downloadCommand(
  file: string,
  folder: string | null,
  info: Pick<ModelFileInfo, "source" | "convert"> | undefined,
): { command: string | null; pathGuessed: boolean } {
  const src = info?.source;
  if (!src || folder === null || info?.convert)
    return { command: null, pathGuessed: false };
  const dir = stripSlash(folder);
  if (!src.includes("://")) {
    if (!HF_REPO.test(src)) return { command: null, pathGuessed: false };
    const repoPath = REPO_PATHS[file];
    const inRepo = repoPath ?? file;
    const repoDir = inRepo.includes("/")
      ? inRepo.slice(0, inRepo.lastIndexOf("/"))
      : "";
    // Where `hf download --local-dir` is pointed (relative to models/).
    let localDir: string;
    // Repo layout already matches models/ ("vae/x" into vae/): download to models/.
    if (dir === repoDir) localDir = "";
    else if (!repoDir) localDir = dir;
    // The graph's folder already mirrors the repo layout: download one level up.
    else if (dir.endsWith(`/${repoDir}`))
      localDir = dir.slice(0, -repoDir.length - 1);
    else localDir = dir;
    const cmd = `hf download ${sh(src)} ${sh(inRepo)} --local-dir "$COMFYUI/models${localDir ? `/${localDir}` : ""}"`;
    const landed = localDir ? `${localDir}/${inRepo}` : inRepo;
    if (landed === (dir ? `${dir}/${file}` : file))
      return { command: cmd, pathGuessed: !repoPath };
    // Otherwise move the file up into the folder the graph reads, renaming it
    // when the repo publishes it under another name.
    const target = baseName(inRepo) === file ? `${dir}/` : `${dir}/${file}`;
    return {
      command: `${cmd} && mv "$COMFYUI/models/${landed}" "$COMFYUI/models/${target}"`,
      pathGuessed: !repoPath,
    };
  }
  // GitHub release page -> its direct asset URL.
  const gh = src.match(
    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/tag\/([\w.+-]+)$/,
  );
  if (gh) {
    const url = `https://github.com/${gh[1]}/releases/download/${gh[2]}/${file}`;
    return {
      command: `curl -L --create-dirs -o "$COMFYUI/models/${stripSlash(folder)}/${file}" ${url}`,
      pathGuessed: false,
    };
  }
  return { command: null, pathGuessed: false };
}

/** Command for a model a node loads by folder (whole repo snapshot). */
function byNameCommand(source: string, folder: string): string | null {
  if (!HF_REPO.test(source)) return null;
  return `hf download ${sh(source)} --local-dir "$COMFYUI/models/${stripSlash(folder)}"`;
}

// Graph scanning

function baseName(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

function topType(folder: string | null): string | null {
  if (folder === null) return null;
  const t = folder.split("/")[0];
  return t || null;
}

function commercialOf(c: boolean | null): Commercial {
  return c === true ? "yes" : c === false ? "no" : "unverified";
}

interface Acc {
  files: SetupFile[];
  nodeClasses: string[];
  optionalNodeClasses: string[];
  workflows: string[];
  missing: string[];
}

function newAcc(): Acc {
  return {
    files: [],
    nodeClasses: [],
    optionalNodeClasses: [],
    workflows: [],
    missing: [],
  };
}

function makeFile(
  ref: string,
  folder: string | null,
  optional: boolean,
  catalog?: EditToolDef,
): SetupFile {
  const file = baseName(ref);
  const info = MODEL_SIZES.files[file];
  const family = familyFor(ref);
  let license = family?.license ?? "see source";
  let commercial: Commercial = family?.commercial ?? "unverified";
  if (!family && catalog) {
    const l = toolLicense(catalog);
    license = l.name;
    commercial = commercialOf(l.commercial);
  }
  const type = topType(folder);
  const name =
    folder === null
      ? ref
      : `${folder.slice(type ? type.length + 1 : 0)}${file}`;
  const { command, pathGuessed } = downloadCommand(file, folder, info);
  return {
    file,
    name,
    folder,
    type,
    bytes: info?.bytes ?? null,
    source: info?.source ?? null,
    sourceUrl: sourceUrlFor(info?.source),
    gated: !!info?.gated,
    license,
    licenseUrl: licenseUrlFor(license),
    commercial,
    nc: commercial === "no",
    command,
    pathGuessed,
    optional,
    ...(info?.note ? { note: info.note } : {}),
  };
}

function addFile(acc: Acc, f: SetupFile) {
  const hit = acc.files.find(
    (x) =>
      x.file.toLowerCase() === f.file.toLowerCase() && x.folder === f.folder,
  );
  if (!hit) acc.files.push(f);
  else if (!f.optional) hit.optional = false;
}

/** Record a graph's weight files and node classes. */
function scanGraph(
  acc: Acc,
  load: LoadWorkflow,
  rel: string,
  optional: boolean,
  skip?: (classType: string, input: string) => boolean,
) {
  const wf = load(rel);
  if (!wf) {
    if (!acc.missing.includes(rel)) acc.missing.push(rel);
    return;
  }
  if (!acc.workflows.includes(rel)) acc.workflows.push(rel);
  for (const node of Object.values(wf)) {
    if (!node || typeof node !== "object" || !node.class_type) continue;
    const meta = (node as { _meta?: { optional?: unknown } })._meta;
    if (meta?.optional) continue;
    const into = optional ? acc.optionalNodeClasses : acc.nodeClasses;
    if (!into.includes(node.class_type)) into.push(node.class_type);
  }
  for (const ref of workflowWeightRefs(wf)) {
    if (skip?.(ref.classType, ref.input)) continue;
    const folder = folderForRef(ref);
    // Optional nodes (e.g. the opt-in 2K finish) list their weights as optional.
    const opt = optional || !!(ref.node as { _meta?: { optional?: unknown } })._meta?.optional;
    addFile(acc, makeFile(ref.file, folder ?? null, opt));
  }
}

function finish(
  acc: Acc,
  id: string,
  label: string,
  extra: Partial<SetupOption> = {},
): SetupOption {
  const notes = [...(extra.notes ?? [])];
  if (acc.missing.length)
    notes.push(`Graph not found in this build: ${acc.missing.join(", ")}.`);
  if (acc.files.some((f) => f.gated))
    notes.push(
      "Gated repos: sign in to Hugging Face (`hf auth login`) and accept the license on each repo page first.",
    );
  // Required files first, then optional; graph order otherwise.
  const files = [
    ...acc.files.filter((f) => !f.optional),
    ...acc.files.filter((f) => f.optional),
  ];
  return {
    id,
    label,
    files,
    nodeClasses: acc.nodeClasses,
    optionalNodeClasses: acc.optionalNodeClasses.filter(
      (c) => !acc.nodeClasses.includes(c),
    ),
    nodePacks: extra.nodePacks ?? [],
    workflows: acc.workflows,
    notes,
    ...(extra.model ? { model: extra.model } : {}),
  };
}

/** By-name models (VibeVoice, whisper, ...) credited to a tool title. */
function addByName(acc: Acc, title: string) {
  for (const m of MODEL_SIZES.byName) {
    // "Video Translator (transcribe)", "Voice Changer, Video Translator (Chatterbox engine)".
    const hit = m.tools
      .split(",")
      .map((t) => t.trim().match(/^(.*?)\s*(?:\((.*)\))?$/))
      .find(
        (t) =>
          !!t &&
          (t[0].toLowerCase() === title.toLowerCase() ||
            t[1].toLowerCase() === title.toLowerCase()),
      );
    if (!hit) continue;
    // A qualifier naming an engine = only that alternate engine loads it.
    const optional =
      hit[0].toLowerCase() !== title.toLowerCase() &&
      /\bengine\b/i.test(hit[2] ?? "");
    // Some packs fetch their own weights ("fetched by its node pack").
    const isPath = /^[\w.-]+(\/[\w.-]+)*\/?$/.test(m.folder);
    const folder = !isPath
      ? null
      : m.folder.endsWith("/")
        ? m.folder
        : `${m.folder}/`;
    const type = topType(folder);
    acc.files.push({
      file: m.model,
      name: folder ? folder.slice(type ? type.length + 1 : 0) : m.model,
      folder,
      type,
      bytes: m.bytes,
      source: m.source,
      sourceUrl: sourceUrlFor(m.source),
      gated: false,
      license: m.license,
      licenseUrl: licenseUrlFor(m.license),
      commercial: "unverified",
      nc: /\bnc\b|non-commercial/i.test(m.license),
      command: folder ? byNameCommand(m.source, folder) : null,
      pathGuessed: false,
      optional,
      byName: true,
      ...(folder ? {} : { note: `Downloaded by its node pack (${m.folder}).` }),
    });
  }
}

// Per card kind

/** Actions whose graph a default run loads (the rest are other modes). */
function primaryActions(spec: ActionToolSpec, all: string[]): string[] {
  if (spec.modelCheck && all.includes(spec.modelCheck.action))
    return [spec.modelCheck.action];
  if (all.includes(spec.id)) return [spec.id];
  const firstPicker = spec.pickers?.[0];
  const first = firstPicker ? defaultPick(firstPicker) : undefined;
  if (first && all.includes(first)) return [first];
  return all.slice(0, 1);
}

function actionOption(spec: ActionToolSpec, load: LoadWorkflow): SetupOption {
  const acc = newAcc();
  const all = actionsForTool(spec);
  const primary = primaryActions(spec, all);
  const rels = (ids: string[]) => [
    ...new Set(ids.map(workflowRelForAction).filter((r): r is string => !!r)),
  ];
  const req = rels(primary);
  for (const rel of req) scanGraph(acc, load, rel, false);
  for (const rel of rels(all))
    if (!req.includes(rel)) scanGraph(acc, load, rel, true);
  addByName(acc, spec.title);
  const notes: string[] = [];
  if (spec.requiredPack)
    notes.push(
      `Needs the ${spec.requiredPack} workflow pack enabled on the server.`,
    );
  if (spec.usesEditLora)
    notes.push(
      "Also needs a Krea 2 edit LoRA: install one from the Edit tab's LoRA list.",
    );
  return finish(acc, "tool", spec.title, {
    nodePacks: spec.requiresNodes ? [spec.requiresNodes] : [],
    notes,
  });
}

function catalogOption(
  tool: EditToolDef,
  load: LoadWorkflow,
  id = "tool",
  label = tool.label,
): SetupOption {
  const acc = newAcc();
  const rel =
    STATIC_WORKFLOWS[tool.packAction] ?? workflowRelForAction(tool.packAction);
  // The runner swaps the base graph's LoRA chain for the tool's own LoRAs.
  if (rel)
    scanGraph(
      acc,
      load,
      rel,
      false,
      (cls, input) =>
        cls === "LoraLoaderModelOnly" ||
        (cls === "MOSSi2iReference" && input === "lora_name"),
    );
  else acc.missing.push(`${tool.pack}:${tool.packAction}`);
  const lora = (file: string, optional: boolean) => {
    const dir = file.includes("/")
      ? `${file.slice(0, file.lastIndexOf("/"))}/`
      : "";
    addFile(acc, makeFile(file, `loras/${dir}`, optional, tool));
  };
  for (const l of tool.loras) lora(l.file, false);
  if (tool.extras.keepFraming) lora(getKeepFramingLora(tool.base).file, true);
  if (tool.speed.supported) {
    const speed = getSpeedLora(tool.base);
    if (speed) lora(speed.file, !tool.speed.default);
  }
  const notes: string[] = [];
  if (tool.license?.note) notes.push(tool.license.note);
  return finish(acc, id, label, {
    nodePacks: tool.requiresNodes ? [tool.requiresNodes] : [],
    notes,
  });
}

function engineOption(
  engineId: EditEngineId,
  load: LoadWorkflow,
): SetupOption | null {
  const engine = EDIT_ENGINES[engineId];
  if (!engine) return null;
  const run = engine.run;
  if (run.kind === "catalog") {
    const tool = getEditTools().find((t) => t.id === run.toolId);
    if (!tool) return null;
    const opt = catalogOption(tool, load, engine.id, engine.label);
    return { ...opt, model: engine.model };
  }
  const acc = newAcc();
  const rel = STATIC_WORKFLOWS[run.action] ?? workflowRelForAction(run.action);
  if (rel) scanGraph(acc, load, rel, false);
  else acc.missing.push(`${run.pack}:${run.action}`);
  const notes: string[] = [];
  if (run.groundedLora)
    notes.push(
      "Also needs a Krea 2 edit LoRA (grounded family): install one from the Edit tab's LoRA list.",
    );
  return finish(acc, engine.id, engine.label, { model: engine.model, notes });
}

function engineSetup(
  key: string,
  engines: EditEngineId[],
  load: LoadWorkflow,
): ToolSetup | null {
  const options = [...new Set(engines)]
    .map((e) => engineOption(e, load))
    .filter((o): o is SetupOption => !!o);
  if (!options.length) return null;
  return { key, anyOf: options.length > 1, options };
}

const BASE_LABELS = (
  editRegistryJson as unknown as { bases: Record<string, { label: string }> }
).bases;

const SPECIAL_PIPELINES: Record<string, string> = {
  "special:dub_video": "dub_video",
  "special:voice_changer": "voice_changer",
};

/** Pipeline stages only an alternate engine / mode runs. */
const PIPELINE_ALTERNATES = new Set([
  "dub_voice_chatterbox",
  "dub_transcribe_speakers",
  "voice_change_video",
]);

const SPECIAL_ENGINES: Record<string, EditEngineId[]> = {
  "special:storyboard": STORYBOARD_ENGINES,
};

/**
 * Requirements for a hub card, by its key ("action:<id>", "catalog:<id>",
 * "template:<id>", "app:<id>", "special:<id>"). `id` is the card's own id
 * (the Outpaint card's key does not name its tool). Null = this card has no
 * model files the resolver knows about.
 */
export function resolveToolSetup(
  key: string,
  load: LoadWorkflow,
  id?: string,
): ToolSetup | null {
  const [kind, ...rest] = key.split(":");
  const ref = rest.join(":");
  if (kind === "action") {
    const spec = ACTION_TOOLS.find((s) => s.id === ref);
    return spec
      ? { key, anyOf: false, options: [actionOption(spec, load)] }
      : null;
  }
  if (kind === "catalog") {
    const tools = getEditTools();
    if (key === OUTPAINT_CARD_KEY) {
      // Any one outpaint backend runs the card.
      const options = tools
        .filter((t) => t.outpaint != null)
        .map((t) => ({
          ...catalogOption(t, load, t.id, t.label),
          model: BASE_LABELS[t.base]?.label ?? t.base,
        }));
      return options.length
        ? { key, anyOf: options.length > 1, options }
        : null;
    }
    const tool = tools.find((t) => t.id === (id ?? ref));
    return tool
      ? { key, anyOf: false, options: [catalogOption(tool, load)] }
      : null;
  }
  if (kind === "template") {
    const t = getTemplate(ref);
    return t ? engineSetup(key, t.engines, load) : null;
  }
  if (kind === "app") {
    const app = getApp(ref);
    return app ? engineSetup(key, appEngines(app), load) : null;
  }
  if (SPECIAL_ENGINES[key]) return engineSetup(key, SPECIAL_ENGINES[key], load);
  const pipe = PIPELINE_TOOLS.find((p) => p.id === SPECIAL_PIPELINES[key]);
  if (pipe) {
    const acc = newAcc();
    // Every pipeline stage runs on a default run except the alternates.
    const req = new Set<string>();
    const alt = new Set<string>();
    for (const a of pipe.actions) {
      const rel = workflowRelForAction(a);
      if (rel) (PIPELINE_ALTERNATES.has(a) ? alt : req).add(rel);
    }
    req.forEach((rel) => scanGraph(acc, load, rel, false));
    alt.forEach((rel) => {
      if (!req.has(rel)) scanGraph(acc, load, rel, true);
    });
    addByName(acc, pipe.title);
    return { key, anyOf: false, options: [finish(acc, "tool", pipe.title)] };
  }
  return null;
}

// Totals

export function setupTotals(files: SetupFile[]): SetupTotals {
  let requiredBytes = 0;
  let allBytes = 0;
  let unknown = 0;
  for (const f of files) {
    if (f.bytes == null) {
      unknown++;
      continue;
    }
    allBytes += f.bytes;
    if (!f.optional) requiredBytes += f.bytes;
  }
  return { requiredBytes, allBytes, unknown };
}

// Presence

export type FileStatus = "installed" | "missing" | "unknown";

/** Normalize a GET /models/<type> (or disk) listing entry. */
export function normalizeListing(names: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const n of names) out.add(n.replace(/\\/g, "/").toLowerCase());
  return out;
}

/**
 * Whether a file is in its folder type's listing (names relative to the type,
 * lowercase, "/"-separated). A same-named file in another subfolder counts:
 * it only needs moving. Null listing = could not check.
 */
export function fileStatus(
  f: SetupFile,
  listing: Set<string> | null,
): FileStatus {
  if (!listing || !f.type) return "unknown";
  const name = f.name.toLowerCase();
  if (f.byName) {
    const dir = name.endsWith("/") ? name : `${name}/`;
    for (const n of listing) if (n.startsWith(dir)) return "installed";
    return "missing";
  }
  if (listing.has(name)) return "installed";
  const base = f.file.toLowerCase();
  for (const n of listing)
    if (n === base || n.endsWith(`/${base}`)) return "installed";
  return "missing";
}

export { formatBytes };
