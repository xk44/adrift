// Core generation types
export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface ImagineJob {
  prompt_id?: string;
  seed: number;
  index: number;
  status: JobStatus;
  progress: number;
  images: string[];
  videos?: string[];
  audios?: string[];
  meshes?: string[];
  /** Text outputs (e.g. ShowText / caption nodes) from ComfyUI history. */
  texts?: string[];
  error?: string;
  currentNode?: string;
  /** Human-readable label for the currently executing node */
  currentNodeLabel?: string;
  /** Step progress within the current node (e.g. diffusion steps) */
  nodeProgress?: { current: number; total: number };
  /** Overall node completion tracking */
  completedNodes?: number;
  startedAt?: number;
  completedAt?: number;
  /**
   * XYZ-plot / grid mode: per-cell prompt that overrides the run's shared
   * parsedPrompt when this job's workflow is built (one grid combination).
   */
  promptOverride?: string;
  /** Short human-readable label for this grid cell (e.g. the varied text). */
  label?: string;
  /** Multi-machine: the ComfyUI machine that accepted this job. */
  backend?: JobBackend;
}

/** A ComfyUI machine as recorded on a job (routing id + display name). */
export interface JobBackend {
  /** "default" (main), "video" (env host) or a saved instance id. */
  id: string;
  name: string;
}

export interface ImagineRun {
  run_id: string;
  prompt: string;
  parsedPrompt: string;
  width: number;
  height: number;
  jobs: ImagineJob[];
  createdAt: string;
  status: JobStatus;
  params: Record<string, unknown>;
  sourceImage?: string;
  sourceImages?: ImageAttachment[];
  action?: string;
  model?: string;
  vae?: string;
  loras?: LoraWeight[];
  /** Map of node ID → class_type from the submitted workflow, for live progress labels */
  workflowNodeClassMap?: Record<string, string>;
  /** Internal provenance for runs hydrated from the shared server history. */
  historySource?: "server";
  /**
   * Draft-then-upscale pipeline: when true, the run was generated at reduced
   * resolution and clients should auto-fire the upscale action on completion.
   * The `draftTargetWidth` / `draftTargetHeight` fields hold the original
   * target dimensions for the upscale pass.
   */
  draftUpscale?: boolean;
  draftTargetWidth?: number;
  draftTargetHeight?: number;
  /**
   * Refiner slot: identifier for the upscale/refine workflow to use in a
   * draft-then-upscale pipeline. Defaults to "upscale_subtle". Future values:
   * "sol_refiner" (NVIDIA SoL-Refiner 1-step), "x2_detail" (X2-Detail VAE).
   */
  refinerSlot?: string;
}

// Model/LoRA/VAE alias types
export interface ModelAlias {
  alias: string;
  filename: string;
  type: "checkpoint" | "lora" | "vae";
  description?: string;
}

export interface LoraWeight {
  name: string; // alias or filename
  filename?: string; // resolved filename
  strength: number; // -2.0 to 2.0
  clipStrength?: number;
}

export type EditLoraFamily = "krea2edit" | "ostris" | "qwen" | "krea2inpaint";

/** A Krea 2 edit LoRA and the workflow family it was trained for. */
export interface EditLora {
  id: string;
  name: string;
  file: string;
  family: EditLoraFamily;
  base: string;
  defaultStrength: number;
  note?: string;
  url?: string;
  /** Enable only for Ostris edit LoRAs trained with ai-toolkit kv_cache. */
  kvCache?: boolean;
  /** Present on user-added entries (not in the bundled registry). */
  custom?: boolean;
  /** Low-VRAM rank-reduced variants (e.g. r128/r64), filename by key. */
  variants?: Record<string, string>;
}

// Image attachment modes (for different workflows)
export type ImageMode =
  | "starting_frame" // Animation starting frame
  | "image_prompt" // img2img / Image Prompts
  | "style_ref" // Style reference (sref)
  | "char_ref" // Character reference (cref)
  | "control" // ControlNet
  | "mask"; // Inpainting mask

export interface ImageAttachment {
  id: string;
  url: string;
  file?: File;
  filename?: string;
  mode: ImageMode;
  weight: number;
  controlType?: string; // canny, depth, pose, etc.
}

