/**
 * Civitai API Client
 * Fetches images, prompts, and model info from Civitai API.
 * Tiered TTL cache with stale-while-revalidate, reactive 429 handling.
 */

import { getCivitaiApiKey } from "@/lib/civitaiConfig";

const CIVITAI_SFW_BASE =
  process.env.CIVITAI_API_URL ?? "https://civitai.com/api/v1";
const CIVITAI_NSFW_BASE =
  process.env.CIVITAI_NSFW_API_URL ?? "https://civitai.red/api/v1";

export type CivitaiSource = "com" | "red";

export function sourceFromNsfw(nsfw?: boolean): CivitaiSource {
  return nsfw ? "red" : "com";
}

export function getCivitaiApiBaseUrl(source: CivitaiSource): string {
  return source === "red" ? CIVITAI_NSFW_BASE : CIVITAI_SFW_BASE;
}

// Types

export interface CivitaiImage {
  id: number;
  url: string;
  thumbnailUrl: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  createdAt: string;
  models: Array<{ name: string; type: string }>;
  tags: string[];
  /** Civitai media type — "video" items carry .mp4 urls */
  type?: "image" | "video";
  /** Creator handle, when the API returns one. */
  username?: string;
  /** Civitai rating: images endpoint returns nsfw + a string nsfwLevel. */
  nsfw?: boolean;
  nsfwLevel?: number | string;
  stats?: {
    likeCount?: number;
    heartCount?: number;
    laughCount?: number;
    cryCount?: number;
    commentCount?: number;
  };
}

export interface CivitaiSearchOptions {
  query?: string;
  limit?: number;
  cursor?: string;
  modelType?: string;
  sort?: string;
  nsfw?: boolean;
  source?: CivitaiSource;
  modelId?: number;
  modelVersionId?: number;
  period?: string;
  baseModels?: string;
  withMeta?: boolean;
  requiringMeta?: boolean;
  username?: string;
  /** Civitai media type filter — videos return .mp4 urls */
  type?: "image" | "video";
}

export interface CivitaiResponse {
  items: CivitaiImage[];
  nextCursor?: string;
  metadata?: {
    total: number;
    cachedAt: number;
  };
}

export interface CivitaiModelVersion {
  id: number;
  name: string;
  modelId: number;
  downloadUrl: string;
  trainedWords?: string[];
  baseModel?: string;
  files: Array<{
    /** Civitai file id */
    id?: number;
    name: string;
    sizeKB: number;
    downloadUrl: string;
    hashes?: { SHA256?: string };
    primary?: boolean;
    /** "Model" | "Pruned Model" | "VAE" | "Config" | "Training Data" | "Archive" | … */
    type?: string;
    metadata?: { format?: string; size?: string; fp?: string };
  }>;
  /** nsfwLevel is Civitai's numeric rating bitmask (4 = R and up). */
  images: Array<{ url: string; nsfwLevel?: number | string; nsfw?: boolean }>;
  /** Present on /model-versions/{id}; the type here is what the server trusts. */
  model?: { name?: string; type?: string; nsfw?: boolean; poi?: boolean };
}

export interface CivitaiModel {
  id: number;
  name: string;
  type: string;
  description?: string;
  tags?: string[];
  stats?: {
    downloadCount: number;
    /** Civitai dropped favoriteCount; thumbsUpCount is the live "likes" stat. */
    thumbsUpCount?: number;
    favoriteCount?: number;
    rating?: number;
  };
  modelVersions?: CivitaiModelVersion[];
  /** Civitai's model-level mature flag (raw API passthrough). */
  nsfw?: boolean;
}

export interface CivitaiModelSearchOptions {
  query?: string;
  /** Sent repeated (`types=A&types=B`) — Civitai rejects comma lists */
  types?: string | string[];
  sort?: string;
  period?: string;
  limit?: number;
  page?: number;
  /** Cursor pagination (required when `query` is set — page is rejected) */
  cursor?: string;
  baseModels?: string | string[];
  checkpointType?: string;
  username?: string;
  nsfw?: boolean;
  source?: CivitaiSource;
  primaryFileOnly?: boolean;
  tag?: string;
}

