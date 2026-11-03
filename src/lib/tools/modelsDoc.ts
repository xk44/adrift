/**
 * docs/models.md generator
 * Renders the public model download list from the same data docs/TOOLS.md
 * uses (toolsDoc.ts), plus a checked-in size/source table:
 *
 *   ACTION_TOOLS + PIPELINE_TOOLS      tool -> actions -> workflow graphs
 *   editToolRegistry.json              catalog tools -> base graph + LoRAs
 *   public/workflows/packs/**.json     loader nodes -> weight files + folder
 *   MODEL_FAMILIES (toolsDoc.ts)       weight file -> family + license
 *   modelSizes.json                    weight file -> bytes, source, set
 *
 * Pure: the caller passes `loadWorkflow` and the list of pack graphs, so this
 * module never touches the filesystem. src/__tests__/modelsDoc.test.ts keeps
 * the committed docs/models.md in sync (regenerate with `npm run docs:models`).
 */

import sizesJson from "./modelSizes.json";
import { parseModelName } from "@/lib/comfy/modelVariants";
import { licenseUrlFor } from "@/lib/models/licenseLinks";
import { ACTION_TOOLS, type ActionToolSpec } from "./toolsPage";
import {
  allToolLoraFiles,
  getEditTools,
  STATIC_WORKFLOWS,
  toolLicense,
  type EditToolDef,
} from "./editTools";
import {
  actionsForTool,
  categoryOrder,
  cell,
  COMMERCIAL_CELL,
  familyFor,
  workflowRelForAction,
  workflowWeightRefs,
  worstCommercial,
  type Commercial,
  type LoadWorkflow,
  type ModelFamily,
  type WeightRef,
  EXTRA_FAMILIES,
  MODEL_FAMILIES,
} from "./toolsDoc";

// Size / source data

export type DownloadSet = "minimal" | "full";

export interface ModelFileInfo {
  /** Byte count (Hugging Face reported unless `measured`); null = unknown. */
  bytes: number | null;
  /** "owner/repo" on Hugging Face, or a full https URL; null = none known. */
  source: string | null;
  /** Download-list set; null = not in the public download list. */
  set: DownloadSet | null;
  /** Hugging Face repo is gated: the user must accept its terms first. */
  gated?: boolean;
  /** Where a non-HF size came from (e.g. "local copy"). */
  measured?: string;
  /** Short reason shown in the doc (used for unknown sizes). */
  note?: string;
  /**
   * Published in another key format: the converter script to run after the
   * download. The setup drawer gives no one-line command for such a file.
   */
  convert?: string;
}

/** A model a node loads by name (a folder), not by a weight-file input. */
export interface ByNameModel {
  tools: string;
  model: string;
  folder: string;
  bytes: number | null;
  measured?: string;
  license: string;
  source: string;
}

export interface ModelSizes {
  about: string;
  files: Record<string, ModelFileInfo>;
  byName: ByNameModel[];
}

export const MODEL_SIZES = sizesJson as unknown as ModelSizes;

// Loader node -> ComfyUI/models/ folder

/**
 * Models folder each loader input reads from, keyed "Class.input" or "Class"
 * (any input). The graph value's own sub-path is appended, so
 * "split_files/vae/x.safetensors" on a VAELoader lands in vae/split_files/vae/.
 */
