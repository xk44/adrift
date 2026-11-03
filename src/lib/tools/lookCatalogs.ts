/**
 * Preset catalogs for three template cards (What If, Commercial Faces,
 * AI Stylist). Every entry compiles to one full edit instruction that runs
 * on the existing single-photo edit engines (templates.ts SINGLE_ENGINES):
 * no new graphs, no new models. All wording is our own.
 *
 * AI Stylist describes garments in text, so no garment photo is needed;
 * the photo-based swap stays the "Outfit Swap" app (qwen21-outfit-swap /
 * dual-ref edit).
 */

import type { TemplatePreset, TemplateSet } from "./templates";

const KEEP_ID = "Keep their face and identity recognizable.";

const whatIf = (
  group: string,
  id: string,
  label: string,
  change: string,
  keep = KEEP_ID,
): TemplatePreset => ({ id, label, group, prompt: `${change} ${keep}` });

/** "What if…" transformations of the person or subject in the photo. */
export const WHAT_IF_PRESETS: TemplatePreset[] = [
  // Age & body
  whatIf(
    "Age",
    "elderly",
    "In their 80s",
    "Age the same person to their eighties: grey or white hair, natural wrinkles and age spots, a kind expression, the same clothing style and setting.",
  ),
  whatIf(
    "Age",
    "bodybuilder",
    "As a bodybuilder",
    "Show the same person as a competition bodybuilder with very muscular arms, shoulders and chest, a confident flexing pose and gym lighting.",
  ),
  // Material
  whatIf(
    "Material",
    "statue",
    "As a marble statue",
    "Turn the person into a classical white marble statue with carved hair, smooth stone skin and subtle veining, standing on a plinth in a museum hall.",
    "Keep their facial features recognizable in the stone.",
  ),
  whatIf(
    "Material",
    "bronze",
    "As a bronze sculpture",
    "Turn the person into a polished bronze sculpture with a green patina in the recesses, mounted on a stone pedestal in a city park.",
    "Keep their facial features recognizable in the metal.",
  ),
  whatIf(
    "Material",
    "gold",
    "Solid gold",
    "Turn the person and their clothes into solid polished gold with mirror-like reflections, lit like a luxury product shot.",
    "Keep their facial features recognizable in the gold.",
  ),
  whatIf(
    "Material",
    "ice",
    "Made of ice",
    "Turn the person into a translucent ice sculpture with frosty edges, trapped air bubbles and cold blue light shining through it.",
    "Keep their facial features recognizable in the ice.",
  ),
  whatIf(
    "Material",
    "glass",
    "Made of glass",
    "Turn the person into a clear hand-blown glass figure with colorful refractions and bright caustic highlights on the surface below.",
    "Keep their facial features recognizable in the glass.",
  ),
  whatIf(
    "Material",
    "wood",
    "Carved wood",
    "Turn the person into a hand-carved wooden figure with visible grain and chisel marks, polished with warm oil.",
    "Keep their facial features recognizable in the wood.",
  ),
  whatIf(
    "Material",
    "balloon",
    "Balloon figure",
    "Turn the person into a giant inflatable balloon figure with glossy latex skin and rounded puffy limbs, floating over a festival street.",
    "Keep their face shape and colors recognizable.",
  ),
  // Style
  whatIf(
    "Style",
    "claymation",
    "As a claymation figure",
    "Turn the person into a stop-motion clay figure with fingerprint texture, slightly oversized head and handmade clay clothes on a miniature set.",
    "Keep their hairstyle, outfit colors and recognizable features.",
  ),
  whatIf(
    "Style",
    "action_figure",
    "As an action figure",
    "Turn the person into a posable plastic action figure with visible joints, sealed in a blister pack with a cardboard backing showing accessories.",
    "Keep their recognizable features and outfit; no brand names or logos.",
  ),
  whatIf(
    "Style",
    "plush",
    "As a plush toy",
    "Turn the person into a soft plush toy with fuzzy fabric, stitched seams and button-like eyes, sitting on a bed.",
    "Keep their hairstyle and outfit colors so it is clearly them.",
  ),
  whatIf(
    "Style",
    "cartoon",
    "As a cartoon",
    "Redraw the person as a hand-drawn cartoon character with bold outlines, expressive features and flat colors, in the same pose and setting.",
    "Keep their hairstyle, outfit and key features.",
  ),
  whatIf(
    "Style",
    "painting",
    "As an old painting",
    "Turn the photo into a classical oil portrait of the same person in a gilded frame, with period clothing, dark background and visible brushwork.",
  ),
  whatIf(
    "Style",
    "video_game",
    "As a game character",
    "Show the same person as a stylized 3D video game hero, with a heroic stance, detailed game gear and a fantasy landscape behind.",
  ),
  whatIf(
    "Style",
    "zombie",
    "As a zombie",
    "Show the same person as a movie-makeup zombie with pale grey skin, dark eye sockets and torn clothes in a foggy street, theatrical not gory.",
  ),
  // Era
  whatIf(
    "Era",
    "1920s",
    "In the 1920s",
    "Place the same person in the 1920s: period hair and clothing, a jazz-age ballroom, sepia-toned vintage photo look.",
  ),
  whatIf(
    "Era",
    "1950s",
    "In the 1950s",
    "Place the same person in the 1950s: period hair and clothing, a chrome diner or suburban street, saturated vintage color photo.",
  ),
  whatIf(
    "Era",
    "1970s",
    "In the 1970s",
    "Place the same person in the 1970s: period hair and wide-collar clothing, wood-panel interior, warm faded film colors.",
  ),
  whatIf(
    "Era",
    "1980s",
    "In the 1980s",
    "Place the same person in the 1980s: big hair, bold colors and shoulder pads, an arcade or mall backdrop, flash photo look.",
  ),
  whatIf(
    "Era",
    "medieval",
    "In medieval times",
    "Place the same person in medieval times: period costume, a stone castle courtyard, torchlight, painterly realism.",
  ),
  whatIf(
    "Era",
    "ancient",
    "In ancient times",
    "Place the same person in the ancient Mediterranean world: draped linen robes, marble columns and bright sun.",
  ),
  whatIf(
    "Era",
    "future",
    "In the year 3000",
    "Place the same person in a far future: sleek tech clothing, holographic displays and a glowing city skyline behind them.",
  ),
  // Role & world
  whatIf(
    "Role",
    "astronaut",
    "As an astronaut",
    "Show the same person as an astronaut in a white spacesuit with the helmet off, on a space station with Earth in the window.",
  ),
  whatIf(
    "Role",
    "royalty",
    "As royalty",
    "Show the same person as a monarch wearing a crown, an ermine-trimmed robe and jewels, seated on a throne in a grand hall.",
  ),
  whatIf(
    "Role",
    "superhero",
    "As a superhero",
    "Show the same person as an original superhero with a sleek custom suit and cape, standing on a rooftop at sunset.",
    "Keep their face and identity recognizable; no existing characters or logos.",
  ),
  whatIf(
    "Role",
    "knight",
    "As a knight",
    "Show the same person as a knight in polished plate armor holding a helmet, a banner-lined castle behind them.",
  ),
  whatIf(
    "Role",
    "wizard",
    "As a wizard",
    "Show the same person as a wizard in flowing robes holding a glowing staff, in a candlelit library of floating books.",
  ),
  whatIf(
    "Role",
    "chef",
    "As a chef",
    "Show the same person as a head chef in whites in a busy professional kitchen, flames rising from a pan.",
  ),
  whatIf(
    "Role",
    "rockstar",
    "As a rock star",
    "Show the same person as a rock star playing guitar on a big stage with smoke and colored stage lights.",
  ),
  whatIf(
    "Role",
    "athlete",
    "As an Olympian",
    "Show the same person as an elite athlete on a podium with a gold medal, stadium lights behind them.",
  ),
  whatIf(
    "Role",
    "pirate",
    "As a pirate",
    "Show the same person as a pirate captain with a tricorn hat and coat on the deck of a ship at sea.",
  ),
  whatIf(
    "Role",
    "elf",
    "As a fantasy elf",
    "Show the same person as a fantasy elf with pointed ears, elegant woven clothes and a glowing forest behind them.",
  ),
  whatIf(
    "Role",
    "opposite_gender",
    "Gender swapped",
    "Show the person as the opposite gender, with matching hairstyle changes and outfit adapted, in the same pose and setting.",
    "Keep the family resemblance clear, same eyes, skin tone and expression.",
  ),
];

