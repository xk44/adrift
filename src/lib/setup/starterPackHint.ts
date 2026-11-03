/**
 * The starter pack that installs Create's default engine, for the first-run
 * checklist when that engine's model is missing (Krea 2 by default). SDXL
 * keeps its single-file curl starter (firstRun.SDXL_STARTER).
 */
import { STARTER_PACK_FOR_ENGINE } from "@/lib/oj/defaultPack";
import {
  COMFY_DIR_PLACEHOLDER,
  STARTER_PACKS,
  slotOptions,
  type StarterPacksDoc,
} from "@/lib/onboarding/starterPacks";
import { shellQuote, type StarterPackHint } from "@/lib/setup/firstRun";

export function starterPackHint(
  enginePackId: string,
  comfyRoot?: string,
  doc: StarterPacksDoc = STARTER_PACKS,
): StarterPackHint | undefined {
  const id = STARTER_PACK_FOR_ENGINE[enginePackId];
  const pack = id ? doc.packs.find((p) => p.id === id) : undefined;
  if (!pack) return undefined;
  const sizeBytes = pack.files.reduce((sum, slot) => {
    const first = slotOptions(slot)[0];
    return sum + (first && !first.optional ? first.bytes : 0);
  }, 0);
  return {
    id: pack.id,
    title: pack.title,
    sizeBytes,
    command: [
      "node scripts/fetch-models.mjs",
      `--pack ${pack.id}`,
      `--comfy ${shellQuote(comfyRoot || COMFY_DIR_PLACEHOLDER)}`,
      "--yes",
    ].join(" "),
  };
}