export interface CivitaiModelResponse {
  items: CivitaiModel[];
  metadata: {
    totalItems: number;
    currentPage: number;
    pageSize: number;
    totalPages: number;
  } | null;
  nextCursor?: string;
}

export interface CivitaiVersionByHash {
  id: number;
  modelId: number;
  name: string;
  trainedWords: string[];
  baseModel?: string;
  files: Array<{
    name: string;
    primary: boolean;
    hashes: { SHA256?: string };
  }>;
  model?: {
    name: string;
    type: string;
  };
}

// Tiered TTL Cache with Stale-While-Revalidate

enum CacheTTL {
  SHORT = 3 * 60_000, // 3min — image search, volatile
  MEDIUM = 10 * 60_000, // 10min — stats, model search
  LONG = 30 * 60_000, // 30min — model metadata
  IMMUTABLE = 60 * 60_000, // 1hr — hash lookups (immutable once published)
}

interface CacheEntry<T> {
  data: T;
  expires: number;
  staleUntil: number;
  refreshing?: boolean;
}

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): { data: T; stale: boolean } | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;

  const now = Date.now();
  if (now > entry.staleUntil) {
    cache.delete(key);
    return null;
  }
  return { data: entry.data, stale: now > entry.expires };
}

function setCache<T>(key: string, data: T, ttl: CacheTTL): void {
  cache.set(key, {
    data,
    expires: Date.now() + ttl,
    staleUntil: Date.now() + ttl * 2,
  });
}

function markRefreshing(key: string): boolean {
  const entry = cache.get(key);
  if (!entry || entry.refreshing) return false;
  entry.refreshing = true;
  return true;
}

function clearRefreshing(key: string): void {
  const entry = cache.get(key);
  if (entry) entry.refreshing = false;
}

export function clearCivitaiCache(): void {
  cache.clear();
}

// Rate Limiting: Reactive 429 Handling

const MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 15_000;

async function civitaiHeaders(
  contentType = false,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "User-Agent": "Adrift/1.0",
  };
  if (contentType) headers["Content-Type"] = "application/json";
  const apiKey = await getCivitaiApiKey();
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