// Parameter types
export type ParamKind = "flag" | "int" | "float" | "string" | "aspect";

export interface ParamDef {
  flags: string[];
  kind: ParamKind;
  multi?: boolean;
  min?: number;
  max?: number;
  default?: unknown;
  description?: string;
  /** Parsed only to be reported in unknownFlags (value consumed, not applied). */
  unsupported?: boolean;
  nodeMapping?: {
    node: string;
    param?: string;
    params?: string[];
    target?: string;
  };
  comfyMapping?: {
    type: string;
    formula?: string;
  };
}

export interface ParseResult {
  prompt: string;
  params: Record<string, unknown>;
  unknownFlags: string[];
  errors: string[];
}

// Workflow types
export type WorkflowKind =
  | "t2i"
  | "i2i"
  | "upscale"
  | "inpaint"
  | "outpaint"
  | "controlnet"
  | "t2v"
  | "i2v"
  | "r2v"
  | "t23d"
  | "i23d"
  | "t2a";

export interface WorkflowTemplate {
  file: string;
  kind: WorkflowKind;
  name: string;
  denoise?: number;
}

export interface ControlNetSlot {
  /** Node ID of the ControlNetLoader node */
  loaderId: string;
  /** Node ID of the ControlNetApply (or ApplyAdvanced) node */
  applyId: string;
  /** Node ID of the preprocessor node (e.g. CannyEdgePreprocessor) */
  preprocessorId?: string;
  /** Node ID of the image source LoadImage node */
  imageInputId: string;
  /** Which conditioning input this ControlNet targets: "positive" | "negative" */
  conditioningTarget: "positive" | "negative";
  /** Default strength from the workflow */
  defaultStrength?: number;
  /** Default control net model name from the workflow */
  defaultModel?: string;
}

export interface IPAdapterSlot {
  /** Node ID for the IPAdapter loader/apply node */
  applyId: string;
  /** Node class (IPAdapterAdvanced, etc.) */
  applyClass: string;
  /** Image source node ID */
  imageInputId?: string;
  /** Which model input this targets */
  modelTarget?: string;
}

export interface UpscaleSlot {
  /** Node ID of the upscale model loader */
  upscaleModelId: string;
  /** Node class type */
  upscaleModelClass: string;
  /** Upscale model name (e.g. "4x-UltraSharp") */
  defaultModel?: string;
}

export interface VideoSlot {
  /** Node ID of the video output node (VHS_VideoCombine etc.) */
  videoOutputId: string;
  /** Node class */
  videoOutputClass: string;
  /** Motion scale input name (if present) */
  motionInputName?: string;
  /** Frame rate input name */
  frameRateInputName?: string;
  /** Has image input for i2v */
  hasImageInput?: boolean;
}

export interface WorkflowCapabilities {
  /** Workflow can accept ControlNet conditioning */
  controlnet: boolean;
  /** Workflow can accept IPAdapter / style reference */
  ipadapter: boolean;
  /** Workflow supports upscaling */
  upscale: boolean;
  /** Workflow produces or can produce video */
  video: boolean;
  /** Workflow can accept frames / motion control */
  videoMotion: boolean;
  /** Workflow can accept LoRA injection */
  lora: boolean;
}

export interface AdapterConfig {
  /** Adapter type */
  type: "lora" | "sref" | "controlnet" | "ipadapter";
  /** Which loader class to use for this model family */
  loaderClass: string;
  /** Which apply class to use for this model family */
  applyClass: string;
  /** Required preprocessor class (ControlNet) */
  preprocessorClass?: string;
  /** Model family this adapter is valid for */
  modelFamily?: string;
  /** Strength param name on the apply node */
  strengthParamName: string;
  /** Model param name on the loader node */
  modelParamName: string;
  /** Human-readable label for UI (e.g. "IPAdapter Advanced", "Style Reference") */
  label?: string;
  /** Description for UI tooltips/documentation */
  description?: string;
  /** Whether this adapter has a separate loader node (vs self-contained apply) */
  hasSeparateLoader?: boolean;
  /** Whether this adapter produces a model output that chains to the next node */
  hasModelOutput?: boolean;
  /** Whether this adapter requires a CLIP connection (not model-only) */
  requiresClip?: boolean;
  /** Whether this adapter requires an image input */
  requiresImage?: boolean;
  /** Default strength value for UI sliders */
  defaultStrength?: number;
  /** Minimum strength value */
  minStrength?: number;
  /** Maximum strength value */
  maxStrength?: number;
  /** Whether this adapter type supports multiple instances stacking */
  supportsStacking?: boolean;
}