const casting = (
  group: string,
  id: string,
  label: string,
  look: string,
): TemplatePreset => ({
  id,
  label,
  group,
  prompt: `Turn this into a commercial casting photo of the same person: ${look} Natural retouching with real skin texture, sharp eyes. Keep their face, identity and body type unchanged.`,
});

/** Commercial-casting looks: advertising archetypes on top of the headshot. */
export const COMMERCIAL_FACE_PRESETS: TemplatePreset[] = [
  // Lifestyle
  casting(
    "Lifestyle",
    "young_parent",
    "Young parent",
    "a warm, relaxed smile, casual knit sweater, bright family kitchen in soft morning light, framed for a home-goods ad.",
  ),
  casting(
    "Lifestyle",
    "fitness",
    "Fitness",
    "athletic wear, a light sheen of sweat, a determined look, a modern gym with window light, framed for a sportswear ad.",
  ),
  casting(
    "Lifestyle",
    "outdoors",
    "Outdoor adventurer",
    "a technical jacket, wind in the hair, a mountain lake behind, golden light, framed for an outdoor-gear ad.",
  ),
  casting(
    "Lifestyle",
    "coffee",
    "Coffee break",
    "holding a ceramic mug, cozy cafe window seat, soft daylight, a candid laugh, framed for a cafe ad.",
  ),
  casting(
    "Lifestyle",
    "traveler",
    "Traveler",
    "a light linen outfit and a carry-on bag, a bright airport terminal or train platform, framed for a travel ad.",
  ),
  casting(
    "Lifestyle",
    "gen_z",
    "Gen-Z creator",
    "trendy streetwear, a phone in hand, a colorful bedroom studio with ring light, playful expression, framed for an app ad.",
  ),
  casting(
    "Lifestyle",
    "retiree",
    "Active retiree",
    "smart casual clothes, a bright smile, a sunny garden or golf course, framed for a lifestyle or insurance ad.",
  ),
  // Professional
  casting(
    "Professional",
    "doctor",
    "Doctor",
    "a white coat with stethoscope, a calm trustworthy look, a clean modern clinic behind, framed for a healthcare ad.",
  ),
  casting(
    "Professional",
    "tech",
    "Tech worker",
    "a simple t-shirt and overshirt, a laptop on a desk, an airy open-plan office, framed for a software ad.",
  ),
  casting(
    "Professional",
    "executive",
    "Executive",
    "a tailored suit, a confident composed look, a glass office with city view, framed for a finance ad.",
  ),
  casting(
    "Professional",
    "tradesperson",
    "Tradesperson",
    "workwear and a tool belt, a friendly reliable look, a bright workshop, framed for a home-repair ad.",
  ),
  casting(
    "Professional",
    "teacher",
    "Teacher",
    "a cardigan and lanyard, an encouraging smile, a sunny classroom, framed for an education ad.",
  ),
  casting(
    "Professional",
    "barista",
    "Barista",
    "an apron, a friendly look behind an espresso machine, warm cafe light, framed for a hospitality ad.",
  ),
  // Beauty
  casting(
    "Beauty",
    "skincare",
    "Skincare",
    "fresh dewy skin, minimal makeup, hair pulled back, a seamless pale backdrop, soft beauty light, framed tight for a skincare ad.",
  ),
  casting(
    "Beauty",
    "glam",
    "Glam beauty",
    "polished evening makeup, sleek styled hair, dramatic beauty dish lighting, a dark backdrop, framed for a cosmetics ad.",
  ),
  casting(
    "Beauty",
    "haircare",
    "Haircare",
    "glossy voluminous hair in motion, a bright clean backdrop, wind-blown styling, framed for a shampoo ad.",
  ),
  casting(
    "Beauty",
    "fragrance",
    "Fragrance",
    "a moody sensual look, soft shadows, a silk shirt, a smoky dark backdrop, framed for a fragrance ad.",
  ),
  casting(
    "Beauty",
    "dental",
    "Bright smile",
    "a wide natural smile showing clean teeth, a crisp white backdrop, even lighting, framed for an oral-care ad.",
  ),
  // Casting cards
  casting(
    "Casting",
    "comp_card",
    "Comp card",
    "a neutral expression, simple black top, plain grey backdrop, even front light, shoulders-up framing like an agency card.",
  ),
  casting(
    "Casting",
    "theatrical",
    "Theatrical",
    "a moody, character-driven expression, dark backdrop, dramatic side light, shoulders-up framing like an actor's theatrical headshot.",
  ),
  casting(
    "Casting",
    "commercial_smile",
    "Commercial smile",
    "a big genuine smile, bright colorful top, clean light backdrop, high-key lighting, framed like a commercial headshot.",
  ),
  casting(
    "Casting",
    "full_length",
    "Full-length digital",
    "a full-length standing pose, fitted plain clothes, white wall, direct flash, like a model-agency digital.",
  ),
  // Studio setups (lighting and backdrop only; the person stays as they are)
  casting(
    "Studio",
    "white_cyc",
    "White cyc",
    "standing on a seamless white cyclorama, bright even high-key light with no visible edges, clean e-commerce framing.",
  ),
  casting(
    "Studio",
    "grey_seamless",
    "Grey seamless",
    "a mid-grey paper backdrop, one large softbox key at forty-five degrees and a soft fill, waist-up framing for a catalog ad.",
  ),
  casting(
    "Studio",
    "clamshell",
    "Clamshell beauty",
    "clamshell lighting with a beauty dish above and a reflector below, catchlights in both eyes, tight head-and-shoulders framing.",
  ),
  casting(
    "Studio",
    "window_light",
    "Window light",
    "soft north-facing window light from one side, a plain plaster wall behind, natural shadows, framed for an editorial-style ad.",
  ),
  casting(
    "Studio",
    "color_gel",
    "Color backdrop",
    "a bold solid-color paper backdrop in a brand-friendly tone, crisp key light and a subtle rim light, framed for a social ad.",
  ),
  casting(
    "Studio",
    "rim_dark",
    "Low-key rim",
    "a black backdrop, two strip lights carving a rim around the head and shoulders, a gentle frontal fill, framed for a premium ad.",
  ),
];

