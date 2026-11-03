/**
 * Wan motion presets and Fun Camera poses (pack "wan22"). Pure data (only
 * the pure camera move catalog is imported): the Tools page builds its
 * pickers from these lists and the graph builders in ./wanMotion.ts read the
 * LoRA files / prompts from them.
 *
 * Base per family was settled empirically (480p, 81 frames, 4 steps): the
 * Remade-AI LoRAs (trained on Wan2.1 I2V 480p, a few on Wan2.1 T2V-14B) and
 * the Wan21 rotation / push-in LoRAs only work on the Wan2.1 I2V base +
 * lightx2v distill; on Wan2.2 they are ignored or break the clip.
 * The ostris orbit is a Wan2.2 hi/lo pair and runs on Wan2.2 I2V + the
 * wan_speed lightx2v 1022 4-step pair, as does "None (prompt only)".
 *
 * Every preset prompt slots the user's subject (default "the main subject")
 * into the trigger sentence from the LoRA's model card. Labels avoid
 * franchise names; the trigger words are kept as trained.
 */

import {
  CAMERA_MOVES,
  cameraMoveGroupLabel,
} from "./cameraMoveCatalog";

export const WAN_MOTION_ACTION = "wan_motion";
export const WAN_CAMERA_ACTION = "wan_camera";

export type WanBase = "wan21" | "wan22";
export type WanMotionCategory = "camera" | "effect" | "none";
/** Effect sections, as the Higgsfield Viral / UGC / Commercial hubs group them. */
export type WanEffectSection = "viral" | "ugc" | "commercial";
export const WAN_EFFECT_SECTIONS: { id: WanEffectSection; label: string }[] = [
  { id: "viral", label: "Viral" },
  { id: "ugc", label: "UGC" },
  { id: "commercial", label: "Commercial" },
];

export interface WanMotionPreset {
  id: string;
  label: string;
  category: WanMotionCategory;
  /** Effects only: hub section for the picker. */
  section?: WanEffectSection;
  base: WanBase;
  /** wan21: one LoRA. wan22: [high-noise, low-noise]. Empty for "none". */
  loras: string[];
  strength: number;
  /** `{s}` = subject. */
  prompt: string;
  /** One-line hint shown in docs / tests (what the input should look like). */
  note?: string;
  /** Open-weights camera catalog moves: picker group label. */
  group?: string;
  /** Recommended clip length in seconds (used by the "auto" length). */
  seconds?: number;
}

const R = (file: string) => `wan_motion/${file}`;
/** Effect LoRAs live in other loras/ subfolders (paths as /models/loras lists them). */
const E22 = (file: string) => `wan22/effects/${file}`;
const E21 = (file: string) => `wan21/effects/${file}`;

export const DEFAULT_SUBJECT = "the main subject";

/**
 * Prompt-steered effect: no LoRA, Wan2.2 I2V + the 4-step pair (same path as
 * "None"), the prompt alone describes the effect. Wording is original; the
 * names follow common effect vocabulary, not any site's copy.
 */
const steered = (
  id: string,
  label: string,
  section: WanEffectSection,
  prompt: string,
  note?: string,
): WanMotionPreset => ({
  id,
  label,
  category: "effect",
  section,
  base: "wan22",
  loras: [],
  strength: 1,
  prompt,
  ...(note ? { note } : {}),
});

