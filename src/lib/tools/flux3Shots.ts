/**
 * FLUX.3 -> LTX shots: ready-made Boards where FLUX.3 Klein makes (or
 * restyles) the still and LTX-2.5 animates it with sound, in one run.
 *
 *   Key Art to Shot      FLUX.3 key art (16:9) -> LTX-2.5 animate + sound
 *   Restyle and Animate  photo -> FLUX.3 edit  -> LTX-2.5 animate + sound
 *
 * Same Board machinery as the LTX VFX shots (ltxShots.ts): every step is an
 * ordinary Adrift run on the previous step's output. The image -> video
 * handoff keeps the still's own size and aspect (ltx25SourceDims): FLUX.3
 * 16:9 key art (1344x768) becomes a 1344x768 clip with no crop, and an
 * edit at the photo's aspect gets the closest /64 size at or above the LTX
 * default area.
 */
import type { HubCard } from "./hub";
import type { EngineContext } from "./templates";
import type { BadgeSource } from "./licenseBadges";
import weightClassesJson from "./toolWeightClasses.json";
import { BOARD_PROMPT_FLUX3, BOARD_SOURCE } from "./board";
import type { LtxShotRecipe } from "./ltxShots";

export const FLUX3_SHOT_PACKS = ["flux3", "ltx25"] as const;

export const FLUX3_SHOT_RECIPES: readonly LtxShotRecipe[] = [
  {
    id: "key_art",
    title: "Key Art to Shot",
    subtitle:
      "FLUX.3 key art from your prompt, then LTX-2.5 turns it into a moving shot with sound",
    icon: "Clapperboard",
    model: "FLUX.3 Klein + LTX-2.5 22B",
    aliases: [
      "key art",
      "text to video",
      "storyboard",
      "establishing shot",
      "cinematic",
    ],
    lanes: [
      {
        title: "Key art to shot",
        steps: [
          {
            tool: BOARD_PROMPT_FLUX3,
            text: "Cinematic wide shot of a lighthouse keeper in a yellow raincoat standing on black basalt rocks at dusk, storm waves bursting white against the rocks, the lighthouse beam cutting through drifting sea spray, cold blue light with a warm lamp glow, 35mm film still",
          },
          {
            tool: "ltx25_animate",
            text: "The waves roll in and burst against the rocks, spray drifts across the frame, the raincoat flaps in the wind and the lighthouse beam sweeps slowly; the camera holds steady. Sound: crashing surf, howling wind, distant foghorn",
          },
        ],
      },
    ],
  },
  {
    id: "restyle_animate",
    title: "Restyle and Animate",
    subtitle:
      "FLUX.3 repaints your photo in a new style, then LTX-2.5 brings it to life with sound",
    icon: "Palette",
    model: "FLUX.3 Klein + LTX-2.5 22B",
    aliases: [
      "restyle",
      "style transfer",
      "photo to video",
      "animate",
      "painted",
    ],
    lanes: [
      {
        title: "Restyle and animate",
        steps: [
          { tool: BOARD_SOURCE },
          {
            tool: "edit_flux3",
            text: "A hand-painted animated film still of the same scene: soft gouache textures, clean ink outlines, warm golden-hour light; the same people, poses, framing and composition",
          },
          {
            tool: "ltx25_animate",
            text: "Subtle natural motion: hair and clothes stir in a light breeze, a slow breath, the light shifts softly; the same face throughout and the camera holds steady. Sound: a steady breeze, rustling clothes and the quiet ambience of the place",
          },
        ],
      },
    ],
  },
];

export const FLUX3_SHOT_KEY_PREFIX = "special:flux3_shot_";

export function flux3ShotKey(id: string): string {
  return `${FLUX3_SHOT_KEY_PREFIX}${id}`;
}

export function flux3ShotForKey(key: string): LtxShotRecipe | undefined {
  if (!key.startsWith(FLUX3_SHOT_KEY_PREFIX)) return undefined;
  const id = key.slice(FLUX3_SHOT_KEY_PREFIX.length);
  return FLUX3_SHOT_RECIPES.find((r) => r.id === id);
}

/** FLUX Kommunity + LTX-2 Community License sources. */
function shotSources(): BadgeSource[] {
  const file = weightClassesJson as unknown as {
    sources?: Record<string, BadgeSource[]>;
  };
  return [
    ...(file.sources?.["action:edit_flux3"] ?? []),
    ...(file.sources?.["action:ltx25_animate"] ?? []),
  ];
}

/** Hub cards in "Video", gated on both the FLUX.3 and the LTX-2.5 pack. */
export function flux3ShotCards(ctx: EngineContext): HubCard[] {
  const packsKnown = !!ctx.packIds;
  const missing = packsKnown
    ? FLUX3_SHOT_PACKS.filter((p) => !ctx.packIds!.has(p))
    : [];
  const reason = !missing.length
    ? null
    : missing.length === 2
      ? "The FLUX.3 and LTX-2.5 packs are not installed."
      : missing[0] === "flux3"
        ? "The FLUX.3 pack is not installed."
        : "The LTX-2.5 pack is not installed.";
  return FLUX3_SHOT_RECIPES.map((r) => ({
    key: flux3ShotKey(r.id),
    kind: "special",
    id: `flux3_shot_${r.id}`,
    title: r.title,
    subtitle: r.subtitle,
    icon: r.icon,
    hubCategory: "Video",
    available: packsKnown && !missing.length,
    unavailableReason: reason,
    licenseNote: null,
    checking: !packsKnown,
    model: r.model,
    nc: false,
    weights: "cap",
    weightSources: shotSources(),
    aliases: [
      ...r.aliases,
      "flux",
      "flux.3",
      "flux 3",
      "ltx",
      "pipeline",
      "chain",
      "shot",
    ],
  }));
}