export const LOADER_FOLDERS: Record<string, string> = {
  UNETLoader: "diffusion_models",
  UnetLoaderGGUF: "diffusion_models",
  CLIPLoader: "text_encoders",
  DualCLIPLoader: "text_encoders",
  VAELoader: "vae",
  LoraLoaderModelOnly: "loras",
  AnimaRefAdapter: "loras",
  AnimaRefAdapterLoader: "loras",
  LoraLoader: "loras",
  Krea2ControlLoRALoader: "loras",
  "Krea2DualControlApply.adapter_name": "loras",
  "MOSSi2iReference.lora_name": "loras",
  // Open-H3-Regenerate 2K finish: LoRA + Sharp curve branches (models/loras),
  // curve_table = the reference H3 checkpoint (models/diffusion_models).
  "OpenH3RegenLora.lora_name": "loras",
  "OpenH3RegenLora.curve_name": "loras",
  "OpenH3RegenLora.curve_table": "diffusion_models",
  "MOSSImageLoader.dit": "diffusion_models",
  "MOSSImageLoader.text_encoder": "text_encoders",
  "MOSSImageLoader.vae": "vae",
  // ComfyUI-WanVideoWrapper (Upscale video's FlashVSR engine).
  WanVideoModelLoader: "diffusion_models",
  WanVideoExtraModelSelect: "diffusion_models",
  LoadWanVideoT5TextEncoder: "text_encoders",
  WanVideoFlashVSRDecoderLoader: "vae",
  CheckpointLoaderSimple: "checkpoints",
  CLIPVisionLoader: "clip_vision",
  AudioEncoderLoader: "audio_encoders",
  ControlNetLoader: "controlnet",
  FrameInterpolationModelLoader: "frame_interpolation",
  LatentUpscaleModelLoader: "latent_upscale_models",
  LoadBackgroundRemovalModel: "background_removal",
  LoadMoGeModel: "geometry_estimation",
  ConditioningLoader: "embeddings",
  LoadDA3Model: "geometry_estimation",
  MMAudioModelLoader: "mmaudio",
  MMAudioFeatureUtilsLoader: "mmaudio",
  ModelPatchLoader: "model_patches",
  // SAM 3D Body: core loader lists models/detection/.
  SAM3DBody_Loader: "detection",
  UltralyticsDetectorProvider: "ultralytics",
  UpscaleModelLoader: "upscale_models",
  // cj_stems: torchaudio Hybrid Demucs state dict under models/demucs/.
  "CJAudioStems.weights": "demucs",
};

/** Folder under ComfyUI/models/ (trailing slash), or undefined if unmapped. */
export function folderForRef(ref: WeightRef): string | undefined {
  let base: string | undefined;
  if (ref.classType === "ChatterboxMTLTTS" && ref.input === "model_version") {
    // The node reads its weights from tts/chatterbox/<model_pack_name>/.
    const pack = ref.node.inputs?.model_pack_name;
    base = `tts/chatterbox/${typeof pack === "string" ? pack : "<pack>"}`;
  } else {
    base =
      LOADER_FOLDERS[`${ref.classType}.${ref.input}`] ??
      LOADER_FOLDERS[ref.classType];
  }
  if (base === undefined) return undefined;
  const dir = ref.file.includes("/")
    ? ref.file.slice(0, ref.file.lastIndexOf("/"))
    : "";
  const parts = [base, dir].filter(Boolean);
  return parts.length ? `${parts.join("/")}/` : "";
}

