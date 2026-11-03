/**
 * Stable Audio 3 setup helpers: the starter pack that installs the SA3 Medium
 * tools (src/lib/onboarding/starterPacks.json, id "audio-sa3"), the command
 * that fetches it, and the Fast / Quality gate (Quality needs the optional
 * base checkpoint). Client-safe: no fs, no pack JSON import.
 */
import { SA3_MEDIUM_BASE_CKPT, type Sa3Speed } from "@/lib/oj/sa3Params";

export const SA3_PACK_ID = "audio-sa3";
/** Where the Quality checkpoint lands under ComfyUI/models. */
export const SA3_QUALITY_DEST = `checkpoints/${SA3_MEDIUM_BASE_CKPT}`;
/** Same placeholder the setup wizard uses (starterPacks.COMFY_DIR_PLACEHOLDER). */
export const SA3_COMFY_PLACEHOLDER = "/path/to/ComfyUI";

export const SA3_QUALITY_MISSING_HINT =
  "Install the Quality model to use this.";

/**
 * `node scripts/fetch-models.mjs --pack audio-sa3 ...` run from the Adrift
 * folder. `quality` adds the optional Quality checkpoint (`--use`).
 */
export function sa3PackCommand(
  opts: { quality?: boolean; comfyDir?: string } = {},
): string {
  const dir = opts.comfyDir ?? SA3_COMFY_PLACEHOLDER;
  const quoted = /^[\w@%+=:,./-]+$/.test(dir)
    ? dir
    : `'${dir.replace(/'/g, `'\\''`)}'`;
  return [
    "node scripts/fetch-models.mjs",
    `--pack ${SA3_PACK_ID}`,
    ...(opts.quality ? [`--use ${SA3_QUALITY_DEST}`] : []),
    `--comfy ${quoted}`,
    "--yes",
  ].join(" ");
}

export interface Sa3SpeedOption {
  id: Sa3Speed;
  label: string;
  disabled?: boolean;
}

/** Fast / Quality choices; Quality is disabled until its model is installed. */
export function sa3SpeedOptions(qualityInstalled: boolean): Sa3SpeedOption[] {
  return [
    { id: "fast", label: "Fast" },
    {
      id: "quality",
      label: "Best quality (slower)",
      ...(qualityInstalled ? {} : { disabled: true }),
    },
  ];
}

/** The speed a run can actually use: Quality falls back to Fast without its model. */
export function sa3EffectiveSpeed(
  pick: string | undefined,
  qualityInstalled: boolean,
): Sa3Speed {
  return pick === "quality" && qualityInstalled ? "quality" : "fast";
}

/** Download size of the pack's required files (Medium + text encoder). */
export const SA3_PACK_BYTES = 9222116660 + 1187264003;

/**
 * A tool block reason that the SA3 pack fixes ("Model not installed:
 * stable_audio_3_medium.safetensors, ..."), as opposed to ComfyUI being
 * offline or a missing node pack.
 */
export function sa3PackFixes(reason: string | null | undefined): boolean {
  return (
    !!reason &&
    /^Model not installed:/.test(reason.trim()) &&
    /stable_audio_3_medium|t5gemma_b_b_ul2/i.test(reason)
  );
}
