/**
 * Style API Client
 * Frontend utilities for interacting with style management APIs.
 *
 * Handles:
 * - Style code CRUD operations
 * - LoRA shortcode management
 * - Library export/import
 * - Preview generation
 */

// Types

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

export interface StyleCodesListResponse {
  ok: boolean;
  codes: StyleCodeEntry[];
  total: number;
  limit: number;
  offset: number;
  error?: string;
}

export interface LoRAsListResponse {
  ok: boolean;
  loras: LoRAShortcodeEntry[];
  curatedSets: string[];
  total: number;
  limit: number;
  offset: number;
  error?: string;
}

export interface ImportResult {
  ok: boolean;
  imported: {
    styleCodes: number;
    loraShortcodes: number;
  };
  skipped: {
    styleCodes: number;
    loraShortcodes: number;
  };
  errors: string[];
}

export interface PreviewJob {
  id: string;
  code: string;
  status: "queued" | "processing" | "done" | "error";
  prompt: string;
  createdAt: number;
  previewUrl?: string;
  error?: string;
}

export type TrainingBackendName = "musubi-tuner" | "ai-toolkit";
export type TrainingJobStatus = "queued" | "running" | "done" | "error";

export interface TrainingBackend {
  name: TrainingBackendName;
  installed: boolean;
  version?: string | null;
  model_families: string[];
}

export interface TrainingDataset {
  images_dir?: string;
  cluster_id?: number;
  caption_ext?: string;
}

/** Model families the moodboard LoRA trainer can target. */
export const TRAINING_MODEL_FAMILIES = ["krea2", "moss_image"] as const;
export type TrainingModelFamily = (typeof TRAINING_MODEL_FAMILIES)[number];

export interface StartTrainingJobRequest {
  backend: TrainingBackendName;
  model_family: TrainingModelFamily;
  run_name: string;
  dataset: TrainingDataset;
  params: {
    steps?: number;
    lr?: string;
    lr_warmup_steps?: string | number;
    rank?: number;
    resolution?: number;
    trigger_word?: string;
    blocks_to_swap?: number;
    exclude_shared?: boolean;
    divergence_loss_threshold?: number;
    auto_caption?: boolean;
  };
}

export interface TrainingJobStartResponse {
  job_id: string;
  status: TrainingJobStatus;
}

export interface TrainingJobSummary {
  job_id: string;
  backend: TrainingBackendName;
  model_family: "krea2" | string;
  status: TrainingJobStatus;
  created_at: string;
}

export interface TrainingJobDetail extends TrainingJobSummary {
  progress?: number;
  step?: number;
  total_steps?: number;
  log_tail?: string;
  output_lora_path?: string | null;
  last_loss?: number | null;
  last_pred_std?: number | null;
  loss_history?: number[];
  max_loss?: number | null;
  diverged?: boolean;
}

export interface TrainingDeployResult {
  deployed_path: string;
  lora_name: string;
}

export interface AutosortMoodboardsRequest {
  dir: string;
  minClusterSize?: number;
  model?: string;
  namePrefix?: string;
  kind?: "moodboard" | "character" | "style";
}

export interface AutosortMoodboardsResponse {
  ok: boolean;
  created: number;
  moodboards: { id: string; name: string; imageCount: number }[];
  skipped: number;
  noise: number;
  error?: string;
}

export interface TrainMoodboardRequest {
  trigger_word: string;
  steps?: number;
  lr?: number;
  rank?: number;
  resolution?: number;
  blocks_to_swap?: number;
  exclude_shared?: boolean;
  auto_caption?: boolean;
  /** Caption sidecar format: "txt" (kohya/musubi/ai-toolkit default) or "caption". */
  caption_ext?: "txt" | "caption";
  /** LoRA version (v2/v3/...); omitted = server picks the next one. */
  version?: number;
}

export interface TrainMoodboardResponse extends TrainingJobStartResponse {
  materialized: number;
  /** Board images that could not be read into the dataset. */
  skipped?: number;
  /** Set when a large share of the board was skipped (training still runs). */
  warning?: string;
  /** How many manual caption sidecars were written alongside the images. */
  captioned: number;
  run_name: string;
  version: number;
}