async function civitaiFetch(
  path: string,
  params?: Record<string, string | string[]>,
  options: {
    nsfw?: boolean;
    source?: CivitaiSource;
    timeout?: number;
    method?: string;
    body?: string;
  } = {},
): Promise<Response> {
  const source = options.source ?? sourceFromNsfw(options.nsfw);
  const url = new URL(`${getCivitaiApiBaseUrl(source)}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, item);
      } else {
        url.searchParams.set(k, v);
      }
    }
  }

  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const headers = await civitaiHeaders(!!options.body);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url.toString(), {
      method: options.method ?? "GET",
      headers,
      body: options.body,
      signal: AbortSignal.timeout(timeout),
    });

    if (response.status === 429) {
      if (attempt === MAX_RETRIES) return response;
      const retryAfter = response.headers.get("Retry-After");
      let delayMs: number;
      if (retryAfter) {
        // Retry-After may be an integer (seconds) or an HTTP date string.
        const asSeconds = Number(retryAfter);
        if (Number.isFinite(asSeconds) && asSeconds > 0) {
          // Integer seconds form
          delayMs = asSeconds * 1000;
        } else {
          // HTTP date form — compute delta from now
          const ts = Date.parse(retryAfter);
          delayMs = Number.isFinite(ts) ? ts - Date.now() : 2_000;
        }
        delayMs = Math.max(1_000, Math.min(delayMs, 60_000));
      } else {
        delayMs = Math.min(1000 * 2 ** attempt, 30_000);
      }
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    if (response.status >= 500 && attempt < MAX_RETRIES) {
      const delayMs = Math.min(1000 * 2 ** attempt, 30_000);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    return response;
  }

  throw new Error(`Civitai API exhausted retries for ${path}`);
}

// SWR background refresh helper

function swrRefresh<T>(
  cacheKey: string,
  ttl: CacheTTL,
  fetcher: () => Promise<T>,
): void {
  if (!markRefreshing(cacheKey)) return;
  fetcher()
    .then((data) => setCache(cacheKey, data, ttl))
    .catch(() => {})
    .finally(() => clearRefreshing(cacheKey));
}

// Image Search

export async function searchCivitaiImages(
  opts: CivitaiSearchOptions = {},
): Promise<CivitaiResponse> {
  const key = `img:${JSON.stringify(opts)}`;
  const cached = getCached<CivitaiResponse>(key);
  if (cached && !cached.stale) return cached.data;

  const fetcher = async (): Promise<CivitaiResponse> => {
    const params: Record<string, string> = {
      limit: String(opts.limit ?? 20),
      withMeta: String(opts.withMeta ?? true),
    };
    if (opts.query) params["query"] = opts.query;
    if (opts.cursor) params["cursor"] = opts.cursor;
    if (opts.modelType) params["modelType"] = opts.modelType;
    if (opts.sort) params["sort"] = opts.sort;
    if (opts.nsfw != null) params["nsfw"] = String(opts.nsfw);
    if (opts.modelId != null) params["modelId"] = String(opts.modelId);
    if (opts.modelVersionId != null)
      params["modelVersionId"] = String(opts.modelVersionId);
    if (opts.period) params["period"] = opts.period;
    if (opts.baseModels) params["baseModels"] = opts.baseModels;
    if (opts.username) params["username"] = opts.username;
    if (opts.requiringMeta) params["requiringMeta"] = "true";
    if (opts.type) params["type"] = opts.type;

    const response = await civitaiFetch("/images", params, {
      nsfw: opts.nsfw,
      source: opts.source,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Civitai API error ${response.status}: ${text}`);
    }

    const json = (await response.json()) as {
      items: Array<{
        id: number;
        url: string;
        thumbnailUrl?: string;
        hash?: string;
        width: number;
        height: number;
        createdAt: string;
        postId?: number;
        username?: string;
        type?: string;
        nsfw?: boolean;
        nsfwLevel?: number | string;
        meta?: {
          prompt?: string;
          negativePrompt?: string;
          Model?: string;
          [key: string]: unknown;
        };
        stats?: {
          likeCount?: number;
          heartCount?: number;
          laughCount?: number;
          cryCount?: number;
          commentCount?: number;
        };
      }>;
      metadata?: { nextCursor?: string; totalItems?: number; total?: number };
    };

    return {
      items: json.items.map((item) => ({
        id: item.id,
        url: item.url,
        thumbnailUrl: item.thumbnailUrl || item.url,
        prompt: item.meta?.prompt ?? "",
        negativePrompt: item.meta?.negativePrompt,
        width: item.width,
        height: item.height,
        createdAt: item.createdAt,
        models: item.meta?.Model
          ? [{ name: item.meta.Model, type: "Checkpoint" }]
          : [],
        tags: [],
        type: item.type === "video" ? ("video" as const) : undefined,
        username: item.username || undefined,
        nsfw: typeof item.nsfw === "boolean" ? item.nsfw : undefined,
        nsfwLevel: item.nsfwLevel ?? undefined,
        stats: item.stats,
      })),
      nextCursor: json.metadata?.nextCursor,
      metadata: {
        total: json.metadata?.total ?? json.items.length,
        cachedAt: Date.now(),
      },
    };
  };

  if (cached?.stale) {
    swrRefresh(key, CacheTTL.SHORT, fetcher);
    return cached.data;
  }

  const result = await fetcher();
  setCache(key, result, CacheTTL.SHORT);
  return result;
}

// Single Image

export async function fetchCivitaiImageById(
  id: number,
  nsfw?: boolean,
  source?: CivitaiSource,
): Promise<CivitaiImage | null> {
  try {
    const response = await civitaiFetch(
      "/images",
      { imageId: String(id) },
      { nsfw, source },
    );
    if (!response.ok) return null;
    const json = (await response.json()) as {
      items: Array<CivitaiImage & { url?: string; thumbnailUrl?: string }>;
    };
    const item = json.items?.[0];
    if (!item) return null;
    return {
      ...item,
      url: item.url ?? `https://image.civitai.com/${id}`,
      thumbnailUrl: item.thumbnailUrl ?? item.url,
    };
  } catch {
    return null;
  }
}

