/**
 * Server-side: turn a download destination key into a real, contained
 * directory and a checked leaf name. Shared by the Civitai and Hugging Face
 * download routes.
 */
import path from "path";
import { env } from "@/lib/env";
import { wildcardRoot } from "@/lib/wildcardsFs";
import {
  type CivitaiDest,
  destExtensions,
  diskNameFor,
} from "@/lib/civitaiFolders";
import { resolveContainedDir, validateLeafName } from "@/lib/fs/safeDest";
import { comfyInputDir, comfyModelsPath } from "@/lib/paths/resolveDirs";

function baseFor(dest: CivitaiDest): { base: string; segments: string[] } {
  switch (dest) {
    case "poses":
      return { base: comfyInputDir(env.COMFY_ROOT), segments: ["poses"] };
    case "wildcards":
      return { base: wildcardRoot(), segments: [] };
    case "workflows":
      return {
        base: path.join(env.COMFY_ROOT, "user", "default", "workflows"),
        segments: [],
      };
    default: {
      // The model-type folder itself (models/loras, …) may be a link to
      // another drive, a common setup ComfyUI follows; anything below it
      // and the final file may not be.
      const [top, ...rest] = dest.split("/");
      return {
        base: comfyModelsPath(env.COMFY_ROOT, top),
        segments: rest,
      };
    }
  }
}

export interface ResolvedDest {
  dir: string;
  name: string;
  fullPath: string;
}

/** mkdir + realpath-contain the folder and validate the on-disk name. */
export async function resolveDownloadDest(
  dest: CivitaiDest,
  remoteName: string,
): Promise<ResolvedDest> {
  const name = validateLeafName(
    diskNameFor(dest, remoteName),
    destExtensions(dest),
  );
  const { base, segments } = baseFor(dest);
  const dir = await resolveContainedDir(base, segments);
  return { dir, name, fullPath: path.join(dir, name) };
}