export interface AdapterPack {
  /** Pack identifier (e.g. "sdxl-default", "flux-default") */
  id: string;
  /** Human-readable pack name */
  name: string;
  /** Model family this pack targets */
  modelFamily: string;
  /** Adapter configs available in this pack */
  adapters: AdapterConfig[];
  /** Default workflow overrides for this pack */
  defaultWorkflows?: Record<string, string>;
  /** Tags for UI filtering and categorization */
  tags?: string[];
  /** Human-readable description of this adapter pack */
  description?: string;
}

/**
 * Sub-slots for custom-sampling graphs (SamplerCustom / SamplerCustomAdvanced),
 * where seed/steps/cfg/sampler live on dedicated nodes instead of one KSampler.
 */
export interface CustomSamplingSlots {
  /** RandomNoise node — seed input is `noise_seed` (SamplerCustom keeps it on itself) */
  noiseId?: string;
  /** KSamplerSelect node — `sampler_name` */
  samplerSelectId?: string;
  /** Scheduler node producing SIGMAS — `steps` (and width/height on Ideogram4Scheduler) */
  sigmasId?: string;
  /** Guider node (DualModelGuider/CFGGuider) — `cfg` */
  guiderId?: string;
}

export interface WorkflowSlots {
  ksamplerId: string;
  posTextId: string;
  negTextId: string;
  latentDimsId: string;
  /** Input name carrying the prompt text on posTextId (default: "text") */
  posTextInputName?: string;
  /** Input carrying the negative text when it shares posTextId's node (e.g. "negative_prompt") */
  negTextInputName?: string;
  /** Custom-sampling sub-slots when the graph uses SamplerCustom(Advanced) */
  customSampling?: CustomSamplingSlots;
  /** Remote API partner node (e.g. Krea2ImageNode) that owns prompt/aspect/seed */
  apiPromptNodeId?: string;
  checkpointLoaderId?: string; // CheckpointLoaderSimple node
  loraLoaderIds?: string[]; // LoraLoader nodes (in chain order)
  vaeLoaderId?: string; // VAELoader node (if separate from checkpoint)
  imageInputId?: string;
  maskInputId?: string;
  // Injectable slots
  controlnetSlots?: ControlNetSlot[];
  ipadapterSlots?: IPAdapterSlot[];
  upscaleSlots?: UpscaleSlot[];
  videoSlots?: VideoSlot[];
  // Capability flags (derived from slots + node scan)
  capabilities?: WorkflowCapabilities;
}

// ControlNet configuration for prompt-bar / --controlnet param
export interface ControlNetParams {
  /** ControlNet model name or shorthand */
  model: string;
  /** Preprocessor type: canny, depth, pose, etc. */
  preprocessor: string;
  /** Control strength 0-1 */
  strength: number;
  /** Source image URL or attachment ID */
  sourceImage?: string;
  /** Source image attachment ID */
  sourceImageId?: string;
  /** Start percentile (0-1) for ControlNet begin */
  startPercent?: number;
  /** End percentile (0-1) for ControlNet end */
  endPercent?: number;
}

export type Workflow = Record<string, WorkflowNode>;

export interface WorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: {
    title?: string;
    /** Skip (rewire around) this node when ComfyUI lacks its class_type. */
    optional?: boolean;
    /** Toast shown when the optional node is skipped. */
    optional_warning?: string;
    /** Output index -> pass-through input name, for the optional bypass. */
    passthrough?: Record<string, string>;
    /** UpscaleModelLoader: "fixed" keeps the model, "default" follows the user's choice. */
    upscaler?: "fixed" | "default";
    /** UpscaleModelLoader: content type for the user's choice. */
    upscaleContent?: "photo" | "illustration" | "video";
    /** UpscaleModelLoader: output size follows the preferred scale (Faithful). */
    upscaleScale?: "pref";
  };
}