type WardrobeScope =
  "outfit" | "top" | "outer" | "bottom" | "shoes" | "accessory";

const SCOPE_TEXT: Record<WardrobeScope, string> = {
  outfit:
    "Dress the person in {g}. Change only the clothing; keep their face, hair, body shape, pose, hands, background and lighting exactly the same.",
  top: "Replace only the person's top with {g}. Keep their bottoms, shoes, face, hair, pose, background and lighting exactly the same.",
  outer:
    "Put {g} on the person over their current clothes. Keep the rest of the outfit, their face, hair, pose, background and lighting exactly the same.",
  bottom:
    "Replace only the person's trousers or skirt with {g}. Keep their top, shoes, face, hair, pose, background and lighting exactly the same.",
  shoes:
    "Replace only the person's footwear with {g}. Keep the outfit, face, pose, background and lighting exactly the same.",
  accessory:
    "Add {g} to the person. Keep their outfit, face, hair, pose, background and lighting exactly the same.",
};

const garment = (
  group: string,
  scope: WardrobeScope,
  id: string,
  label: string,
  description: string,
): TemplatePreset => ({
  id,
  label,
  group,
  prompt: `${SCOPE_TEXT[scope].replace("{g}", description)} The fabric drapes and folds realistically for their pose.`,
  fragment: description,
});