// Model Version by Hash (single)

export async function fetchCivitaiModelVersionByHash(
  hash: string,
  nsfw?: boolean,
  source?: CivitaiSource,
): Promise<CivitaiModelVersion | null> {
  const resolvedSource = source ?? sourceFromNsfw(nsfw);
  const key = `hash:${resolvedSource}:${hash}`;
  const cached = getCached<CivitaiModelVersion | null>(key);
  if (cached && !cached.stale) return cached.data;

  try {
    const response = await civitaiFetch(
      `/model-versions/by-hash/${hash}`,
      undefined,
      { nsfw, source: resolvedSource },
    );
    if (!response.ok) {
      setCache(key, null, CacheTTL.MEDIUM);
      return null;
    }
    const data = (await response.json()) as CivitaiModelVersion;
    setCache(key, data, CacheTTL.IMMUTABLE);
    return data;
  } catch {
    return null;
  }
}

// Batch Hash Lookup

export async function batchLookupByHash(
  hashes: string[],
  nsfw?: boolean,
  source?: CivitaiSource,
): Promise<Map<string, CivitaiVersionByHash>> {
  const results = new Map<string, CivitaiVersionByHash>();
  if (hashes.length === 0) return results;
  const resolvedSource = source ?? sourceFromNsfw(nsfw);

  const uncached: string[] = [];
  for (const hash of hashes) {
    const key = `hash:${resolvedSource}:${hash}`;
    const cached = getCached<CivitaiVersionByHash | null>(key);
    if (cached && !cached.stale && cached.data) {
      results.set(hash, cached.data);
    } else {
      uncached.push(hash);
    }
  }

  if (uncached.length === 0) return results;

  const BATCH_SIZE = 100;
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    const batch = uncached.slice(i, i + BATCH_SIZE);

    try {
      const response = await civitaiFetch(
        "/model-versions/by-hash",
        undefined,
        {
          nsfw,
          source: resolvedSource,
          method: "POST",
          body: JSON.stringify(batch),
          timeout: 30_000,
        },
      );

      if (!response.ok) {
        // Fallback to serial for this batch
        for (const hash of batch) {
          const single = await fetchCivitaiModelVersionByHash(
            hash,
            nsfw,
            resolvedSource,
          );
          if (single) {
            results.set(hash, single as unknown as CivitaiVersionByHash);
          }
        }
        continue;
      }

      const items = (await response.json()) as CivitaiVersionByHash[];
      const matchedHashes = new Set<string>();

      for (const item of items) {
        const matchHash = batch.find((h) => {
          const fileHash = item.files?.find((f) => f.hashes?.SHA256)?.hashes
            ?.SHA256;
          return fileHash?.toUpperCase() === h.toUpperCase();
        });
        if (matchHash) {
          results.set(matchHash, item);
          setCache(
            `hash:${resolvedSource}:${matchHash}`,
            item,
            CacheTTL.IMMUTABLE,
          );
          matchedHashes.add(matchHash.toUpperCase());
        }
      }

      for (const hash of batch) {
        if (!matchedHashes.has(hash.toUpperCase())) {
          setCache(`hash:${resolvedSource}:${hash}`, null, CacheTTL.MEDIUM);
        }
      }
    } catch {
      // Fallback to serial on network error
      for (const hash of batch) {
        const single = await fetchCivitaiModelVersionByHash(
          hash,
          nsfw,
          resolvedSource,
        );
        if (single) {
          results.set(hash, single as unknown as CivitaiVersionByHash);
        }
      }
    }
  }

  return results;
}

// Model Version Details (for downloads)

export async function fetchCivitaiModelVersion(
  modelVersionId: number,
  nsfw?: boolean,
  source?: CivitaiSource,
): Promise<CivitaiModelVersion | null> {
  const resolvedSource = source ?? sourceFromNsfw(nsfw);
  const key = `mv:${resolvedSource}:${modelVersionId}`;
  const cached = getCached<CivitaiModelVersion>(key);
  if (cached && !cached.stale) return cached.data;

  const response = await civitaiFetch(
    `/model-versions/${modelVersionId}`,
    undefined,
    { nsfw, source: resolvedSource },
  );
  if (!response.ok) return null;
  const data = (await response.json()) as CivitaiModelVersion;
  setCache(key, data, CacheTTL.LONG);
  return data;
}

