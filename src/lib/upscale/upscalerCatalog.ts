/**
 * Curated knowledge about common upscaler weights: a human name, the factor,
 * a picker category and a few character tags, matched by file stem so any
 * extension / training-step suffix works ("4x_NickelbackFS_72000_G.pth").
 * Unknown files are classified from their name (see describeUpscaler).
 *
 * DEFAULT_CHAINS is the "content type → model" table the user's preference
 * falls back to: the first installed entry wins. Pure (client and server).
 */

export type UpscaleContent = "photo" | "illustration" | "video";
export const UPSCALE_CONTENTS: readonly UpscaleContent[] = [
  "photo",
  "illustration",
  "video",
];

export type UpscalerCategory =
  "cleanup" | "2x" | "photo" | "illustration" | "faces";

export const UPSCALER_CATEGORIES: readonly {
  id: UpscalerCategory;
  label: string;
}[] = [
  { id: "photo", label: "4× photo & general" },
  { id: "illustration", label: "4× illustration & anime" },
  { id: "2x", label: "2×" },
  { id: "cleanup", label: "1× cleanup" },
  { id: "faces", label: "Faces" },
];

export type UpscalerTag =
  "sharp" | "natural" | "smooth" | "denoise" | "anime" | "painterly" | "slow";

interface CatalogEntry {
  name: string;
  scale: number;
  category: UpscalerCategory;
  tags: UpscalerTag[];
}

const e = (
  name: string,
  scale: number,
  category: UpscalerCategory,
  ...tags: UpscalerTag[]
): CatalogEntry => ({ name, scale, category, tags });

/** Keyed by lower-case stem without extension or "_<steps>_G" suffix. */
const CATALOG: Record<string, CatalogEntry> = {
  "1x-kim2091-dejpeg-v0": e("DeJPEG", 1, "cleanup", "denoise"),
  "1x_gainresv3_aggro": e("GainRES Aggressive", 1, "cleanup", "denoise"),
  "1x_gainresv3_natural": e("GainRES Natural", 1, "cleanup", "natural"),
  "1x_gainresv3_passive": e("GainRES Passive", 1, "cleanup", "natural"),
  "1x_gainresv4_128": e("GainRES v4", 1, "cleanup", "denoise"),
  "1x_ssantialias9x": e("Anti-alias", 1, "cleanup", "smooth"),
  "1xdeh264_realplksr": e("DeH264", 1, "cleanup", "denoise"),
  "1xdejpg_realplksr_otf": e("DeJPG RealPLKSR", 1, "cleanup", "denoise"),
  x1_itf_skindiffdetail_lite_v1: e("Skin detail", 1, "cleanup", "natural"),
  "2xsudo_shuffle_cugan": e("Sudo CUGAN", 2, "2x", "anime", "sharp"),
  "omnisr-helaman-hfa2k-2x": e("OmniSR", 2, "2x", "natural"),
  realesrgan_x2plus: e("Real-ESRGAN", 2, "2x", "smooth", "denoise"),
  "4x-ultrasharp": e("UltraSharp", 4, "photo", "sharp"),
  "esrgan-ultrasharp-4x": e("UltraSharp", 4, "photo", "sharp"),
  "4x-ultramix_balanced": e("UltraMix Balanced", 4, "photo", "natural"),
  "4x-ultramix_restore": e("UltraMix Restore", 4, "photo", "denoise"),
  "4x-ultramix_smooth": e("UltraMix Smooth", 4, "photo", "smooth"),
  "4x_nmkd-siax_200k": e("NMKD Siax", 4, "photo", "natural"),
  "4xlsdir": e("LSDIR", 4, "photo", "natural"),
  "4xlsdirplus": e("LSDIR+", 4, "photo", "natural"),
  "4xlsdirplusc": e("LSDIR+ compressed", 4, "photo", "denoise"),
  "4xlsdirplusn": e("LSDIR+ noisy", 4, "photo", "denoise"),
  "4xlsdirplusr": e("LSDIR+ real-world", 4, "photo", "denoise"),
  "4x_foolhardy_remacri": e("Remacri", 4, "photo", "natural"),
  "4x_universalupscalerv2-neutral": e(
    "Universal v2 Neutral",
    4,
    "photo",
    "natural",
  ),
  "4x_universalupscalerv2-sharp": e("Universal v2 Sharp", 4, "photo", "sharp"),
  "4x_universalupscalerv2-sharper": e(
    "Universal v2 Sharper",
    4,
    "photo",
    "sharp",
  ),
  "4x_valar_v1": e("Valar", 4, "photo", "natural"),
  "4x_nickelback": e("Nickelback", 4, "photo", "sharp"),
  "4x_nickelbackfs": e("Nickelback FS", 4, "photo", "natural"),
  "4x_kcjpunk_1.0": e("KCJPUNK", 4, "photo", "sharp"),
  "4xnomos2_hq_dat2": e("Nomos2 DAT2", 4, "photo", "natural"),
  "4xnomos2_hq_mosr": e("Nomos2 MoSR", 4, "photo", "natural"),
  "4xnomos2_realplksr_dysample": e("Nomos2 RealPLKSR", 4, "photo", "denoise"),
  "4xrealwebphoto_v4_drct-l": e("RealWebPhoto DRCT-L", 4, "photo", "denoise", "slow"),
  "drct-l_x4": e("DRCT-L", 4, "photo", "natural", "slow"),
  "dat-helaman-nomos-4x": e("Nomos DAT", 4, "photo", "natural", "slow"),
  "hat-helaman-nomos8kl-4x": e("Nomos8kL HAT", 4, "photo", "natural", "slow"),
  realesrgan_x4plus: e("Real-ESRGAN", 4, "photo", "smooth", "denoise"),
  esrgan_4x: e("ESRGAN (original)", 4, "photo", "sharp"),
  lollypop: e("Lollypop", 4, "photo", "sharp"),
  "4x_struzan": e("Struzan", 4, "illustration", "painterly"),
  "4x-volart": e("VolArt", 4, "illustration", "painterly"),
  "4x-volartnr": e("VolArt NR", 4, "illustration", "painterly", "denoise"),
  "4x_bs_deviancemip": e("DevianceMIP", 4, "illustration", "painterly"),
  "4x-animesharp": e("AnimeSharp", 4, "illustration", "anime", "sharp"),
  "4x_fatal_anime": e("Fatal Anime", 4, "illustration", "anime"),
  realesrgan_x4plus_anime_6b: e(
    "Real-ESRGAN Anime",
    4,
    "illustration",
    "anime",
    "smooth",
  ),
  "4xfaceupsharpdat": e("FaceUp Sharp DAT", 4, "faces", "sharp"),
  "8x_nmkd-faces": e("NMKD Faces", 8, "faces", "natural"),
};