function baseName(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

// Tools

/** Tools-page cards that run a multi-step pipeline (not in ACTION_TOOLS). */
export const PIPELINE_TOOLS: {
  id: string;
  title: string;
  category: string;
  actions: string[];
}[] = [
  {
    id: "dub_video",
    title: "Video Translator",
    category: "Audio",
    actions: [
      "dub_transcribe",
      "dub_transcribe_speakers",
      "dub_translate",
      "dub_voice",
      "dub_voice_chatterbox",
      "dub_mux",
      "video_lipsync",
    ],
  },
  {
    id: "voice_changer",
    title: "Voice Changer",
    category: "Audio",
    actions: ["voice_change", "voice_change_video"],
  },
];

export interface ModelsDocTool {
  key: string;
  /** Short title (used in "Used by"). */
  title: string;
  /** Per-tool table title (H3 tools carry the optional-pack suffix). */
  tableTitle: string;
  category: string;
  kind: "action" | "pipeline" | "catalog";
  base?: string;
  /** Distinct weight basenames, in graph order. */
  files: string[];
  commercial: Commercial;
}

export interface ModelsDocFile {
  file: string;
  folders: string[];
  info?: ModelFileInfo;
  family?: ModelFamily;
  familyLabel: string;
  license: string;
  commercial: Commercial;
  usedBy: string[];
  packs: string[];
}

export interface ModelsDocResult {
  markdown: string;
  tools: ModelsDocTool[];
  files: ModelsDocFile[];
  /** Basenames referenced by a graph or tool with no modelSizes.json entry. */
  missingSizes: string[];
  /** modelSizes.json entries nothing references any more. */
  staleSizes: string[];
  /** "Class.input" loader references with no LOADER_FOLDERS entry. */
  unmappedLoaders: string[];
  /** Workflow paths a tool resolves to that could not be loaded. */
  missingWorkflows: string[];
}

interface FileAcc {
  /** First graph path seen (sub-folder included), for the family lookup. */
  ref?: string;
  folders: Set<string>;
  usedBy: string[];
  packs: Set<string>;
  catalog: EditToolDef[];
}

function packOf(rel: string): string | undefined {
  const m = rel.match(/^packs\/([^/]+)\//);
  return m?.[1];
}

/** "21.50 GB" / "444 MB" (decimal units, as Hugging Face reports). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "unknown";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function totalSize(files: string[]): string {
  let sum = 0;
  let unknown = 0;
  for (const f of files) {
    const b = MODEL_SIZES.files[f]?.bytes;
    if (b == null) unknown++;
    else sum += b;
  }
  const known = formatBytes(sum);
  if (!unknown) return known;
  return sum ? `${known} + ${unknown} unknown` : "unknown";
}

function sourceCell(info: ModelFileInfo | undefined): string {
  const src = info?.source;
  if (!src) return "unknown";
  let out: string;
  if (!src.includes("://")) out = `[${src}](https://huggingface.co/${src})`;
  else {
    const hf = src.match(/^https:\/\/huggingface\.co\/(.+)$/);
    out = hf ? `[${hf[1]}](${src})` : `[release page](${src})`;
  }
  return info?.gated ? `${out} (gated)` : out;
}

function usedByCell(names: string[]): string {
  if (names.length <= 4) return names.join(", ");
  return `${names.slice(0, 4).join(", ")} +${names.length - 4} more`;
}

const NUMBER_WORDS = [
  "No",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
];

export function buildModelsDoc(
  load: LoadWorkflow,
  packGraphs: string[],
  actionTools: ActionToolSpec[] = ACTION_TOOLS,
  catalogTools: EditToolDef[] = getEditTools(),
): ModelsDocResult {
  const acc = new Map<string, FileAcc>();
  const unmappedLoaders = new Set<string>();
  const missing = new Set<string>();
  const tools: ModelsDocTool[] = [];

  const fileAcc = (base: string): FileAcc => {
    let a = acc.get(base);
    if (!a) {
      a = { folders: new Set(), usedBy: [], packs: new Set(), catalog: [] };
      acc.set(base, a);
    }
    return a;
  };

  const famOf = (base: string) => familyFor(acc.get(base)?.ref ?? base);

  /** Record every weight reference of one graph; returns its basenames. */
  const scanGraph = (
    rel: string,
    skip?: (ref: WeightRef) => boolean,
    includeInert = false,
  ): string[] => {
    const wf = load(rel);
    if (!wf) {
      missing.add(rel);
      return [];
    }
    const out: string[] = [];
    for (const ref of workflowWeightRefs(wf, { includeInert })) {
      if (skip?.(ref)) continue;
      const base = baseName(ref.file);
      const a = fileAcc(base);
      a.ref ??= ref.file;
      const folder = folderForRef(ref);
      if (folder === undefined)
        unmappedLoaders.add(`${ref.classType}.${ref.input}`);
      else a.folders.add(folder);
      const pack = packOf(rel);
      if (pack) a.packs.add(pack);
      if (!out.includes(base)) out.push(base);
    }
    return out;
  };

  const credit = (files: string[], title: string) => {
    for (const f of files) {
      const a = fileAcc(f);
      if (!a.usedBy.includes(title)) a.usedBy.push(title);
    }
  };

  const graphTool = (
    key: string,
    title: string,
    tableTitle: string,
    category: string,
    kind: "action" | "pipeline",
    actions: string[],
    extraFamilies: Commercial[] = [],
  ) => {
    const rels = [
      ...new Set(
        actions.map(workflowRelForAction).filter((r): r is string => !!r),
      ),
    ];
    const files: string[] = [];
    for (const rel of rels)
      for (const f of scanGraph(rel)) if (!files.includes(f)) files.push(f);
    credit(files, title);
    tools.push({
      key,
      title,
      tableTitle,
      category,
      kind,
      files,
      commercial: worstCommercial([
        ...files.map((f) => famOf(f)?.commercial ?? "unverified"),
        ...extraFamilies,
      ]),
    });
  };

  for (const spec of actionTools) {
    graphTool(
      `action:${spec.id}`,
      spec.title,
      spec.requiredPack === "minimax"
        ? `${spec.title} (optional MiniMax H3 pack)`
        : spec.title,
      spec.category,
      "action",
      actionsForTool(spec),
      // Weights kept outside models/ (a node pack's folder) are invisible to
      // the graph scan, so the family named in EXTRA_FAMILIES sets the cell.
      (EXTRA_FAMILIES[spec.id] ?? []).flatMap((id) => {
        const fam = MODEL_FAMILIES.find((f) => f.id === id);
        return fam ? [fam.commercial] : [];
      }),
    );
  }
  for (const p of PIPELINE_TOOLS) {
    graphTool(
      `pipeline:${p.id}`,
      p.title,
      p.title,
      p.category,
      "pipeline",
      p.actions,
    );
  }

  for (const tool of catalogTools) {
    const rel =
      STATIC_WORKFLOWS[tool.packAction] ??
      workflowRelForAction(tool.packAction);
    if (!rel) missing.add(`${tool.pack}:${tool.packAction}`);
    // The runner strips the base graph's LoRA chain (or the MOSSi2iReference
    // LoRA) and loads the tool's own LoRAs instead.
    const graphFiles = rel
      ? scanGraph(
          rel,
          (ref) =>
            ref.classType === "LoraLoaderModelOnly" ||
            (ref.classType === "MOSSi2iReference" && ref.input === "lora_name"),
        )
      : [];
    const loraFiles: string[] = [];
    for (const lf of allToolLoraFiles(tool)) {
      const base = baseName(lf);
      const a = fileAcc(base);
      a.ref ??= lf;
      a.folders.add(
        `loras/${lf.includes("/") ? `${lf.slice(0, lf.lastIndexOf("/"))}/` : ""}`,
      );
      if (!a.catalog.includes(tool)) a.catalog.push(tool);
      if (!loraFiles.includes(base)) loraFiles.push(base);
    }
    const files = [
      ...graphFiles,
      ...loraFiles.filter((f) => !graphFiles.includes(f)),
    ];
    credit(files, tool.label);
    const license = toolLicense(tool);
    const statuses = files
      .map((f) => famOf(f)?.commercial)
      .filter((c): c is Commercial => !!c);
    if (license.commercial === false) statuses.push("no");
    else if (license.commercial === null && !statuses.length)
      statuses.push("unverified");
    tools.push({
      key: `catalog:${tool.id}`,
      title: tool.label,
      tableTitle: tool.label,
      category: tool.category,
      kind: "catalog",
      base: tool.base,
      files,
      commercial: worstCommercial(statuses),
    });
  }

  // Every pack graph, strength-0 stack LoRAs included (loadable by a flag).
  for (const rel of packGraphs) scanGraph(rel, undefined, true);

  const files: ModelsDocFile[] = [...acc.entries()].map(([file, a]) => {
    const family = familyFor(a.ref ?? file);
    const info = MODEL_SIZES.files[file];
    let familyLabel = family?.label ?? "unmapped";
    let license = family?.license ?? "see source";
    let commercial: Commercial = family?.commercial ?? "unverified";
    if (!family && a.catalog.length) {
      familyLabel = "catalog LoRA";
      license = toolLicense(a.catalog[0]).name;
      commercial = worstCommercial(
        a.catalog.map((t) => {
          const c = toolLicense(t).commercial;
          return c === true ? "yes" : c === false ? "no" : "unverified";
        }),
      );
    }
    return {
      file,
      folders: [...a.folders].sort(),
      info,
      family,
      familyLabel,
      license,
      commercial,
      usedBy: a.usedBy,
      packs: [...a.packs].sort(),
    };
  });
  const sortKey = (f: ModelsDocFile) =>
    `${f.folders[0] ?? ""}${f.file}`.toLowerCase();
  files.sort((x, y) =>
    sortKey(x) < sortKey(y) ? -1 : sortKey(x) > sortKey(y) ? 1 : 0,
  );

  const referenced = new Set(files.map((f) => f.file));
  // A precision sibling of a referenced file (bf16 next to a graph's int8)
  // is the runtime fallback (lib/comfy/modelVariants.ts), so it keeps its
  // size entry for the setup drawer even though no graph names it.
  const stemOf = (f: string) => parseModelName(f)?.stem ?? null;
  const referencedStems = new Set(
    files.map((f) => stemOf(f.file)).filter((s): s is string => !!s),
  );
  const result = {
    tools,
    files,
    missingSizes: files
      .filter((f) => !f.info)
      .map((f) => f.file)
      .sort(),
    staleSizes: Object.keys(MODEL_SIZES.files)
      .filter((f) => !referenced.has(f))
      .filter((f) => {
        const stem = stemOf(f);
        return !stem || !referencedStems.has(stem);
      })
      .sort(),
    unmappedLoaders: [...unmappedLoaders].sort(),
    missingWorkflows: [...missing].sort(),
  };
  return { ...result, markdown: renderModelsDoc(result) };
}

// Rendering

function fileList(files: string[]): string {
  return files.map((f) => `\`${f}\``).join(", ");
}

function setCell(info: ModelFileInfo | undefined): string {
  return info?.set ?? "not in list";
}

/** License name for a table cell, linked to its text when a link is known. */
export function licenseCell(name: string): string {
  const url = licenseUrlFor(name);
  const text = cell(name);
  return url ? `[${text.replace(/[[\]]/g, "\\$&")}](${url})` : text;
}

function fileRow(f: ModelsDocFile, last: string): string {
  return `| \`${f.file}\` | ${f.folders.map((d) => `\`${d}\``).join(", ")} | ${formatBytes(f.info?.bytes)} | ${cell(f.familyLabel)} | ${licenseCell(f.license)} | ${COMMERCIAL_CELL[f.commercial]} | ${setCell(f.info)} | ${sourceCell(f.info)} | ${cell(last)} |`;
}

function renderModelsDoc(r: Omit<ModelsDocResult, "markdown">): string {
  const measured = r.files.filter(
    (f) => f.info?.measured && f.info.bytes != null,
  ).length;
  const lines: string[] = [
    "# Model download list",
    "",
    "<!-- Generated by src/lib/tools/modelsDoc.ts from src/lib/tools/modelSizes.json. Do not edit by hand: run `npm run docs:models`. -->",
    "",
    "Every weight file the Tools page can load, grouped per tool, with the folder it goes in",
    "under `ComfyUI/models/`, its size, license and source. Adrift ships **no weights**: download",
    "only the files for the tools you want. A card whose files are missing stays disabled and",
    "names them; `GET /api/tools/model-status` returns the same list.",
    "",
    "How this list is built:",
    "",
    "- **Files** come from the loader nodes of the ComfyUI graph each tool queues",
    "  (`public/workflows/packs/<pack>/*.json`, resolved through `src/lib/tools/toolsDoc.ts`, the same",
    "  path `docs/TOOLS.md` uses). `src/lib/tools/modelStatus.ts` checks the same names on disk.",
    "- **Folder** is the path under `ComfyUI/models/`. ComfyUI also searches the legacy aliases",
    "  (`unet/` for `diffusion_models/`, `clip/` for `text_encoders/`).",
    "- **Size** is the Hugging Face reported byte count of the file (decimal GB / MB), kept in",
    `  \`src/lib/tools/modelSizes.json\`. ${NUMBER_WORDS[measured] ?? measured} file${measured === 1 ? "" : "s"} outside the public download list ${measured === 1 ? "was" : "were"} measured from a`,
    "  local copy. `unknown` means no verified number.",
    "- **Commercial** is the model family license as recorded in `src/lib/tools/toolsDoc.ts`",
    "  (`MODEL_FAMILIES`): `yes`, `restricted` (revenue cap, territory or copyleft condition),",
    "  **no (nc)** for non-commercial weights, or `check license` (terms not confirmed). Catalog LoRAs without their own",
    "  family entry carry the license of the catalog tool (its base model). **License** links to",
    "  the license text where a verified link is known (composite names link the base model's);",
    "  more detail in [MODELS.md](../MODELS.md). Not legal advice: read each license before commercial use.",
    "- **Set**: `minimal` files cover the core video, upscale, 3D and audio tools; `full` adds",
    "  optional extras (motion LoRAs, alternative quantizations, the LTX-2.5 and MiniMax H3",
    "  packs). `not in list` files are not in the public download list.",
    "- **Source** marked (gated) is a gated Hugging Face repo: sign in and accept its terms on",
    "  the repo page before the download works.",
    "",
    "Non-commercial (nc) weights to watch for: Qwen-Image 2.1 and its LoRAs, Bria FIBO 2.0,",
    "MMAudio, Lucy Edit, MatAnyone2 (the named-subject engine of Remove video background).",
    "MiniMax-Remover is also non-commercial if you add tools built on it. The MiniMax H3 pack is region-restricted (see the README) and is",
    "never a default.",
    "",
    "## Per tool",
    "",
    "| Tool | Category | Files | Download size | Commercial |",
    "|---|---|---|---|---|",
  ];
  const graphTools = r.tools
    .filter((t) => t.kind !== "catalog" && t.files.length)
    .map((t, i) => ({ t, i }))
    .sort(
      (a, b) =>
        categoryOrder(a.t.category) - categoryOrder(b.t.category) || a.i - b.i,
    )
    .map(({ t }) => t);
  for (const t of graphTools) {
    lines.push(
      `| ${cell(t.tableTitle)} | ${cell(t.category)} | ${fileList(t.files)} | ${totalSize(t.files)} | ${COMMERCIAL_CELL[t.commercial]} |`,
    );
  }
  lines.push(
    "",
    "Sizes are totals of the distinct files a tool can load across all of its modes (for",
    "example both the fast and the full-quality variant); one run usually loads fewer.",
  );

  const gatedTools = graphTools.filter((t) =>
    t.files.some((f) => MODEL_SIZES.files[f]?.gated),
  );
  if (gatedTools.length) {
    lines.push(
      "",
      `Gated downloads: ${gatedTools.map((t) => t.title).join(", ")} load weights from gated`,
      "Hugging Face repos (marked (gated) in the Source column; the LTX-2.5 base files and each LTX VFX",
      "LoRA has its own repo). Sign in and accept the license terms on every such repo page, then download.",
    );
  }

  lines.push(
    "",
    "Tools that load models by name rather than by file:",
    "",
    "| Tool | Model | Folder | Size | License | Source |",
    "|---|---|---|---|---|---|",
    ...MODEL_SIZES.byName.map(
      (m) =>
        `| ${cell(m.tools)} | ${cell(m.model)} | \`${m.folder}\` | ${formatBytes(m.bytes)} | ${licenseCell(m.license)} | ${sourceCell({ source: m.source, bytes: null, set: null })} |`,
    ),
    "",
    "The whisper folder's files are pinned in the public download list (`models/download-list.md`, `stt/whisper/whisper-large-v3-turbo/`).",
    "The whisper ASR node (`cj_whisper_asr`) reads that folder from its `model_path` input, and the shipped",
    "`packs/audio/dub_transcribe.json` sets `whisper/whisper-large-v3-turbo`, resolved under the `stt` model folder:",
    "put the checkpoint there or point `model_path` at your copy",
    "(see `comfy_nodes/cj_whisper_asr/README.md`).",
    "VibeVoice-Realtime also reads its voice prompts from `tts/VibeVoice/voices/` (from the",
    "[microsoft/VibeVoice](https://github.com/microsoft/VibeVoice) repo, `demo/voices/streaming_model`).",
    "The Video Translator lipsync mode also needs the Lipsync onto video files above.",
    "Its Several speakers option reads `tts/VibeVoice/VibeVoice-ASR-HF/` (microsoft/VibeVoice-ASR-HF, about 16 GB, MIT) and needs transformers 5.3 or newer.",
    "Chatterbox runs through the wildminder/ComfyUI-Chatterbox node pack (Apache-2.0; the weights",
    "are MIT). The shipped graphs (`packs/audio/voice_change.json`, `voice_change_video.json`,",
    "`dub_voice_chatterbox.json`) set `model_pack_name` to `chatterbox_local`; the node's own",
    "default pack name is `resembleai_default_voice`. Put the files in the folder that matches the",
    "name the graphs use, or change the input to a pack your install lists. The Video Translator",
    "multilingual engine also loads `t3_mtl23ls_v3.safetensors` (below) plus",
    "`grapheme_mtl_merged_expanded_v1.json` (70 KB) from the same folder.",
  );

  const catalog = r.tools.filter((t) => t.kind === "catalog");
  if (catalog.length) {
    lines.push(
      "",
      "## Catalog tools",
      "",
      "Each catalog (edit LoRA) tool loads its base edit graph plus its own LoRAs (and the",
      "base's speed LoRA when Turbo is on). Registry: `src/lib/tools/editToolRegistry.json`.",
      "",
      "| Tool | Base | Files | Download size | Commercial |",
      "|---|---|---|---|---|",
      ...catalog.map(
        (t) =>
          `| ${cell(t.title)} | ${cell(t.base ?? "")} | ${fileList(t.files)} | ${totalSize(t.files)} | ${COMMERCIAL_CELL[t.commercial]} |`,
      ),
    );
  }

  const header = (last: string) => [
    `| File | Folder (\`ComfyUI/models/...\`) | Size | Model family | License | Commercial | Set | Source | ${last} |`,
    "|---|---|---|---|---|---|---|---|---|",
  ];
  const toolFiles = r.files.filter((f) => f.usedBy.length);
  const packOnly = r.files.filter((f) => !f.usedBy.length);
  lines.push(
    "",
    "## All files",
    "",
    ...header("Used by"),
    ...toolFiles.map((f) => fileRow(f, usedByCell(f.usedBy))),
    "",
    "Some packs ship several quantizations of one model (bf16 / fp8 / GGUF); the graphs load",
    "the file named above, so download that one or edit the loader node to match what you have.",
    "A file with two folders is referenced by both paths in different graphs; place (or link) it in each.",
    "Weights for the optional MiniMax H3 pack are listed for completeness only; check the",
    "license territory terms in the README before downloading them.",
  );
  if (packOnly.length) {
    lines.push(
      "",
      "## Other pack files",
      "",
      "Files that a pack graph loads but no Tools-page card queues (image engines, alternative",
      "graphs). Only needed if you run those graphs.",
      "",
      ...header("Packs"),
      ...packOnly.map((f) =>
        fileRow(f, f.packs.map((p) => `\`${p}\``).join(", ")),
      ),
    );
  }
  const notes = r.files.filter((f) => f.info?.note);
  if (notes.length) {
    lines.push(
      "",
      "Notes:",
      "",
      ...notes.map((f) => `- \`${f.file}\`: ${f.info!.note}`),
    );
  }
  lines.push("");
  return lines.join("\n");
}