// Action types
export interface ActionDef {
  id: string;
  name: string;
  icon: string;
  template: string;
  requiresImage?: boolean;
  requiresPrompt?: boolean;
  requiresMask?: boolean;
  params?: Record<string, unknown>;
  group: string;
}

export interface ActionGroup {
  name: string;
  order: number;
}

// ComfyUI API types
export interface ComfyQueueResult {
  prompt_id: string;
  number?: number;
  error?: string;
  node_errors?: Record<string, unknown>;
  /** CJ-side: optional custom nodes bypassed because ComfyUI lacks them. */
  warnings?: string[];
  /** CJ-side (routed submissions): the machine that accepted the prompt. */
  backend?: JobBackend;
}

export interface ComfyHistoryEntry {
  prompt: [number, string, Record<string, unknown>, Record<string, unknown>];
  outputs: Record<
    string,
    {
      images?: ComfyOutputImage[];
      gifs?: ComfyOutputVideo[];
      videos?: ComfyOutputVideo[];
      meshes?: ComfyOutputMesh[];
      /** Core SaveGLB (comfy_api Saved3DModels) reports meshes under "3d". */
      "3d"?: ComfyOutputMesh[];
      audio?: ComfyOutputImage[];
      animated?: unknown;
    }
  >;
  status?: { completed?: boolean; status_str?: string };
}

export interface ComfyOutputImage {
  filename: string;
  subfolder: string;
  type: string;
}

export interface ComfyOutputVideo {
  filename: string;
  subfolder: string;
  type: string;
  format?: string;
}

export interface ComfyOutputMesh {
  filename: string;
  subfolder: string;
  type: string;
  format?: string;
}

export interface ComfyWSMessage {
  type:
    | "status"
    | "progress"
    | "executing"
    | "executed"
    | "execution_start"
    | "execution_error"
    | "execution_interrupted"
    | "execution_cached"
    | "execution_success";
  data: {
    status?: { exec_info?: { queue_remaining: number } };
    node?: string | null;
    prompt_id?: string;
    value?: number;
    max?: number;
    exception_message?: string;
    exception_type?: string;
    node_id?: string | number;
    node_type?: string;
    traceback?: string[];
  };
}

// UI State types
export type NavKey =
  | "explore"
  | "create"
  | "edit"
  | "organize"
  | "personalize"
  | "library"
  | "moodboards"
  | "characters"
  | "styles"
  | "style-creator"
  | "setup"
  | "tasks"
  | "tools"
  | "style-vault"
  | "profile"
  | "account-settings"
  | "help"
  | "updates";

export type StylesHubTab =
  | "library"
  | "boards"
  | "creator"
  | "map"
  | "clusters"
  | "images"
  | "train";

/** Route params extracted from the URL (dynamic segments like :id, :username). */
export interface NavParams {
  /** Username for /@username profile routes */
  username?: string;
  /** Generic ID for resource routes (moodboard, style, etc.) */
  id?: string;
  /** Allow other arbitrary param keys for extensibility */
  [key: string]: string | undefined;
}

export interface GalleryFolder {
  id: string;
  name: string;
  createdAt: number;
}

export type ThemeMode = "dark" | "light";