/** Prompt-steered effects (Effects / Viral, UGC, Commercial hub parity). */
const STEERED_EFFECTS: WanMotionPreset[] = [
  // Viral
  steered(
    "planet_zoom_out",
    "Planet zoom out",
    "viral",
    "The camera starts close on {s} and pulls straight up and away in one continuous move, rising over the rooftops, through the clouds and out into space until the whole Earth is visible.",
  ),
  steered(
    "cartoon_punch",
    "Cartoon punch",
    "viral",
    "A padded boxing glove swings into frame and bops {s} on the cheek in slow motion, the face wobbling comically, then {s} shakes it off and grins.",
  ),
  steered(
    "building_blast",
    "Building blast behind",
    "viral",
    "{s} walks calmly toward the camera as the building behind erupts in a huge fireball, debris and smoke billowing outward, and {s} never looks back.",
  ),
  steered(
    "angel_wings",
    "Angel wings",
    "viral",
    "Large white feathered wings slowly unfold from the back of {s}, spreading wide in soft glowing light as loose feathers drift down.",
  ),
  steered(
    "flower_mouth",
    "Flower mouth",
    "viral",
    "{s} opens their mouth and a stream of colorful flowers and petals blooms out, spilling and swirling into the air.",
    "Needs a face.",
  ),
  steered(
    "levitate",
    "Levitate",
    "viral",
    "{s} slowly rises off the ground and floats in mid-air, hair and fabric drifting weightlessly while small objects nearby lift up too.",
  ),
  steered(
    "turn_invisible",
    "Turn invisible",
    "viral",
    "{s} gradually turns transparent from the edges inward until only a faint ripple of bent light remains where {s} stood.",
  ),
  steered(
    "melt",
    "Melt",
    "viral",
    "{s} slowly melts into glossy liquid, sagging and dripping downward until it pools into a shiny puddle on the ground.",
  ),
  steered(
    "soul_leap",
    "Soul leap",
    "viral",
    "A translucent glowing copy of {s} leaps out of the body and drifts upward, while {s} stays perfectly still below.",
  ),
  steered(
    "tentacles",
    "Tentacles",
    "viral",
    "Dark glossy tentacles rise from the ground behind {s}, curling and writhing slowly around {s}.",
  ),
  steered(
    "lens_crack",
    "Lens crack",
    "viral",
    "{s} stays in frame as the camera lens suddenly cracks, a spiderweb of shattered glass spreading across the whole screen.",
  ),
  steered(
    "wind_blast",
    "Wind blast",
    "viral",
    "A sudden powerful gust of wind hits {s} from the front, hair and clothes whipping back wildly as {s} squints into the wind.",
  ),
  steered(
    "take_flight",
    "Take flight",
    "viral",
    "{s} crouches and launches into the sky, flying up and away over the landscape while the camera follows.",
  ),
  steered(
    "color_powder",
    "Color powder burst",
    "viral",
    "A cloud of bright colored powder bursts around {s} in slow motion, pink, blue and yellow dust swirling through the air.",
  ),
  steered(
    "sandstorm",
    "Sandstorm",
    "viral",
    "A towering wall of sand sweeps in behind {s} and swallows the scene in swirling orange dust as {s} braces against the wind.",
  ),
  steered(
    "flood",
    "Flood",
    "viral",
    "Water rushes in and rises quickly around {s}, flooding the floor and swirling up to the waist, loose objects floating past.",
  ),
  steered(
    "garden_bloom",
    "Garden bloom",
    "viral",
    "Flowers and vines sprout and bloom rapidly all around {s}, covering the ground and the walls in vivid blossoms.",
  ),
  steered(
    "turn_crystal",
    "Turn to crystal",
    "viral",
    "{s} transforms into sparkling faceted crystal, a clear diamond-like surface spreading over {s} and scattering rainbow light.",
  ),
  steered(
    "turn_stone",
    "Turn to stone",
    "viral",
    "{s} gradually turns to grey stone from the feet up, fine cracks and dust spreading until {s} is a motionless stone statue.",
  ),
  steered(
    "datamosh",
    "Datamosh",
    "viral",
    "A datamosh glitch hits the video: {s} smears and melts into blocky pixel trails with bleeding colors, then snaps back into place.",
  ),
  steered(
    "floating_fish",
    "Floating fish",
    "viral",
    "Glowing fish swim slowly through the air around {s} as if the whole place were underwater, rippling light dancing over everything.",
  ),
  steered(
    "fire_breath",
    "Fire breath",
    "viral",
    "{s} takes a deep breath and exhales a roaring jet of fire into the air, the flames lighting up the scene.",
  ),
  steered(
    "inner_light",
    "Inner light",
    "viral",
    "Warm golden light begins to glow from within {s}, shining out through fine cracks until {s} radiates light.",
  ),
  steered(
    "vanish",
    "Vanish",
    "viral",
    "In an instant the body of {s} disappears, the empty clothes hang in the air for a moment, then collapse flat onto the ground.",
    "Needs a person.",
  ),
  steered(
    "city_giant",
    "City giant",
    "viral",
    "{s} grows into a towering giant standing among city skyscrapers, tiny cars and people moving around the feet, the camera tilting up.",
  ),
  steered(
    "creature_drop",
    "Creature drop",
    "viral",
    "A colossal fantasy creature crashes down from the sky and lands behind {s}, dust blasting outward, while {s} stays calm in front of it.",
  ),
  steered(
    "time_freeze",
    "Time freeze",
    "viral",
    "{s} freezes completely mid-motion like a statue while people, traffic and everything else around keep moving at normal speed.",
  ),
  steered(
    "world_fold",
    "World fold",
    "viral",
    "The buildings and landscape behind {s} bend, fold and ripple like liquid, curling up and over into a giant enclosure while {s} stands still.",
  ),
  steered(
    "cutout_layers",
    "Cutout layers",
    "viral",
    "The surroundings of {s} break apart into flat paper cutout layers that float away, leaving {s} in a clean white void, then the layers snap back into place.",
  ),
  steered(
    "floating_fall",
    "Floating fall",
    "viral",
    "{s} falls slowly backward in slow motion while belongings and small objects float weightlessly in the air all around.",
  ),
  steered(
    "critter_ride",
    "Critter ride",
    "viral",
    "{s} rides down the street balanced on the back of a small animal like a skateboard, carving left and right and popping a little jump.",
  ),
  steered(
    "toy_lift",
    "Toy lift",
    "viral",
    "A giant hand reaches into frame and lifts {s} out of the scene like a stiff plastic action figure, turning it around to show it off.",
  ),
  steered(
    "sticker_peel",
    "Sticker peel",
    "viral",
    "A giant hand reaches in and peels {s} off the background like a sticker, leaving a blank surface behind, then presses {s} back down.",
  ),
  steered(
    "twin_walk_in",
    "Twin walk-in",
    "viral",
    "An identical twin of {s} walks into frame, stands beside {s}, the two take a selfie together, then the twin fades away.",
  ),
  steered(
    "clone_crowd",
    "Clone crowd",
    "viral",
    "Identical copies of {s} appear one by one throughout the scene, all mirroring the same movements as {s} steps toward the camera.",
  ),
  steered(
    "cosmic_giant",
    "Cosmic giant",
    "viral",
    "{s} floats in space as a giant beside the Earth, gently reaching out to stir the swirling clouds on the planet, stars all around.",
  ),
  steered(
    "deep_water",
    "Deep water",
    "viral",
    "Deep blue water fills the scene around {s}, fish drifting past in slow motion and light rays shimmering while {s} holds perfectly still.",
  ),
  steered(
    "paparazzi",
    "Paparazzi",
    "viral",
    "{s} walks forward through a crowd of photographers as dozens of camera flashes pop, harsh white light flickering across {s}.",
  ),
  steered(
    "stadium_screen",
    "Stadium screen",
    "viral",
    "{s} appears on a giant stadium screen, seen from deep inside a cheering crowd holding up glowing phones as stage lights sweep.",
  ),
  steered(
    "cash_rain",
    "Cash rain",
    "viral",
    "Paper money rains down from above around {s}, notes fluttering and spinning through the air as {s} looks up and smiles.",
  ),
  steered(
    "fireworks",
    "Fireworks",
    "viral",
    "Colorful fireworks burst in the night sky behind {s}, the sparks reflecting in warm flashes on {s}.",
  ),
  steered(
    "aurora_sky",
    "Aurora sky",
    "viral",
    "The sky behind {s} fills with shimmering green and violet northern lights that ripple slowly overhead.",
  ),
  steered(
    "color_rain",
    "Color rain",
    "viral",
    "Drops of vivid colored paint rain down around {s}, splashing in bright bursts of color on every surface.",
  ),
  steered(
    "fairy_lights",
    "Fairy swarm",
    "viral",
    "Tiny glowing fairies circle around {s}, leaving trails of sparkling dust that hang in the air.",
  ),
  steered(
    "halo_glow",
    "Halo glow",
    "viral",
    "A soft golden halo of light appears behind the head of {s}, gentle rays glowing outward.",
  ),
  steered(
    "giant_grab",
    "Giant hand grab",
    "viral",
    "A giant hand reaches down from the sky, picks {s} up and lifts {s} out of the frame.",
  ),
  steered(
    "portal",
    "Portal",
    "viral",
    "A swirling glowing portal opens behind {s}, light and wind spilling out, and {s} turns and steps through it.",
  ),
  steered(
    "mushroom_cloud",
    "Distant blast",
    "viral",
    "Far behind {s} a huge mushroom-shaped explosion rises over the horizon and the shockwave blows dust and hair past {s}.",
  ),
  steered(
    "train_rush",
    "Train rush",
    "viral",
    "{s} stands on a platform as a train rushes past right behind at high speed, the wind whipping hair and clothes.",
  ),
  steered(
    "xray",
    "X-ray",
    "viral",
    "{s} turns into a glowing X-ray scan, bright white bones showing inside a translucent blue body.",
  ),
  steered(
    "glitch",
    "Glitch",
    "viral",
    "{s} glitches with digital distortion, the color channels splitting apart, scan lines tearing and pixels jittering.",
  ),
  steered(
    "wireframe",
    "Wireframe",
    "viral",
    "{s} dissolves into a glowing green 3D wireframe mesh, thin lines tracing every contour as it slowly turns.",
  ),
  steered(
    "point_cloud",
    "Point cloud",
    "viral",
    "{s} turns into a 3D point cloud scan of thousands of glowing dots that drift apart and then reassemble.",
  ),
  steered(
    "double_exposure",
    "Double exposure",
    "viral",
    "A double exposure: a misty forest landscape fades in and blends inside the silhouette of {s}.",
  ),
  steered(
    "living_shadow",
    "Living shadow",
    "viral",
    "The shadow of {s} on the wall starts moving on its own, gesturing independently while {s} stays still.",
  ),
  steered(
    "turn_smoke",
    "Turn to smoke",
    "viral",
    "{s} dissolves into swirling grey smoke that curls upward and drifts away.",
  ),
  steered(
    "steam_rage",
    "Steam rage",
    "viral",
    "{s} turns red with cartoonish anger as jets of steam blast out of the ears and the air shimmers with heat.",
    "Needs a face.",
  ),
  steered(
    "flame_aura",
    "Flame aura",
    "viral",
    "{s} bursts into a blazing aura of fire, flames wrapping around the body without burning it.",
  ),
  steered(
    "pool_jump",
    "Pool jump",
    "viral",
    "{s} runs and jumps into a swimming pool with a big splash, water spraying everywhere.",
  ),
  steered(
    "speed_run",
    "Speed run",
    "viral",
    "{s} sprints forward at superhuman speed, leaving motion-blur streaks and a gust of wind and dust behind.",
  ),
  steered(
    "concert_stage",
    "Concert stage",
    "viral",
    "{s} performs on a huge concert stage in front of a sea of cheering fans, stage lights and haze sweeping across.",
  ),
  steered(
    "spirit_animal",
    "Spirit animal",
    "viral",
    "A glowing translucent animal made of light appears beside {s} and circles slowly around {s}.",
  ),
  steered(
    "living_tattoo",
    "Living tattoo",
    "viral",
    "Ink lines appear on the skin of {s} and come alive, crawling and swirling across the skin like a moving tattoo.",
    "Needs visible skin.",
  ),
  // Viral: transformations, physics gags, signature moves
  // Each prompt states the start, the change and the end state plus the
  // camera, which keeps Wan2.2 I2V from drifting into a generic pan.
  steered(
    "raven_wings",
    "Raven wings",
    "viral",
    "{s} stands still as two huge black feathered wings burst out from the back, unfolding wide with one powerful flap that sends dark feathers and dust swirling outward, then the wings settle into a slow, steady beat. Static camera, dramatic rim light, realistic feather detail.",
  ),
  steered(
    "impact_punch",
    "Impact punch",
    "viral",
    "{s} winds up and throws a powerful punch straight at the camera in slow motion, the fist stopping just short of the lens as a ring-shaped shockwave ripples through the air, dust and debris blasting outward and the frame shaking on impact.",
  ),
  steered(
    "clone_split",
    "Clone split",
    "viral",
    "{s} splits down the middle into two identical copies that step apart to the left and right, each turning to look at the other in surprise, both matching exactly in clothing and lighting. Static camera, seamless and realistic.",
  ),
  steered(
    "hair_surge",
    "Hair surge",
    "viral",
    "The hair of {s} starts growing rapidly, flowing longer and longer past the shoulders, down the back and spilling across the floor in thick glossy waves while {s} looks around in amazement. Static camera, soft natural light.",
    "Needs a person or animal with visible hair.",
  ),
  steered(
    "blast_reveal",
    "Blast reveal",
    "viral",
    "A bright explosion of colored smoke and sparks fills the whole frame, then the cloud rolls away and clears to reveal {s} standing in the center in a confident pose as glowing embers drift down. Cinematic lighting.",
  ),
  steered(
    "spiral_zoom",
    "Spiral zoom",
    "viral",
    "The camera spins in a fast continuous corkscrew roll while pushing in toward {s}, the background twisting into a dizzying spiral blur, then the rotation snaps to a stop on a sharp, level close-up of {s}.",
  ),
  steered(
    "shrink_down",
    "Shrink down",
    "viral",
    "{s} rapidly shrinks to a tiny size, the furniture and floor around suddenly looming enormous, and the camera tilts down to follow the miniature {s} looking up at the giant world. Realistic scale and lighting.",
  ),
  steered(
    "age_forward",
    "Age forward",
    "viral",
    "{s} ages smoothly over decades in one continuous shot, the hair turning grey then white and wrinkles slowly deepening, while the expression and pose stay the same. Static camera, soft even light, photorealistic.",
    "Needs a face.",
  ),
  steered(
    "gravity_flip",
    "Gravity flip",
    "viral",
    "Gravity suddenly reverses around {s}: loose objects, hair and clothing all fall upward toward the ceiling while {s} floats up off the floor and reaches out for balance, the camera slowly rolling upside down to follow.",
  ),
  steered(
    "snow_globe",
    "Snow globe",
    "viral",
    "The camera pulls back to reveal that {s} is tiny and sealed inside a glass snow globe on a wooden table, then a hand gives the globe a gentle shake and glittering snowflakes swirl down around {s}. Warm cozy light.",
  ),
  steered(
    "jelly_wobble",
    "Jelly wobble",
    "viral",
    "A finger pokes {s} and it turns soft and translucent like jelly, wobbling and jiggling back and forth in glossy bouncy ripples before slowly settling back into shape. Static camera, playful and realistic.",
  ),
  steered(
    "butterfly_burst",
    "Butterfly burst",
    "viral",
    "{s} breaks apart from the edges into hundreds of bright colorful butterflies that flutter outward and swirl up into the sky until nothing of {s} is left. Static camera, soft sunlight, magical atmosphere.",
  ),
  steered(
    "paper_fold",
    "Paper fold",
    "viral",
    "{s} turns into folded paper, crisp creases spreading across the surface as it folds itself up into a neat origami figure with sharp paper edges, which then hops forward across the table. Static camera, clean studio light.",
  ),
  steered(
    "voxel_break",
    "Voxel break",
    "viral",
    "{s} breaks apart into thousands of small glowing cubes that scatter outward and hang floating in the air, then snap back together into {s} in one satisfying ripple. Static camera, crisp digital look.",
  ),
  steered(
    "ice_shatter",
    "Ice shatter",
    "viral",
    "Frost races across {s} until it is encased in clear solid ice, then the ice cracks with bright fracture lines and shatters into glittering shards that fly outward in slow motion, leaving {s} unharmed. Cold blue light.",
  ),
  steered(
    "plush_toy",
    "Plush toy",
    "viral",
    "{s} slowly transforms into a soft stuffed plush toy, the surface turning into fuzzy fabric with stitched seams and shiny button eyes, then the plush toy tips over onto its side. Static camera, warm soft light.",
  ),
  steered(
    "toon_shift",
    "Toon shift",
    "viral",
    "{s} morphs from photorealistic into a hand-drawn 2D cartoon with bold outlines and flat bright colors, then waves at the camera with bouncy animated motion while the background stays real. Static camera.",
  ),
  steered(
    "eye_dive",
    "Eye dive",
    "viral",
    "The camera pushes in slowly toward the eye of {s}, then dives straight into the dark pupil and through it, emerging into a vast glowing galaxy of stars and nebula clouds on the other side. One continuous shot.",
    "Needs a face.",
  ),
  steered(
    "world_tilt",
    "Tilted world",
    "viral",
    "The whole room slowly tilts sideways around {s}, chairs, cups and loose objects sliding and tumbling past across the floor, while {s} stays perfectly upright and calm, unaffected by the slope.",
  ),
  // UGC
  steered(
    "selfie_posing",
    "Selfie posing",
    "ugc",
    "{s} holds a phone at arm's length and poses for selfies, changing expressions and angles, handheld phone footage.",
  ),
  steered(
    "mirror_selfie",
    "Mirror selfie",
    "ugc",
    "{s} takes a mirror selfie, adjusting the pose and outfit while holding the phone up, casual handheld look.",
  ),
  steered(
    "outfit_check",
    "Outfit check",
    "ugc",
    "{s} steps back and turns slowly to show off the full outfit while the handheld phone camera tilts from the shoes up to the face.",
  ),
  steered(
    "outfit_switch",
    "Outfit switch",
    "ugc",
    "{s} spins around once and the outfit instantly changes into a completely different stylish look.",
  ),
  steered(
    "static_posing",
    "Static posing",
    "ugc",
    "{s} holds a series of confident model poses for the camera, shifting slightly between each pose.",
  ),
  steered(
    "hair_flip",
    "Hair flip",
    "ugc",
    "{s} flips their hair over one shoulder in slow motion and smiles at the camera.",
  ),
  steered(
    "sunglasses_on",
    "Sunglasses on",
    "ugc",
    "{s} slowly puts on a pair of sunglasses and gives the camera a confident look.",
  ),
  steered(
    "happy_reaction",
    "Happy reaction",
    "ugc",
    "{s} breaks into a big genuine laugh, eyes crinkling and shoulders shaking with joy.",
    "Needs a face.",
  ),
  steered(
    "angry_reaction",
    "Angry reaction",
    "ugc",
    "{s} frowns, clenches the jaw and glares at the camera, breathing hard with rising anger.",
    "Needs a face.",
  ),
  steered(
    "shocked_reaction",
    "Shocked reaction",
    "ugc",
    "The eyes of {s} widen and the jaw drops in total shock, hands rising to cover the mouth.",
    "Needs a face.",
  ),
  steered(
    "crying",
    "Crying",
    "ugc",
    "The eyes of {s} well up and tears roll slowly down the cheeks, lips trembling.",
    "Needs a face.",
  ),
  steered(
    "taste_test",
    "Taste test",
    "ugc",
    "{s} takes a bite of food and reacts with delight, chewing and nodding, close handheld phone camera.",
    "Needs a person.",
  ),
  steered(
    "plate_check",
    "Plate check",
    "ugc",
    "The handheld phone camera slowly circles {s} on the table, showing every side as steam rises.",
    "Food or a product on a table.",
  ),
  steered(
    "unboxing",
    "Unboxing",
    "ugc",
    "Two hands open a box and lift out {s}, turning it toward the camera to show it off.",
    "A product.",
  ),
  // Commercial
  steered(
    "freeze_over",
    "Freeze over",
    "commercial",
    "Frost creeps across {s}, ice crystals spreading over every surface until {s} is encased in clear glittering ice, cold mist drifting.",
  ),
  steered(
    "thunder_strike",
    "Thunder strike",
    "commercial",
    "Dark storm clouds gather above {s}, bolts of lightning strike down all around and blue electric arcs crackle across {s}.",
  ),
  steered(
    "clone_burst",
    "Clone burst",
    "commercial",
    "Identical copies of {s} burst outward from it in every direction, multiplying across the frame in a rapid ripple.",
  ),
  steered(
    "paint_splash",
    "Paint splash",
    "commercial",
    "Thick splashes of bright paint burst and swirl around {s} in slow motion, glossy arcs of color hanging in the air.",
  ),
  steered(
    "liquid_splash",
    "Liquid splash",
    "commercial",
    "{s} drops into clear liquid with a dramatic slow-motion splash, droplets and a crown of water frozen in bright studio light.",
  ),
  steered(
    "roll_transition",
    "Roll transition",
    "commercial",
    "The camera rolls a full turn around its own axis while pushing toward {s}, the scene spinning into a new angle.",
  ),
  steered(
    "catwalk",
    "Catwalk",
    "commercial",
    "{s} walks confidently down a fashion runway toward the camera, flashes popping from both sides.",
  ),
  steered(
    "exploded_view",
    "Exploded view",
    "commercial",
    "{s} smoothly separates into its component parts, which float apart in an exploded view and then reassemble.",
    "A product.",
  ),
  steered(
    "balloon_float",
    "Balloon float",
    "commercial",
    "{s} floats gently upward tied to a bunch of colorful balloons against a clear blue sky.",
  ),
  steered(
    "clothes_rain",
    "Clothes rain",
    "commercial",
    "Clothes and fashion items rain down from the sky around {s}, shirts and jackets fluttering down.",
  ),
  steered(
    "red_carpet",
    "Red carpet",
    "commercial",
    "{s} walks along a red carpet as photographers flash and a crowd cheers behind the barriers.",
  ),
  steered(
    "product_float",
    "Product float",
    "commercial",
    "{s} levitates and slowly rotates in mid-air against a clean studio backdrop, soft reflections and gentle floating particles.",
    "A product.",
  ),
  steered(
    "sand_cut",
    "Sand cut",
    "commercial",
    "A knife slices through {s} as if it were made of kinetic sand, the cut piece crumbling away in smooth, satisfying grains.",
  ),
  steered(
    "cloud_rest",
    "Cotton cloud",
    "commercial",
    "{s} rests on a soft fluffy white cloud that drifts and puffs gently around it under a dreamy pastel sky.",
  ),
];