/** Text-described wardrobe for the AI Stylist (no garment photo needed). */
export const WARDROBE_PRESETS: TemplatePreset[] = [
  // Full looks
  garment(
    "Full looks",
    "outfit",
    "navy_suit",
    "Navy suit",
    "a tailored navy two-piece suit with a crisp white shirt and brown leather shoes",
  ),
  garment(
    "Full looks",
    "outfit",
    "black_tux",
    "Black tie",
    "a black tuxedo with satin lapels, a white dress shirt and a black bow tie",
  ),
  garment(
    "Full looks",
    "outfit",
    "evening_gown",
    "Evening gown",
    "a floor-length emerald satin evening gown with a draped neckline",
  ),
  garment(
    "Full looks",
    "outfit",
    "little_black_dress",
    "Little black dress",
    "a simple knee-length black cocktail dress with thin straps",
  ),
  garment(
    "Full looks",
    "outfit",
    "summer_linen",
    "Summer linen",
    "a relaxed cream linen shirt and matching wide linen trousers with sandals",
  ),
  garment(
    "Full looks",
    "outfit",
    "streetwear",
    "Streetwear",
    "an oversized graphic-free hoodie, baggy cargo pants and chunky sneakers",
  ),
  garment(
    "Full looks",
    "outfit",
    "athleisure",
    "Athleisure",
    "a matching sage-green sports bra or fitted tee with high-waist leggings and running shoes",
  ),
  garment(
    "Full looks",
    "outfit",
    "smart_casual",
    "Smart casual",
    "a fine-knit polo, chinos and white leather sneakers",
  ),
  garment(
    "Full looks",
    "outfit",
    "boho",
    "Boho",
    "a flowing floral maxi dress with a woven belt and suede ankle boots",
  ),
  garment(
    "Full looks",
    "outfit",
    "preppy",
    "Preppy",
    "a cable-knit sweater over a collared shirt, pleated trousers and loafers",
  ),
  garment(
    "Full looks",
    "outfit",
    "techwear",
    "Techwear",
    "black technical shell jacket, tapered utility trousers with straps and black trail shoes",
  ),
  garment(
    "Full looks",
    "outfit",
    "western",
    "Western",
    "a denim shirt, bootcut jeans, a tooled leather belt and cowboy boots",
  ),
  garment(
    "Full looks",
    "outfit",
    "kimono_robe",
    "Silk robe",
    "a long patterned silk wrap robe tied with a sash",
  ),
  garment(
    "Full looks",
    "outfit",
    "ski",
    "Ski outfit",
    "a bright insulated ski jacket and matching ski pants with goggles pushed up",
  ),
  garment(
    "Full looks",
    "outfit",
    "wedding_white",
    "Bridal white",
    "an elegant white bridal outfit, either a lace gown or a white tailored suit, fitting the person",
  ),
  garment(
    "Full looks",
    "outfit",
    "scrubs",
    "Scrubs",
    "teal medical scrubs and clean white sneakers",
  ),
  // Tops
  garment(
    "Tops",
    "top",
    "white_tee",
    "White tee",
    "a plain heavyweight white crew-neck t-shirt",
  ),
  garment(
    "Tops",
    "top",
    "oxford_shirt",
    "Oxford shirt",
    "a light-blue button-down oxford shirt",
  ),
  garment(
    "Tops",
    "top",
    "turtleneck",
    "Turtleneck",
    "a fitted black merino turtleneck",
  ),
  garment(
    "Tops",
    "top",
    "silk_blouse",
    "Silk blouse",
    "a champagne silk blouse with a soft bow at the neck",
  ),
  garment(
    "Tops",
    "top",
    "knit_sweater",
    "Chunky knit",
    "an oversized oatmeal chunky-knit sweater",
  ),
  garment(
    "Tops",
    "top",
    "hawaiian",
    "Resort shirt",
    "a short-sleeve tropical-print resort shirt",
  ),
  garment(
    "Tops",
    "top",
    "corset_top",
    "Corset top",
    "a structured satin corset top",
  ),
  garment(
    "Tops",
    "top",
    "rugby",
    "Rugby shirt",
    "a striped long-sleeve rugby shirt with a white collar",
  ),
  // Outerwear
  garment(
    "Outerwear",
    "outer",
    "trench",
    "Trench coat",
    "a classic beige double-breasted trench coat",
  ),
  garment(
    "Outerwear",
    "outer",
    "leather_jacket",
    "Leather jacket",
    "a black leather biker jacket with silver zips",
  ),
  garment(
    "Outerwear",
    "outer",
    "denim_jacket",
    "Denim jacket",
    "a faded blue denim trucker jacket",
  ),
  garment(
    "Outerwear",
    "outer",
    "puffer",
    "Puffer",
    "a glossy black cropped puffer jacket",
  ),
  garment(
    "Outerwear",
    "outer",
    "blazer",
    "Blazer",
    "a relaxed camel wool blazer",
  ),
  garment(
    "Outerwear",
    "outer",
    "varsity",
    "Varsity jacket",
    "a green and cream wool varsity jacket with leather sleeves and no lettering",
  ),
  garment(
    "Outerwear",
    "outer",
    "overcoat",
    "Wool overcoat",
    "a long charcoal wool overcoat",
  ),
  garment(
    "Outerwear",
    "outer",
    "fleece",
    "Fleece",
    "a cozy cream sherpa fleece zip jacket",
  ),
  // Bottoms
  garment(
    "Bottoms",
    "bottom",
    "straight_jeans",
    "Straight jeans",
    "mid-blue straight-leg jeans",
  ),
  garment(
    "Bottoms",
    "bottom",
    "wide_trousers",
    "Wide trousers",
    "high-waist wide-leg black tailored trousers",
  ),
  garment(
    "Bottoms",
    "bottom",
    "pleated_skirt",
    "Pleated skirt",
    "a navy pleated midi skirt",
  ),
  garment(
    "Bottoms",
    "bottom",
    "cargo",
    "Cargo pants",
    "olive relaxed cargo pants",
  ),
  garment(
    "Bottoms",
    "bottom",
    "leather_skirt",
    "Leather skirt",
    "a black leather mini skirt",
  ),
  garment(
    "Bottoms",
    "bottom",
    "shorts",
    "Tailored shorts",
    "beige tailored knee-length shorts",
  ),
  // Shoes
  garment(
    "Shoes",
    "shoes",
    "white_sneakers",
    "White sneakers",
    "clean minimal white leather sneakers",
  ),
  garment(
    "Shoes",
    "shoes",
    "chelsea_boots",
    "Chelsea boots",
    "brown suede chelsea boots",
  ),
  garment(
    "Shoes",
    "shoes",
    "heels",
    "Heels",
    "black pointed-toe stiletto heels",
  ),
  garment(
    "Shoes",
    "shoes",
    "loafers",
    "Loafers",
    "polished burgundy penny loafers",
  ),
  garment(
    "Shoes",
    "shoes",
    "combat_boots",
    "Combat boots",
    "black lace-up combat boots",
  ),
  // Accessories
  garment(
    "Accessories",
    "accessory",
    "sunglasses",
    "Sunglasses",
    "black oval acetate sunglasses",
  ),
  garment(
    "Accessories",
    "accessory",
    "fedora",
    "Fedora",
    "a felt fedora hat with a grosgrain band",
  ),
  garment(
    "Accessories",
    "accessory",
    "beanie",
    "Beanie",
    "a ribbed knit beanie",
  ),
  garment(
    "Accessories",
    "accessory",
    "silk_scarf",
    "Silk scarf",
    "a patterned silk scarf tied at the neck",
  ),
  garment(
    "Accessories",
    "accessory",
    "gold_jewelry",
    "Gold jewelry",
    "fine gold hoop earrings and a delicate gold chain necklace",
  ),
  garment(
    "Accessories",
    "accessory",
    "tote",
    "Leather tote",
    "a structured tan leather tote bag on one shoulder, without logos",
  ),
];

