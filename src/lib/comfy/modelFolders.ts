/**
 * Read a ComfyUI model folder listing (GET /models/<folder>).
 *
 * Some folders have no core loader node to read options from (embeddings
 * are referenced inline as `embedding:name` in prompts), so object_info
 * alone leaves them empty. ComfyUI's /models/<folder> lists exactly what
 * folder_paths sees, including extra_model_paths.
 *
 * Server-side only.
 */
import { comfyFetch } from "@/lib/comfy/comfyFetch";

const FOLDER_RE = /^[a-z0-9_]{1,64}$/;

/** Parse a /models/<folder> body; anything but a string array is []. */
export function parseModelFolderListing(body: unknown): string[] {
  if (!Array.isArray(body)) return [];
  return body.filter((v): v is string => typeof v === "string");
}

/**
 * List a model folder. By default any failure reads as an empty folder; pass
 * `{ strict: true }` when "ComfyUI is unreachable" must not look like "the
 * folder is empty" (the call then throws instead).
 */
export async function listComfyModelFolder(
  folder: string,
  fetcher: typeof comfyFetch = comfyFetch,
  opts: { strict?: boolean } = {},
): Promise<string[]> {
  if (!FOLDER_RE.test(folder)) return [];
  try {
    const res = await fetcher(`/models/${folder}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`ComfyUI /models/${folder}: ${res.status}`);
    return parseModelFolderListing(await res.json());
  } catch (error) {
    if (opts.strict) throw error;
    return [];
  }
}