export interface GenerationSettings {
  aspect: string;
  ratio: number;
  stylize: number;
  /** Reserved: no UI and not emitted (a future slider LoRA). */
  weird: number;
  chaos: number;
  modelMode: "Standard" | "Raw";
  modelVersion: string;
  krea2Backend?: "comfyui" | "direct";
  /** Default video engine for --video prompts (emitted as --vmodel) */
  videoModel?: "ltxv" | "ltx25" | "wan" | "minimax";
  /**
   * H3 Audio video speed (emitted as --h3speed when videoModel is minimax):
   * "off" = Quality (pack recipe), "fast8" = FastH3 distilled DiT, 8 steps.
   */
  h3Speed?: "off" | "fast8";
  /**
   * Video variants per --video run (emitted as --vb when > 1). Each variant
   * is queued separately with its own seed; image batchSize never applies.
   */
  videoBatch?: number;
  personalize: boolean;
  /**
   * Speed tier, emitted as --tier draft|quality (Standard emits nothing).
   * Mapped per engine in src/lib/oj/speedTier.ts. Older builds stored
   * Turbo / Fast / Relax; the UI store migrates them on load.
   */
  speed: "Draft" | "Standard" | "Quality";
  privacy: "Public" | "Stealth";
  quality: number;
  // Model/LoRA/VAE settings
  model?: string; // Alias or filename
  vae?: string; // Alias or filename
  loras: LoraWeight[]; // Active LoRAs with weights
  sampler?: string;
  scheduler?: string;
  steps?: number;
  cfg?: number;
  /** Number of image jobs to queue per prompt. Defaults to 1 for safer GPU use. */
  batchSize?: number;
  /** Fixed seed for reproducible generations; unset = random per job */
  seed?: number;
  /** Default negative prompt terms, appended as --no when not in the prompt */
  negative?: string;
  /** CLIP skip (--clipskip); 1/undefined = off. SD1.5/SDXL family only. */
  clipSkip?: number;
  /** Tiled VAE decode: auto (pixel/low-VRAM threshold), on, off. Default auto. */
  tiledVae?: "auto" | "on" | "off";
  /** Unload ComfyUI models when the model family changes. Default on. */
  freeOnFamilySwitch?: boolean;
  /** Warn before submitting a heavy pack that won't fit memory. Default on. */
  memoryPreflight?: boolean;
}

export interface PromptAttachment {
  id: string;
  name: string;
  url: string;
  file?: File;
  mode: ImageMode;
  weight: number;
}

export interface GalleryImage {
  id: string;
  url: string;
  prompt: string;
  fullPrompt: string; // Original prompt with all parameters
  params: string[]; // Display chips
  paramsMap: Record<string, unknown>; // Parsed params for reuse
  seed: number;
  createdAt: string;
  runId: string;
  jobIndex: number;
  width: number;
  height: number;
  folderIds?: string[];
  liked?: boolean;
  hidden?: boolean;
  /** Internal provenance; local entries are retained when absent from server history. */
  historySource?: "server" | "local";
  model?: string;
  vae?: string;
  loras?: LoraWeight[];
  sourceImages?: ImageAttachment[];
  videoUrl?: string;
  audioUrl?: string;
  meshUrl?: string;
  /** Every 3D file of the job (splat + mesh, body .glb/.bvh); meshUrl is the first. */
  meshUrls?: string[];
  /** Set for non-local images (e.g. Civitai explore) shown in the lightbox */
  external?: {
    source: "civitai";
    id: number;
    thumbnailUrl?: string;
    models?: Array<{ name: string; type: string }>;
  };
}

export interface LightboxState {
  images: GalleryImage[];
  index: number;
  origin: NavKey;
}

export interface ContextMenuState {
  x: number;
  y: number;
  image: GalleryImage;
}

// Store types
export interface GenerationStore {
  runs: ImagineRun[];
  activeRuns: Map<string, ImagineRun>;
  clientId: string;
  wsConnected: boolean;
  queueRemaining: number;

  addRun: (run: ImagineRun) => void;
  updateJob: (
    runId: string,
    jobIndex: number,
    update: Partial<ImagineJob>,
  ) => void;
  setWsConnected: (connected: boolean) => void;
  setQueueRemaining: (count: number) => void;
}

export interface UIStore {
  activeNav: NavKey;
  navParams: NavParams;
  theme: ThemeMode;
  settings: GenerationSettings;
  settingsOpen: boolean;
  lightbox: LightboxState | null;
  contextMenu: ContextMenuState | null;

  setActiveNav: (nav: NavKey) => void;
  setNavParams: (params: NavParams) => void;
  setTheme: (theme: ThemeMode) => void;
  updateSettings: (settings: Partial<GenerationSettings>) => void;
  toggleSettings: () => void;
  openLightbox: (state: LightboxState) => void;
  closeLightbox: () => void;
  openContextMenu: (state: ContextMenuState) => void;
  closeContextMenu: () => void;
}

// Error types
export type ErrorCategory =
  "validation" | "workflow" | "queue" | "execution" | "network" | "unknown";

export interface GenerationError {
  message: string;
  category: ErrorCategory;
  timestamp: number;
  promptId?: string;
  runId?: string;
}