export interface CaptionMoodboardRequest {
  only_missing?: boolean;
  indices?: number[];
  model?: string;
  prompt?: string;
}

export interface CaptionMoodboardResponse {
  ok: boolean;
  captioned: number;
  failed: number;
  images?: {
    url: string;
    weight: number;
    prompt?: string;
    caption?: string;
    captionSource?: string;
  }[];
  error?: string;
}

export interface MoodboardTrainingRunRecord {
  jobId: string;
  runName: string;
  version: number;
  triggerWord: string;
  startedAt: string;
  status?: string;
  outputLoraPath?: string | null;
}

export interface MoodboardTrainingRunsResponse {
  ok: boolean;
  runs: MoodboardTrainingRunRecord[];
  nextVersion: number;
}

export interface SvSrefGroup {
  sref: string;
  tag: string;
  count: number;
}

export interface ImportSvTagResponse {
  ok: boolean;
  moodboard?: { id: string; name: string };
  imported?: number;
  libraryCount?: number;
  error?: string;
}

// Style Codes API

/**
 * List style codes with optional filtering
 */
export async function listStyleCodes(
  options: {
    tag?: string;
    favorite?: boolean;
    search?: string;
    limit?: number;
    offset?: number;
    sort?: "useCount" | "createdAt" | "name";
    order?: "asc" | "desc";
  } = {},
): Promise<StyleCodesListResponse> {
  const params = new URLSearchParams();

  if (options.tag) params.set("tag", options.tag);
  if (options.favorite !== undefined)
    params.set("favorite", String(options.favorite));
  if (options.search) params.set("search", options.search);
  if (options.limit) params.set("limit", String(options.limit));
  if (options.offset) params.set("offset", String(options.offset));
  if (options.sort) params.set("sort", options.sort);
  if (options.order) params.set("order", options.order);

  const response = await fetch(`/api/style/codes?${params.toString()}`);
  return response.json();
}