/**
 * Content type → candidate stems, best first. Reasons:
 *   photo        4xNomos2 hq DAT2: best in a ground-truth shootout (5 AI renders, bicubic /4 -> x4, 8 models):
 *                mean Y-PSNR 30.15 vs UltraSharp 28.04, best edge placement, same speed, no halos or false
 *                grain; MoSR next (29.92); then UltraSharp (crisp), Siax (film-like grain), Remacri (softer),
 *                Real-ESRGAN = always-shipped baseline.
 *   illustration 4x-AnimeSharp: keeps line art and flat fills clean without smearing; Nomos2 DAT2 close
 *                behind (it edged AnimeSharp on the one illustration in the shootout, too thin to reorder);
 *                Real-ESRGAN anime 6B is the lighter smooth fallback; then the photo chain.
 *   video        Real-ESRGAN x4plus: smooth, degradation-trained output hallucinates little texture, so frames don't flicker; UltraMix Balanced is the sharper-but-stable second.
 */
export const DEFAULT_CHAINS: Record<UpscaleContent, readonly string[]> = {
  photo: [
    "4xnomos2_hq_dat2",
    "4xnomos2_hq_mosr",
    "4x-ultrasharp",
    "4x_nmkd-siax_200k",
    "4x_foolhardy_remacri",
    "realesrgan_x4plus",
  ],
  illustration: [
    "4x-animesharp",
    "4xnomos2_hq_dat2",
    "realesrgan_x4plus_anime_6b",
    "4x-ultrasharp",
    "4x_nmkd-siax_200k",
    "realesrgan_x4plus",
  ],
  video: ["realesrgan_x4plus", "4x-ultramix_balanced"],
};

const EXT_RE = /\.(pth|pt|safetensors|ckpt|bin)$/i;
const FACE_RE = /face|gfpgan|codeformer|restoreformer/i;
const ANIME_RE = /anime|manga|cugan|waifu|toon/i;

/** "sub/4x_Foo_72000_G.pth" → "4x_foo_72000_g". */
export function upscalerStem(file: string): string {
  const base = file.replace(/\\/g, "/").split("/").pop() ?? file;
  return base.replace(EXT_RE, "").toLowerCase();
}

function catalogEntry(file: string): CatalogEntry | undefined {
  const stem = upscalerStem(file);
  if (CATALOG[stem]) return CATALOG[stem];
  // Training-step suffixes: "4x_nickelbackfs_72000_g", "2xsudo_shuffle_cugan_9.584.969".
  let best: string | undefined;
  for (const key of Object.keys(CATALOG)) {
    if (stem.startsWith(`${key}_`) && (!best || key.length > best.length))
      best = key;
  }
  return best ? CATALOG[best] : undefined;
}

/** Does `file` match a catalog stem (exact or with a training suffix)? */
export function matchesStem(file: string, stem: string): boolean {
  const s = upscalerStem(file);
  return s === stem || s.startsWith(`${stem}_`);
}

export interface UpscalerInfo {
  name: string;
  scale: number | null;
  category: UpscalerCategory;
  tags: UpscalerTag[];
}

/** Name, factor, category and tags for any upscaler file. */
export function describeUpscaler(
  file: string,
  parsedScale: number | null,
): UpscalerInfo {
  const hit = catalogEntry(file);
  if (hit) return { ...hit, tags: [...hit.tags] };
  const stem = upscalerStem(file);
  const scale = parsedScale;
  const category: UpscalerCategory = FACE_RE.test(stem)
    ? "faces"
    : scale === 1
      ? "cleanup"
      : scale === 2
        ? "2x"
        : ANIME_RE.test(stem)
          ? "illustration"
          : "photo";
  const name = (file.replace(/\\/g, "/").split("/").pop() ?? file).replace(
    EXT_RE,
    "",
  );
  return {
    name,
    scale,
    category,
    tags: ANIME_RE.test(stem) ? ["anime"] : [],
  };
}

/** Defaults are full upscalers only: no 1× cleanup or face models. */
export function canBeDefault(info: Pick<UpscalerInfo, "category" | "scale">) {
  return (
    info.category !== "cleanup" &&
    info.category !== "faces" &&
    (info.scale ?? 0) >= 2
  );
}

export const UPSCALE_CONTENT_LABELS: Record<UpscaleContent, string> = {
  photo: "Photos & general",
  illustration: "Illustration & anime",
  video: "Video frames",
};