// API response types
export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
  errorCategory?: ErrorCategory;
  warnings?: { unknownFlags?: string[] };
}

export interface ImagineResponse {
  ok: boolean;
  request_id: string;
  runs: ImagineRun[];
  warnings?: { unknownFlags?: string[]; nodes?: string[] };
}

export interface HistoryResponse {
  ok: boolean;
  promptId: string;
  images: string[];
}

// Aspect ratio types
export interface AspectPreset {
  width: number;
  height: number;
  label: string;
}

// Moodboard Types

export interface MoodboardImage {
  url: string;
  weight: number;
  prompt?: string;
  /** Training caption (sidecar text). Manual edits win over auto-captioning. */
  caption?: string;
  /** Which captioner produced `caption` ("manual" for user edits). */
  captionSource?: string;
}

/** Board dataset category: plain moodboard, character concept dataset, or style dataset. */
export type MoodboardKind = "moodboard" | "character" | "style";

/** One LoRA training run recorded against a board (persisted server-side). */
export interface MoodboardTrainingRun {
  jobId: string;
  runName: string;
  version: number;
  triggerWord: string;
  startedAt: string;
  /** Terminal status as last synced from StyleVault ("queued" until updated). */
  status?: string;
  outputLoraPath?: string | null;
}

/** Per-dataset caption training knobs (see lib/moodboards/captions). */
export interface MoodboardCaptionSettings {
  triggerWord?: string;
  /** 0–1: fraction of steps trained with an empty caption. */
  dropoutRate?: number;
  /** Shuffle comma-separated tags each epoch. */
  shuffle?: boolean;
  /** With shuffle, keep the first N tags in place. */
  keepTokens?: number;
}

export interface Moodboard {
  id: string;
  name: string;
  description?: string | null;
  images: MoodboardImage[];
  tags?: string[];
  isDefault?: boolean;
  /** Absent = "moodboard" (pre-kind boards). */
  kind?: MoodboardKind;
  trainingRuns?: MoodboardTrainingRun[];
  /** Dataset caption knobs (trigger word, dropout, shuffle) the train route
   *  threads into the trainer params + dataset manifest. */
  captionSettings?: MoodboardCaptionSettings;
  createdAt?: string | number;
  updatedAt?: string | number;
  /** Structured style guidance (from Krea/Andro.Meta moodboard catalog). Optional,
   *  additive — a positive prompt fragment, a negative fragment, and style axes. */
  promptGuidance?: string;
  negativeGuidance?: string;
  styleAxes?: string[];
}

// SREF (Style Reference) Types

export interface SREFItem {
  value: string; // URL or numeric code
  type: "url" | "code" | "random";
  weight: number; // Per-item weight (default 1.0)
  resolved?: string; // For "random", stores resolved code
}

export interface SREFParams {
  items: SREFItem[];
  styleWeight: number; // Global SW value (0-1000)
  styleVersion?: number; // --sv parameter (1-5)
}

export interface LoRAParseItem {
  name: string; // Shortcode or filename
  strength: number; // Model strength
  clipStrength?: number; // CLIP strength (defaults to strength)
  isRandom?: boolean; // Was this from --lora random
  triggers?: string[]; // Auto-loaded triggers
}

export interface LoRAParseParams {
  items: LoRAParseItem[];
  autoTrigger: boolean;
  triggerPosition: "beginning" | "middle" | "end";
}

export interface ExtendedParseResult {
  prompt: string;
  sref: SREFParams | null;
  lora: LoRAParseParams | null;
  otherParams: Record<string, unknown>;
  errors: string[];
  warnings: string[];
}

export interface StyleCodeEntry {
  code: string;
  name?: string;
  tags?: string[];
  thumbnailUrl?: string;
  createdAt: number;
  useCount: number;
  isFavorite: boolean;
  metadata?: Record<string, unknown>;
}

export interface LoRAShortcodeEntry {
  shortcode: string;
  filename: string;
  displayName?: string;
  tags?: string[];
  triggers?: string[];
  defaultStrength: number;
  curatedSet?: string;
  useCount: number;
  isFavorite: boolean;
  metadata?: Record<string, unknown>;
}