export async function saveStyleCode(entry: {
  code: string;
  name?: string;
  tags?: string[];
  thumbnailUrl?: string;
  isFavorite?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<{
  ok: boolean;
  code?: StyleCodeEntry;
  created?: boolean;
  error?: string;
}> {
  const response = await fetch("/api/style/codes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });
  return response.json();
}

export async function deleteStyleCode(
  code: string,
): Promise<{ ok: boolean; deleted?: string; error?: string }> {
  const response = await fetch(
    `/api/style/codes?code=${encodeURIComponent(code)}`,
    {
      method: "DELETE",
    },
  );
  return response.json();
}

// LoRA Shortcodes API

/**
 * List LoRA shortcodes with optional filtering
 */
export async function listLoRAs(
  options: {
    set?: string;
    favorite?: boolean;
    search?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<LoRAsListResponse> {
  const params = new URLSearchParams();

  if (options.set) params.set("set", options.set);
  if (options.favorite !== undefined)
    params.set("favorite", String(options.favorite));
  if (options.search) params.set("search", options.search);
  if (options.limit) params.set("limit", String(options.limit));
  if (options.offset) params.set("offset", String(options.offset));

  const response = await fetch(`/api/style/loras?${params.toString()}`);
  return response.json();
}

/**
 * Get a random LoRA from a curated set
 */
export async function getRandomLoRA(set?: string): Promise<{
  ok: boolean;
  lora?: LoRAShortcodeEntry;
  random?: boolean;
  error?: string;
}> {
  const params = new URLSearchParams({ random: "true" });
  if (set) params.set("set", set);

  const response = await fetch(`/api/style/loras?${params.toString()}`);
  return response.json();
}

export async function saveLoRAShortcode(entry: {
  shortcode: string;
  filename: string;
  displayName?: string;
  tags?: string[];
  triggers?: string[];
  defaultStrength?: number;
  curatedSet?: string;
  isFavorite?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<{
  ok: boolean;
  lora?: LoRAShortcodeEntry;
  created?: boolean;
  error?: string;
}> {
  const response = await fetch("/api/style/loras", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });
  return response.json();
}

export async function deleteLoRAShortcode(
  shortcode: string,
): Promise<{ ok: boolean; deleted?: string; error?: string }> {
  const response = await fetch(
    `/api/style/loras?shortcode=${encodeURIComponent(shortcode)}`,
    {
      method: "DELETE",
    },
  );
  return response.json();
}

/**
 * Update LoRA usage count or favorite status
 */
export async function updateLoRAShortcode(
  shortcode: string,
  update: { incrementUse?: boolean; isFavorite?: boolean },
): Promise<{ ok: boolean; lora?: LoRAShortcodeEntry; error?: string }> {
  const response = await fetch("/api/style/loras", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shortcode, ...update }),
  });
  return response.json();
}

// Export/Import API

export async function exportStyleLibrary(
  options: {
    type?: "all" | "codes" | "loras";
    favorites?: boolean;
    tag?: string;
    set?: string;
    format?: "json" | "compact";
  } = {},
): Promise<Blob> {
  const params = new URLSearchParams();

  if (options.type) params.set("type", options.type);
  if (options.favorites) params.set("favorites", "true");
  if (options.tag) params.set("tag", options.tag);
  if (options.set) params.set("set", options.set);
  if (options.format) params.set("format", options.format);

  const response = await fetch(`/api/style/export?${params.toString()}`);
  return response.blob();
}

export async function downloadStyleLibraryExport(
  options: Parameters<typeof exportStyleLibrary>[0] = {},
): Promise<void> {
  const blob = await exportStyleLibrary(options);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `style-library-${new Date().toISOString().split("T")[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function importStyleLibrary(
  data: unknown,
  options: {
    mode?: "merge" | "replace";
    skipDuplicates?: boolean;
  } = {},
): Promise<ImportResult> {
  const params = new URLSearchParams();
  if (options.mode) params.set("mode", options.mode);
  if (options.skipDuplicates !== undefined)
    params.set("skipDuplicates", String(options.skipDuplicates));

  const response = await fetch(`/api/style/import?${params.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return response.json();
}

export async function importStyleLibraryFromFile(
  file: File,
  options: Parameters<typeof importStyleLibrary>[1] = {},
): Promise<ImportResult> {
  const text = await file.text();
  const data = JSON.parse(text);
  return importStyleLibrary(data, options);
}

// Preview API

/**
 * Check if a style code has a cached preview
 */
export async function getStylePreview(code: string): Promise<{
  ok: boolean;
  code: string;
  hasPreview: boolean;
  preview?: { url: string; generatedAt: number; prompt: string };
  pending?: PreviewJob;
  error?: string;
}> {
  const response = await fetch(
    `/api/style/preview?code=${encodeURIComponent(code)}`,
  );
  return response.json();
}

export async function requestStylePreview(options: {
  code: string;
  prompt?: string;
  size?: number;
  force?: boolean;
}): Promise<{
  ok: boolean;
  cached?: boolean;
  queued?: boolean;
  pending?: boolean;
  job?: PreviewJob;
  preview?: { url: string; generatedAt: number; prompt: string };
  error?: string;
}> {
  const response = await fetch("/api/style/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  return response.json();
}

export async function checkPreviewJob(jobId: string): Promise<{
  ok: boolean;
  job?: PreviewJob;
  preview?: { url: string; generatedAt: number; prompt: string };
  error?: string;
}> {
  const response = await fetch(
    `/api/style/preview?jobId=${encodeURIComponent(jobId)}`,
  );
  return response.json();
}

// StyleVault Training API

async function vaultJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/vault/${path}`, init);
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function listTrainingBackends(): Promise<TrainingBackend[]> {
  const data = await vaultJson<{ backends: TrainingBackend[] }>(
    "training/backends",
  );
  return data.backends;
}

export async function startTrainingJob(
  request: StartTrainingJobRequest,
): Promise<TrainingJobStartResponse> {
  return vaultJson<TrainingJobStartResponse>("training/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
}

export async function listTrainingJobs(): Promise<TrainingJobSummary[]> {
  return vaultJson<TrainingJobSummary[]>("training/jobs");
}

export async function getTrainingJob(
  jobId: string,
): Promise<TrainingJobDetail> {
  return vaultJson<TrainingJobDetail>(
    `training/jobs/${encodeURIComponent(jobId)}`,
  );
}

export async function cancelTrainingJob(
  jobId: string,
): Promise<{ ok: boolean }> {
  return vaultJson<{ ok: boolean }>(
    `training/jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST" },
  );
}

export async function deployTrainingJob(
  jobId: string,
  body: { lora_dir?: string; name?: string } = {},
): Promise<TrainingDeployResult> {
  return vaultJson<TrainingDeployResult>(
    `training/jobs/${encodeURIComponent(jobId)}/deploy`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export async function listSvSrefGroups(minCount = 4): Promise<SvSrefGroup[]> {
  const groups = await vaultJson<unknown>(`library/srefs?min_count=${minCount}`);
  return Array.isArray(groups) ? (groups as SvSrefGroup[]) : [];
}

export async function importSvTag(request: {
  tag: string;
  name?: string;
  kind?: "moodboard" | "character" | "style";
}): Promise<ImportSvTagResponse> {
  const response = await fetch("/api/moodboards/import-sv", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  return response.json();
}

export async function captionMoodboard(
  id: string,
  request: CaptionMoodboardRequest = {},
): Promise<CaptionMoodboardResponse> {
  const response = await fetch(
    `/api/moodboards/${encodeURIComponent(id)}/caption`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
  );
  return response.json();
}

export async function getMoodboardTrainingRuns(
  id: string,
): Promise<MoodboardTrainingRunsResponse> {
  const response = await fetch(
    `/api/moodboards/${encodeURIComponent(id)}/train`,
  );
  return response.json();
}

export async function autosortMoodboards(
  request: AutosortMoodboardsRequest,
): Promise<AutosortMoodboardsResponse> {
  const response = await fetch("/api/moodboards/autosort", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  return response.json();
}

export async function trainMoodboard(
  id: string,
  request: TrainMoodboardRequest,
): Promise<TrainMoodboardResponse> {
  const response = await fetch(
    `/api/moodboards/${encodeURIComponent(id)}/train`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
  );
  return response.json();
}

// Utilities

/**
 * Generate a random style code (client-side)
 */
export function generateRandomStyleCode(): string {
  const min = 1000000000;
  const max = 9999999999;
  return String(Math.floor(Math.random() * (max - min + 1)) + min);
}

export function isValidStyleCode(code: string): boolean {
  return /^\d{6,12}$/.test(code);
}

/**
 * Parse style code from various formats
 */
export function parseStyleCodeInput(input: string): string | null {
  const cleaned = input.trim();

  // Direct numeric code
  if (isValidStyleCode(cleaned)) {
    return cleaned;
  }

  // Extract from URL if present (e.g., from shared link)
  const urlMatch = cleaned.match(/sref[=:](\d{6,12})/i);
  if (urlMatch) {
    return urlMatch[1];
  }

  // Extract from prompt string
  const promptMatch = cleaned.match(/--sref\s+(\d{6,12})/);
  if (promptMatch) {
    return promptMatch[1];
  }

  return null;
}

export default {
  // Style codes
  listStyleCodes,
  saveStyleCode,
  deleteStyleCode,

  // LoRAs
  listLoRAs,
  getRandomLoRA,
  saveLoRAShortcode,
  deleteLoRAShortcode,
  updateLoRAShortcode,

  // Export/Import
  exportStyleLibrary,
  downloadStyleLibraryExport,
  importStyleLibrary,
  importStyleLibraryFromFile,

  // Preview
  getStylePreview,
  requestStylePreview,
  checkPreviewJob,

  // Training
  listTrainingBackends,
  startTrainingJob,
  listTrainingJobs,
  getTrainingJob,
  cancelTrainingJob,
  deployTrainingJob,
  autosortMoodboards,
  trainMoodboard,
  getMoodboardTrainingRuns,
  captionMoodboard,
  listSvSrefGroups,
  importSvTag,

  // Utilities
  generateRandomStyleCode,
  isValidStyleCode,
  parseStyleCodeInput,
};