/**
 * Open-weights camera catalog (./cameraMoveCatalog.ts) as LoRA-free Wan 2.2
 * presets: the prompt alone steers the move. Ids are prefixed "cam_" so they
 * never collide with the LoRA camera presets.
 */
export const CAMERA_CATALOG_PRESETS: WanMotionPreset[] = CAMERA_MOVES.map(
  (m) => ({
    id: `cam_${m.id}`,
    label: m.label,
    category: "camera",
    base: "wan22",
    loras: [],
    strength: 1,
    prompt: m.prompt,
    group: cameraMoveGroupLabel(m.group),
    seconds: m.seconds,
  }),
);

export const WAN_MOTION_PRESETS: WanMotionPreset[] = [
  // Camera moves
  {
    id: "orbit_360",
    label: "360 orbit",
    category: "camera",
    base: "wan21",
    loras: [R("360_Orbit.safetensors")],
    strength: 1,
    prompt:
      "The video shows {s}. The camera performs an 0rb4it 360 degree orbit, circling all the way around {s} and showing the surroundings, before returning to the front view. Throughout the 0rb4it 360 degree orbit, {s} stays in place.",
  },
  {
    id: "orbit_360_wan22",
    label: "360 orbit (Wan 2.2)",
    category: "camera",
    base: "wan22",
    loras: [
      R("wan22_14b_i2v_orbit_high_noise.safetensors"),
      R("wan22_14b_i2v_orbit_low_noise.safetensors"),
    ],
    strength: 1,
    prompt: "orbit 360 around {s}.",
  },
  {
    id: "arc_shot",
    label: "Arc shot",
    category: "camera",
    base: "wan21",
    loras: [R("Arc_shot.safetensors")],
    strength: 1,
    prompt:
      "The video shows {s}. The 34Ar2c arc the camera moves in a smooth curve around {s}, shifting the perspective around {s}.",
  },
  {
    id: "push_in",
    label: "Push in",
    category: "camera",
    base: "wan21",
    loras: [R("motionpushin-v5-wan-i2v-14b-720p-400.safetensors")],
    strength: 1,
    prompt:
      "Push-in camera, the camera moves smoothly toward {s} until {s} fills the frame.",
  },
  {
    id: "crash_zoom_in",
    label: "Crash zoom in",
    category: "camera",
    base: "wan21",
    loras: [R("crash_zoom_in.safetensors")],
    strength: 1,
    prompt:
      "The video shows {s}. The camera performs a cr34sh crash zoom in effect, rapidly zooming closer to {s}.",
  },
  {
    id: "crash_zoom_out",
    label: "Crash zoom out",
    category: "camera",
    base: "wan21",
    loras: [R("crash_zoom_out.safetensors")],
    strength: 1,
    prompt:
      "The video begins with a close-up of {s}. Then a cr34sh crash zoom out effect rapidly reveals the wide scene around {s}.",
  },
  {
    id: "dolly_zoom",
    label: "Dolly zoom (vertigo)",
    category: "camera",
    base: "wan21",
    loras: [R("dolly_25_epochs.safetensors")],
    strength: 1,
    prompt:
      "d011Ye33ect dolly effect. The video begins with a close-up of {s}. The camera slowly zooms out, keeping {s} centered while the background stretches behind it.",
  },
  {
    id: "crane_up",
    label: "Crane up",
    category: "camera",
    base: "wan21",
    loras: [R("crane_up.safetensors")],
    strength: 1,
    prompt:
      "The video shows {s}. The cr4n3 crane up effect is applied, smoothly lifting the camera's viewpoint higher and revealing more of the surroundings around {s}.",
  },
  {
    id: "crane_down",
    label: "Crane down",
    category: "camera",
    base: "wan21",
    loras: [R("crane_down.safetensors")],
    strength: 1,
    prompt:
      "The video shows {s}. The cr4n3 crane down camera motion begins high above and slowly lowers the view down to {s}.",
  },
  {
    id: "crane_overhead",
    label: "Crane over the head",
    category: "camera",
    base: "wan21",
    loras: [R("crane_overhead.safetensors")],
    strength: 1,
    prompt:
      "The video shows {s}. The camera begins a cr4n3 crane over the head movement, rising smoothly upwards and passing over {s}.",
  },
  {
    id: "bullet_time",
    label: "Bullet time",
    category: "camera",
    base: "wan21",
    loras: [R("matrix_shot.safetensors")],
    strength: 1,
    prompt:
      "b4ll3t t1m3 bullet time shot. The video shows {s} frozen in a dynamic moment while the camera sweeps around in a b4ll3t t1m3 bullet time shot effect, the action dramatically slowed down.",
  },
  {
    id: "turntable",
    label: "Turntable rotation",
    category: "camera",
    base: "wan21",
    loras: [R("rotate_20_epochs.safetensors")],
    strength: 1,
    prompt:
      "The video shows {s}. {s} performs a r0t4tion 360 degrees rotation.",
  },
  {
    id: "turntable_soft",
    label: "Turntable (gentle)",
    category: "camera",
    base: "wan21",
    loras: [R("Wan21_I2V_rotation_000003750.safetensors")],
    strength: 1,
    prompt: "rw360xz, {s} rotates 360 degrees.",
    note: "Turns roughly 45 degrees in 5 s in tests; use Turntable rotation for a full spin.",
  },
  {
    id: "eye_closeup",
    label: "Eye extreme close-up",
    category: "camera",
    base: "wan21",
    loras: [R("eye_10_epochs.safetensors")],
    strength: 1,
    prompt:
      "3y3_cl053 eye extreme close up, the video shows an extreme close up of the eye of {s}.",
    note: "Needs a face (person or animal).",
  },
  {
    id: "tiny_planet",
    label: "Tiny planet fisheye",
    category: "camera",
    base: "wan21",
    loras: [R("fisheye_15_epochs.safetensors")],
    strength: 1,
    prompt:
      "Little planet view fisheye lens The video depicts {s}, the scene rendered into a miniature spinning planet.",
  },
  {
    id: "ultra_wide",
    label: "Ultra-wide angle",
    category: "camera",
    base: "wan21",
    loras: [R("ultra_wide_5_epochs.safetensors")],
    strength: 1,
    prompt: "u1tr4_w1d3, ultra wide angle shot of {s}.",
  },
  {
    id: "pov_driving",
    label: "POV driving",
    category: "camera",
    base: "wan21",
    loras: [R("pov_driving_5_epochs.safetensors")],
    strength: 1,
    prompt:
      "p0v_dr1v1n6, video shows a person driving a car toward {s}. The driver is holding the steering wheel with both hands and looking straight ahead.",
  },
  {
    id: "car_chase",
    label: "Car chase",
    category: "camera",
    base: "wan21",
    loras: [R("car_chase.safetensors")],
    strength: 1,
    prompt:
      "The video depicts a dramatic c4r ch4s3 car chase around {s}. Vehicles speed past with blazing headlights while the camera follows the action.",
  },
  // Effects
  {
    id: "squish",
    label: "Squish",
    category: "effect",
    section: "viral",
    base: "wan21",
    loras: [R("squish_18.safetensors")],
    strength: 1,
    prompt:
      "In the video, a miniature {s} is presented. The {s} is held in a person's hands. The person then presses on the {s}, causing a sq41sh squish effect. The person keeps pressing down on the {s}, further showing the sq41sh squish effect.",
  },
  {
    id: "cakeify",
    label: "Cake-ify",
    category: "effect",
    section: "commercial",
    base: "wan21",
    loras: [R("cakeify_16_epochs.safetensors")],
    strength: 1,
    prompt:
      "The video opens on a {s}. A knife, held by a hand, is coming into frame and hovering over the {s}. The knife then begins cutting into the {s} to c4k3 cakeify it. As the knife slices the {s} open, the inside of the {s} is revealed to be cake with chocolate layers. The knife cuts through and the contents of the {s} are revealed.",
  },
  {
    id: "crush",
    label: "Hydraulic crush",
    category: "effect",
    section: "commercial",
    base: "wan21",
    loras: [R("crush_20_epochs.safetensors")],
    strength: 1,
    prompt:
      "The video begins with a {s}. A hydraulic press positioned above slowly descends towards the {s}. Upon contact, the hydraulic press c5us4 crushes it, deforming and flattening the {s}, causing the {s} to collapse inward until the {s} is no longer recognizable.",
  },
  {
    id: "inflate",
    label: "Inflate",
    category: "effect",
    section: "viral",
    base: "wan21",
    loras: [R("inflate_20_epochs.safetensors")],
    strength: 1,
    prompt:
      "The video shows {s}, then infl4t3 inflates it, {s} expanding into a giant inflated figure.",
  },
  {
    id: "explode",
    label: "Explode",
    category: "effect",
    section: "viral",
    base: "wan21",
    loras: [R("explode_30_epochs.safetensors")],
    strength: 1,
    prompt:
      "The video opens on {s}. Then {s} 3xp105ion huge explosion that engulfs the entire screen with a bright light.",
  },
  {
    id: "electrify",
    label: "Electrify",
    category: "effect",
    section: "viral",
    base: "wan21",
    loras: [R("electrify_50_epochs.safetensors")],
    strength: 1,
    prompt:
      "e13c7r1c electricity effect streaks across {s}, crackling bolts of lightning arcing over {s}.",
  },
  {
    id: "on_fire",
    label: "Set on fire",
    category: "effect",
    section: "viral",
    base: "wan21",
    loras: [R("fire_12_epochs.safetensors")],
    strength: 1,
    prompt:
      "[r3al_f1re] {s} is engulfed in roaring realistic flames, smoke rising into the sky.",
  },
  {
    id: "tornado",
    label: "Tornado",
    category: "effect",
    section: "viral",
    base: "wan21",
    loras: [R("tornado_10_epochs.safetensors")],
    strength: 1,
    prompt:
      "A huge t0r54d0 tornado swirls in behind {s}, debris and dust flying in all directions as the storm intensifies.",
  },
  {
    id: "tsunami",
    label: "Tsunami",
    category: "effect",
    section: "viral",
    base: "wan21",
    loras: [R("tsunami_4_epochs.safetensors")],
    strength: 1,
    prompt:
      "The video shows {s} as a t5un@m1 realistic tsunami crashes in, flooding everything with churning water and debris.",
  },
  {
    id: "force_push",
    label: "Force push",
    category: "effect",
    section: "viral",
    base: "wan21",
    loras: [R("fus_ro_dah_20_epochs.safetensors")],
    strength: 1,
    prompt:
      "The video shows {s}, then {s} is suddenly flung backwards by the fus_r0_d4h force push effect, flying into the sky.",
  },
  {
    id: "jumpscare",
    label: "Jumpscare",
    category: "effect",
    section: "viral",
    base: "wan21",
    loras: [R("jumpscare_35_epochs.safetensors")],
    strength: 1,
    prompt:
      "The video shows {s}, then the j432mpscare jumpscare occurs, revealing a distorted and monstrous face with glowing red eyes, filling the frame.",
  },
  {
    id: "muscle_reveal",
    label: "Muscle reveal",
    category: "effect",
    section: "ugc",
    base: "wan21",
    loras: [R("muscle_18_epochs.safetensors")],
    strength: 1,
    prompt:
      "The video shows {s}, then t2k1s takes off clothes revealing a lean muscular body and shows off muscles.",
    note: "Needs a person.",
  },
  {
    id: "hero_run",
    label: "Hero run",
    category: "effect",
    section: "viral",
    base: "wan21",
    loras: [R("Hero_run.safetensors")],
    strength: 1,
    prompt:
      "The video shows {s}. {s} then explodes into motion, beginning the 4ct3ion Action Run, running heroically toward the camera.",
    note: "Needs a person or animal.",
  },
  {
    id: "boxing",
    label: "Boxing",
    category: "effect",
    section: "ugc",
    base: "wan21",
    loras: [R("boxing_10_epochs.safetensors")],
    strength: 1,
    prompt: "B0x13ng Boxing video, {s} throws fast punches in a boxing ring.",
    note: "Needs a person.",
  },
  {
    id: "kiss",
    label: "Kiss",
    category: "effect",
    section: "viral",
    base: "wan21",
    loras: [R("kissing_30_epochs.safetensors")],
    strength: 1,
    prompt:
      "The video shows {s}. The two people turn toward each other and engage in k144ing kissing.",
    note: "Needs two people in the photo.",
  },
  // Wan2.2 I2V A14B hi/lo effect pairs (artificialguybr Redmond, CC0) and a
  // Wan2.1 I2V face reveal (Remade-AI), stored under loras/wan2x/effects/.
  {
    id: "disintegrate",
    label: "Disintegrate",
    category: "effect",
    section: "viral",
    base: "wan22",
    loras: [
      E22("Disintegration_Redmond_high_noise.safetensors"),
      E22("Disintegration_Redmond_low_noise.safetensors"),
    ],
    strength: 1,
    prompt:
      "Disintegration. {s} slowly disintegrates, breaking apart into fine dust and glowing particles that drift away into the air.",
  },
  {
    id: "explosion_wan22",
    label: "Explosion (Wan 2.2)",
    category: "effect",
    section: "viral",
    base: "wan22",
    loras: [
      E22("Explosion_Redmond_high_noise.safetensors"),
      E22("Explosion_Redmond_low_noise.safetensors"),
    ],
    strength: 1,
    prompt:
      "{s} exploding. EXPLOSION. {s} bursts into a huge fiery explosion with flying debris, fire and billowing smoke.",
  },
  {
    id: "metal",
    label: "Turn to metal",
    category: "effect",
    section: "commercial",
    base: "wan22",
    loras: [
      E22("Metalcification_Redmond_high_noise.safetensors"),
      E22("Metalcification_Redmond_low_noise.safetensors"),
    ],
    strength: 1,
    prompt:
      "Metalcification. {s} gradually transforms into polished metal, its surface turning into reflective chrome from one side to the other.",
  },
  {
    id: "robot_face_reveal",
    label: "Robot face reveal",
    category: "effect",
    section: "viral",
    base: "wan21",
    loras: [E21("robot_face_reveal_35_epochs.safetensors")],
    strength: 1,
    prompt:
      "The video shows {s}. The r8b8t1c robotic face reveal progresses, metallic lines appearing on the face, then the face opens to reveal a robotic interior.",
    note: "Needs a face (person or animal).",
  },
  ...CAMERA_CATALOG_PRESETS,
  ...STEERED_EFFECTS,
  // No LoRA
  {
    id: "none",
    label: "None (prompt only)",
    category: "none",
    base: "wan22",
    loras: [],
    strength: 1,
    prompt: "{s} moves naturally while the camera drifts slowly.",
    note: "The text box is the whole prompt.",
  },
];