/**
 * Fashion Factory: one-click outfit sets over WARDROBE_PRESETS (ids only).
 * Each set reads as one lookbook, at most 8 looks.
 */
export const FASHION_SETS: TemplateSet[] = [
  {
    id: "capsule",
    label: "Capsule wardrobe",
    presetIds: [
      "smart_casual",
      "white_tee",
      "oxford_shirt",
      "knit_sweater",
      "trench",
      "straight_jeans",
      "wide_trousers",
      "white_sneakers",
    ],
  },
  {
    id: "office_week",
    label: "Office week",
    presetIds: [
      "navy_suit",
      "smart_casual",
      "blazer",
      "silk_blouse",
      "turtleneck",
      "overcoat",
    ],
  },
  {
    id: "night_out",
    label: "Night out",
    presetIds: [
      "little_black_dress",
      "black_tux",
      "evening_gown",
      "corset_top",
      "leather_skirt",
      "heels",
    ],
  },
  {
    id: "street_drop",
    label: "Streetwear drop",
    presetIds: [
      "streetwear",
      "techwear",
      "varsity",
      "puffer",
      "cargo",
      "combat_boots",
      "beanie",
    ],
  },
  {
    id: "weekend",
    label: "Weekend",
    presetIds: [
      "athleisure",
      "denim_jacket",
      "rugby",
      "fleece",
      "shorts",
      "white_sneakers",
    ],
  },
  {
    id: "vacation",
    label: "Vacation",
    presetIds: [
      "summer_linen",
      "boho",
      "hawaiian",
      "shorts",
      "sunglasses",
      "fedora",
    ],
  },
  {
    id: "seasons",
    label: "Four seasons",
    presetIds: [
      "summer_linen",
      "trench",
      "puffer",
      "ski",
      "knit_sweater",
      "leather_jacket",
    ],
  },
  {
    id: "runway",
    label: "Runway edit",
    presetIds: [
      "evening_gown",
      "black_tux",
      "kimono_robe",
      "western",
      "preppy",
      "techwear",
      "wedding_white",
      "leather_jacket",
    ],
  },
];