export async function getCivitaiDownloadUrl(
  modelVersionId: number,
  nsfw?: boolean,
  source?: CivitaiSource,
): Promise<string> {
  const version = await fetchCivitaiModelVersion(modelVersionId, nsfw, source);
  if (!version)
    throw new Error(`Civitai model version ${modelVersionId} not found`);
  return version.downloadUrl;
}

// Model

export async function fetchCivitaiModel(
  modelId: number,
  nsfw?: boolean,
  source?: CivitaiSource,
): Promise<CivitaiModel | null> {
  const resolvedSource = source ?? sourceFromNsfw(nsfw);
  const key = `model:${resolvedSource}:${modelId}`;
  const cached = getCached<CivitaiModel | null>(key);
  if (cached && !cached.stale) return cached.data;

  if (cached?.stale) {
    const fetcher = async () => {
      const resp = await civitaiFetch(`/models/${modelId}`, undefined, {
        nsfw,
        source: resolvedSource,
      });
      return resp.ok ? ((await resp.json()) as CivitaiModel) : null;
    };
    swrRefresh(key, CacheTTL.LONG, fetcher);
    return cached.data;
  }

  try {
    const response = await civitaiFetch(`/models/${modelId}`, undefined, {
      nsfw,
      source: resolvedSource,
    });
    if (!response.ok) {
      setCache(key, null, CacheTTL.MEDIUM);
      return null;
    }
    const data = (await response.json()) as CivitaiModel;
    setCache(key, data, CacheTTL.LONG);
    return data;
  } catch {
    return null;
  }
}

// Model Search

export async function searchCivitaiModels(
  opts: CivitaiModelSearchOptions = {},
): Promise<CivitaiModelResponse> {
  const key = `models:${JSON.stringify(opts)}`;
  const cached = getCached<CivitaiModelResponse>(key);
  if (cached && !cached.stale) return cached.data;

  const fetcher = async (): Promise<CivitaiModelResponse> => {
    const params: Record<string, string | string[]> = {};
    if (opts.query) params["query"] = opts.query;
    if (opts.types && opts.types.length > 0) params["types"] = opts.types;
    if (opts.sort) params["sort"] = opts.sort;
    if (opts.period) params["period"] = opts.period;
    if (opts.limit != null) params["limit"] = String(opts.limit);
    if (opts.cursor) params["cursor"] = opts.cursor;
    // Civitai rejects `page` alongside a text query (cursor-only there)
    else if (opts.page != null && !opts.query) params["page"] = String(opts.page);
    if (opts.baseModels && opts.baseModels.length > 0)
      params["baseModels"] = opts.baseModels;
    if (opts.checkpointType) params["checkpointType"] = opts.checkpointType;
    if (opts.username) params["username"] = opts.username;
    if (opts.nsfw != null) params["nsfw"] = String(opts.nsfw);
    if (opts.primaryFileOnly) params["primaryFileOnly"] = "true";
    if (opts.tag) params["tag"] = opts.tag;

    const response = await civitaiFetch("/models", params, {
      nsfw: opts.nsfw,
      source: opts.source,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Civitai API error ${response.status}: ${text}`);
    }

    const json = (await response.json()) as {
      items: CivitaiModel[];
      metadata?: {
        totalItems: number;
        currentPage: number;
        pageSize: number;
        totalPages: number;
        nextCursor?: string;
      };
    };
    const nextCursor = json.metadata?.nextCursor;
    return {
      items: json.items ?? [],
      metadata: json.metadata ?? null,
      ...(nextCursor ? { nextCursor: String(nextCursor) } : {}),
    };
  };

  if (cached?.stale) {
    swrRefresh(key, CacheTTL.MEDIUM, fetcher);
    return cached.data;
  }

  const result = await fetcher();
  setCache(key, result, CacheTTL.MEDIUM);
  return result;
}