export const DEFAULT_WAN_MOTION_PRESET = "orbit_360";

export function getWanMotionPreset(id: unknown): WanMotionPreset {
  const key = typeof id === "string" ? id.trim() : "";
  return (
    WAN_MOTION_PRESETS.find((p) => p.id === key) ??
    WAN_MOTION_PRESETS.find((p) => p.id === DEFAULT_WAN_MOTION_PRESET)!
  );
}

function capitalizeFirst(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Preset prompt with the subject slotted in. For "none" the user's text is
 * the whole prompt. A subject ending in "." keeps working (trimmed).
 */
export function wanMotionPrompt(
  preset: WanMotionPreset,
  text?: unknown,
): string {
  const raw =
    typeof text === "string" ? text.trim().replace(/[.\s]+$/, "") : "";
  if (preset.id === "none" && raw) return raw;
  const subject = raw || DEFAULT_SUBJECT;
  // Sentence-initial slots get a capital letter.
  return preset.prompt.replace(/\{s\}/g, (_m, offset: number) =>
    /(^|[.!?]\s+)$/.test(preset.prompt.slice(0, offset))
      ? capitalizeFirst(subject)
      : subject,
  );
}

// Fun Camera (WanCameraEmbedding.camera_pose enum, ComfyUI core)

export interface WanCameraPose {
  id: string;
  label: string;
  /** Exact WanCameraEmbedding.camera_pose value. */
  pose: string;
  /** Default prompt tail describing the move. */
  move: string;
}

export const WAN_CAMERA_POSES: WanCameraPose[] = [
  {
    id: "zoom_in",
    label: "Zoom in",
    pose: "Zoom In",
    move: "the camera slowly zooms in",
  },
  {
    id: "zoom_out",
    label: "Zoom out",
    pose: "Zoom Out",
    move: "the camera slowly zooms out",
  },
  {
    id: "pan_left",
    label: "Pan left",
    pose: "Pan Left",
    move: "the camera pans smoothly to the left",
  },
  {
    id: "pan_right",
    label: "Pan right",
    pose: "Pan Right",
    move: "the camera pans smoothly to the right",
  },
  {
    id: "pan_up",
    label: "Tilt up",
    pose: "Pan Up",
    move: "the camera tilts smoothly upward",
  },
  {
    id: "pan_down",
    label: "Tilt down",
    pose: "Pan Down",
    move: "the camera tilts smoothly downward",
  },
  {
    id: "roll_acw",
    label: "Roll anticlockwise",
    pose: "Anti Clockwise (ACW)",
    move: "the camera rolls anticlockwise",
  },
  {
    id: "roll_cw",
    label: "Roll clockwise",
    pose: "ClockWise (CW)",
    move: "the camera rolls clockwise",
  },
  {
    id: "static",
    label: "Static",
    pose: "Static",
    move: "the camera stays still",
  },
];

export const WAN_CAMERA_SPEEDS: { id: string; label: string; value: number }[] =
  [
    { id: "normal", label: "Normal", value: 1 },
    { id: "slow", label: "Slow", value: 0.5 },
    { id: "fast", label: "Fast", value: 2 },
  ];

export function getWanCameraPose(id: unknown): WanCameraPose {
  const key = typeof id === "string" ? id.trim() : "";
  return (
    WAN_CAMERA_POSES.find((p) => p.id === key || p.pose === key) ??
    WAN_CAMERA_POSES[0]
  );
}

export function wanCameraSpeed(id: unknown): number {
  if (typeof id === "number" && Number.isFinite(id))
    return Math.min(10, Math.max(0, id));
  const key = typeof id === "string" ? id.trim() : "";
  return (WAN_CAMERA_SPEEDS.find((s) => s.id === key) ?? WAN_CAMERA_SPEEDS[0])
    .value;
}

/** User text, then the pose's move phrase (unless the text already says it). */
export function wanCameraPrompt(pose: WanCameraPose, text?: unknown): string {
  const raw =
    typeof text === "string" ? text.trim().replace(/[.\s]+$/, "") : "";
  const scene = raw || "The scene comes to life with natural motion";
  return `${scene}, ${pose.move}.`;
}

// Shared knobs

/** "fast" = 4-step distill (default); "quality" = full sampling, ~5x slower. */
export const WAN_MODES = [
  { id: "fast", label: "Fast (4 steps)" },
  { id: "quality", label: "Quality (20 steps, slower)" },
];

/** First entry is the default (720p: sharp enough to keep; 480p is the quick draft). */
export const WAN_RESOLUTIONS = [
  { id: "720p", label: "720p", area: 720 * 1280 },
  { id: "480p", label: "480p (faster)", area: 480 * 832 },
];

export const WAN_LENGTHS = [
  { id: "5s", label: "5 s", frames: 81 },
  { id: "3s", label: "3 s", frames: 49 },
];

/** wan_motion only: length follows the preset's recommended seconds. */
export const WAN_AUTO_LENGTH = { id: "auto", label: "Auto (per preset)" };

export const WAN_FPS = 16;

const snap16 = (v: number) => Math.max(16, Math.round(v / 16) * 16);

/**
 * Output size: source aspect (square when unknown, clamped to 21:9 / 9:21)
 * at the chosen pixel area, both sides on the /16 grid.
 */
export function wanDims(
  resolution: unknown,
  width?: number,
  height?: number,
): { width: number; height: number } {
  const area = (
    WAN_RESOLUTIONS.find((r) => r.id === resolution) ?? WAN_RESOLUTIONS[0]
  ).area;
  const w = typeof width === "number" && width > 0 ? width : 1;
  const h = typeof height === "number" && height > 0 ? height : 1;
  const aspect = Math.min(21 / 9, Math.max(9 / 21, w / h));
  return {
    width: snap16(Math.sqrt(area * aspect)),
    height: snap16(Math.sqrt(area / aspect)),
  };
}

export function wanLength(id: unknown): number {
  return (WAN_LENGTHS.find((l) => l.id === id) ?? WAN_LENGTHS[0]).frames;
}

/**
 * wan_motion length: "auto" (or unset) uses the preset's recommended
 * seconds (3 s when it asks for 3 or less, else 5 s, the Wan cap); an
 * explicit "5s" / "3s" wins.
 */
export function wanMotionLength(
  preset: WanMotionPreset,
  duration: unknown,
): number {
  if (duration === WAN_AUTO_LENGTH.id || duration == null || duration === "") {
    return wanLength(
      preset.seconds !== undefined && preset.seconds <= 3 ? "3s" : "5s",
    );
  }
  return wanLength(duration);
}

export function isQualityMode(mode: unknown): boolean {
  return typeof mode === "string" && mode.trim().toLowerCase() === "quality";
}
