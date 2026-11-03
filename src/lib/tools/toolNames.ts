/**
 * One display name per tool, app-wide.
 *
 * Canonical titles are the Tools page's names (Expand,
 * Face Swap, Object Remover, ...). Every surface that names a tool reads it
 * from here: Tools page cards (hub.ts), the lightbox Tools panel and action
 * tooltips, quick edit, and the "made with" provenance chips / Create
 * filter (runProvenance.ts). Older names (registry labels, action-spec
 * titles, lightbox row names like "Zoom out" / "Pan" / "Head swap") stay as
 * aliases so search still finds them.
 *
 * Display only: keys are the existing Tools-page card keys ("action:<id>",
 * "catalog:<id>") or, for lightbox-only operations, "inline:<id>" /
 * "lightbox:<id>". Tool ids, action ids, URL params and stored run params
 * are unchanged.
 *
 * Pure data + lookups, no imports from toolsPage/hub (no import cycles).
 */

import registryJson from "./editToolRegistry.json";

export interface ToolName {
  /** Canonical display title. */
  title: string;
  /** Former / alternate names and search terms. */
  aliases: readonly string[];
}

export const TOOL_NAMES: Readonly<Record<string, ToolName>> = {
  "action:edit_photo": {
    title: "Edit with LoRA",
    aliases: ["edit", "Edit photo"],
  },
  "action:edit_qwen21": { title: "Edit (Qwen 2.1)", aliases: [] },
  "action:edit_flux3": { title: "Edit (FLUX.3)", aliases: [] },
  "action:edit_fibo": { title: "FIBO 2.0 Edit", aliases: ["fibo", "bria"] },
  "action:remove_object": {
    title: "Object Remover",
    aliases: ["erase", "eraser", "magic eraser", "remove", "Remove object"],
  },
  "action:restyle_locked": { title: "Restyle", aliases: ["style"] },
  "action:replace_person": {
    title: "Character Swap (photo)",
    aliases: ["swap", "person", "Replace person"],
  },
  "action:pose_character": {
    title: "Pose character",
    aliases: ["pose", "pose transfer", "pose studio", "character pose"],
  },
  "action:bg_remove": {
    title: "Background Remover",
    aliases: ["cutout", "transparent", "Remove background"],
  },
  "action:upscale": { title: "Upscale", aliases: [] },
  "action:enhance_faces": {
    title: "Face Enhancer",
    aliases: [
      "face",
      "detail",
      "Enhance faces",
      "Face & hands fix",
      "adetailer",
      "auto refine",
      "hands",
    ],
  },
  "action:animate": {
    title: "Image to Video",
    aliases: ["animate", "i2v", "Animate image"],
  },
  "action:make_3d_trellis": {
    title: "3D Model",
    aliases: ["3d", "mesh", "glb", "trellis", "pixal3d", "Make 3D"],
  },
  "action:image_to_splat": {
    title: "3D Splat",
    aliases: [
      "3d",
      "splat",
      "gaussian splat",
      "ply",
      "spz",
      "triposplat",
      "Image to 3D",
    ],
  },
  "action:body_3d": {
    title: "Body 3D",
    aliases: [
      "3d",
      "body",
      "pose",
      "mocap",
      "skeleton",
      "bvh",
      "sam 3d body",
    ],
  },
  "action:moge_geometry": {
    title: "Depth & Normals",
    aliases: [
      "depth map",
      "depth",
      "normal map",
      "normals",
      "point map",
      "point cloud",
      "fov",
      "field of view",
      "geometry",
      "moge",
      "moge-3",
      "3d from photo",
      "panorama depth",
    ],
  },
  "action:material_maps": {
    title: "Material Maps",
    aliases: [
      "material map",
      "pbr",
      "pbr maps",
      "albedo",
      "albedo map",
      "base color",
      "texture maps",
      "marigold",
    ],
  },
  "action:body_3d_video": {
    title: "Body 3D from Video",
    aliases: [
      "3d",
      "body",
      "motion capture",
      "mocap",
      "pose tracking",
      "bvh",
      "sam 3d body",
    ],
  },
  "action:make_3d": {
    title: "3D Model (legacy)",
    aliases: ["3d", "mesh", "legacy", "Make 3D (legacy)"],
  },
  "action:music": {
    title: "Music Generator",
    aliases: ["music", "song", "lyrics", "instrumental", "Make music"],
  },
  "action:sfx": {
    title: "Sound Effects",
    aliases: ["sfx", "sound", "foley", "ambience", "Sound effect"],
  },
  "action:sa3_t2a": {
    title: "Music & Sound",
    aliases: ["stable audio", "music", "sound", "ambience", "text to audio"],
  },
  "action:sa3_a2a": {
    title: "Restyle Audio",
    aliases: ["audio to audio", "remix", "style transfer", "restyle"],
  },
  "action:sa3_inpaint": {
    title: "Fix a Section",
    aliases: ["audio inpaint", "repair", "replace part", "fix audio"],
  },
  "action:sa3_extend": {
    title: "Extend Audio",
    aliases: ["continue", "longer", "outpaint audio", "extend"],
  },
  "action:face_swap": {
    title: "Recast (Video Face Swap)",
    aliases: ["face swap", "video", "recast", "Swap face in video"],
  },
  "action:character_swap": {
    title: "Character Swap",
    aliases: [
      "swap a character in a video",
      "recast",
      "replace",
      "actor",
      "video",
      "Character swap in video",
    ],
  },
  "action:wan_animate": {
    title: "Animate Character",
    aliases: [
      "motion transfer",
      "character swap",
      "replace in video",
      "dance",
      "puppet",
      "video",
    ],
  },
  "action:talking_avatar": {
    title: "Talking Avatar",
    aliases: [
      "speak",
      "avatar",
      "sing",
      "singing photo",
      "talking photo",
      "audio to video",
    ],
  },
  "action:lipsync": {
    title: "Lipsync",
    aliases: [
      "talking photo",
      "talking head",
      "lip sync",
      "speech",
      "voice",
      "Lipsync / talking photo",
    ],
  },
  "action:video_lipsync": {
    title: "Video Lipsync",
    aliases: [
      "lip sync video",
      "redub",
      "dub",
      "replace dialogue",
      "sync lips",
      "Lipsync onto video",
    ],
  },
  "special:dub_video": {
    title: "Video Translator",
    aliases: [
      "Dub Video",
      "translate",
      "dubbing",
      "localize",
      "language",
      "translate video",
      "video translation",
    ],
  },
  "action:orbit_360": {
    title: "Bullet Time 360",
    aliases: ["orbit", "360", "360 orbit video", "3d rotation", "product spin"],
  },
  "action:camera_move": {
    title: "Camera Moves",
    aliases: [
      "zoom",
      "dolly",
      "crane",
      "whip pan",
      "rack focus",
      "timelapse",
      "dolly zoom",
      "earth zoom out",
      "Camera move video",
    ],
  },
  "action:transition": {
    title: "Transitions",
    aliases: [
      "first last frame",
      "morph",
      "smoke transition",
      "flame transition",
      "portal transition",
      "Transition",
    ],
  },
  "action:ref_video": {
    title: "Reference to Video",
    aliases: ["r2v", "ref2v", "characters to video", "cast", "MiniMax H3"],
  },
  "action:multiframe_ref": {
    title: "Multiframe Reference",
    aliases: [
      "keyframes",
      "multi-frame",
      "multiframe",
      "keyframe to video",
      "storyboard frames",
      "MiniMax H3",
    ],
  },
  "action:h3_charsheet": {
    title: "H3 Character Sheet",
    aliases: [
      "character sheet",
      "turnaround",
      "model sheet",
      "character views",
      "reference sheet",
      "MiniMax H3",
    ],
  },
  "action:ltx25_animate": {
    title: "Animate (LTX-2.5)",
    aliases: ["ltx", "ltx-2.5", "image to video", "audio"],
  },
  "action:ltx25_transition": {
    title: "Transitions (LTX-2.5)",
    aliases: [
      "ltx",
      "ltx-2.5",
      "first last frame",
      "audio",
      "Transition (LTX-2.5)",
    ],
  },
  "action:wan_motion": {
    title: "Motion Presets",
    aliases: [
      "effects",
      "orbit",
      "crash zoom",
      "squish",
      "explode",
      "inflate",
      "cakeify",
      "viral",
      "ugc",
      "commercial",
      "angel wings",
    ],
  },
  "action:wan_camera": {
    title: "Camera Control",
    aliases: ["pan", "tilt", "zoom", "roll", "camera path"],
  },
  "action:wan_move": {
    title: "Trajectory Motion",
    aliases: [
      "motion path",
      "trajectory",
      "drag",
      "move object",
      "swirl",
      "draw to video",
      "motion brush",
    ],
  },
  "action:character_swap_full": {
    title: "Character Swap (full re-render)",
    aliases: ["full re-render", "Character swap in video (full re-render)"],
  },
  "action:cast_swap": {
    title: "Recast Several People",
    aliases: [
      "multi person swap",
      "cast swap",
      "roles",
      "recast",
      "replace people",
    ],
  },
  "action:video_bg_swap": {
    title: "Video Background Swap (H3)",
    aliases: [
      "change background",
      "new location",
      "background replace",
      "video background changer",
      "Swap video background (H3)",
    ],
  },
  "action:video_object_add": {
    title: "Add Object to Video",
    aliases: [
      "insert object",
      "place object",
      "add prop",
    ],
  },
  "action:person_remove": {
    title: "Video Person Remover",
    aliases: [
      "erase person",
      "remove people",
      "clean plate",
      "Remove person from video",
    ],
  },
  "action:video_object_remove": {
    title: "Video Object Remover",
    aliases: [
      "erase object",
      "remove object",
      "clean plate",
      "inpaint video",
      "Remove object from video",
    ],
  },
  "action:video_object_swap": {
    title: "Video Object Swap",
    aliases: [
      "replace object",
      "swap object",
      "object swap",
      "genjutsu",
      "reference swap",
      "Swap object in video",
    ],
  },
  "action:video_remove_text": {
    title: "Video Text Remover",
    aliases: [
      "remove subtitles",
      "remove captions",
      "remove watermark",
      "remove logo",
      "Remove text from video",
    ],
  },
  "action:video_bg_change": {
    title: "Video Background Changer",
    aliases: [
      "replace background",
      "virtual background",
      "background blur",
      "Change video background",
    ],
  },
  "action:video_palette": {
    title: "Video Color Palette",
    aliases: [
      "color grade",
      "colour grade",
      "regrade",
      "palette",
      "LUT",
      "color match",
      "Color Palette video",
      "video rehex",
    ],
  },
  "action:crossview": { title: "CrossView", aliases: ["CrossView video"] },
  "action:video_bg_remove": {
    title: "Video Background Remover",
    aliases: ["green screen", "matte", "Remove video background"],
  },
  "action:upscale_seedvr2": {
    title: "SeedVR2 Upscale",
    aliases: [
      "upscale",
      "restore",
      "4k",
      "detail",
      "video",
      "1080p",
      "Upscale (SeedVR2)",
      "Upscale video (SeedVR2)",
    ],
  },
  "action:upscale_vosr2": {
    title: "Photo upscale (VOSR2)",
    aliases: [
      "upscale",
      "VOSR2 Upscale",
      "super resolution",
      "super-resolution",
      "vosr",
      "VOSR 2.0",
    ],
  },
  "action:upscale_video": {
    title: "Video Upscale",
    aliases: [
      "upscale",
      "restore",
      "1080p",
      "4k",
      "per-frame",
      "enhance",
      "Upscale video",
      "Upscale video (SeedVR2)",
    ],
  },
  "action:interpolate": {
    title: "Smooth Motion / Slow-mo",
    aliases: ["interpolate", "slow motion", "fps", "frame rate", "smooth"],
  },
  "action:relight": {
    title: "Relight",
    aliases: [
      "lighting",
      "light",
      "golden hour",
      "neon",
      "studio",
      "light migration",
      "match lighting",
      "light transfer",
    ],
  },
  "action:flashvsr_upscale": {
    title: "Upscale video (FlashVSR)",
    aliases: ["FlashVSR", "video super-resolution", "upscale video"],
  },
  "action:subject_matte": {
    title: "Remove video background (MatAnyone2)",
    aliases: ["MatAnyone", "MatAnyone2", "video matting", "one subject matte"],
  },
  "action:rtx_upscale": {
    title: "Upscale video (NVIDIA RTX)",
    aliases: ["NVIDIA RTX", "RTX Video Super Resolution", "RTX VSR"],
  },
  "action:ltx_upscale_x2": {
    title: "Upscale video (LTX x2)",
    aliases: ["LTX upscaler", "pixel spatial upscaler", "upscale video"],
  },
  "action:light_migration": {
    title: "Relight (match a reference)",
    aliases: ["light migration", "match lighting", "light transfer"],
  },
  "action:vace_restyle": {
    title: "Video Restyle",
    aliases: [
      "style transfer",
      "video to video",
      "v2v",
      "mixed media",
      "relight video",
      "video relight",
      "Restyle video",
    ],
  },
  "action:vace_reframe": {
    // Retired (hidden); Expand video carries its search aliases.
    title: "Video Reframe",
    aliases: ["Reframe video"],
  },
  "action:video_expand": {
    title: "Video Expand",
    aliases: [
      "zoom out video",
      "outpaint video",
      "video outpaint",
      "uncrop",
      "widen",
      "pan",
      "Expand video",
      // From the retired Reframe video card (vace_reframe).
      "aspect ratio",
      "vertical",
      "9:16",
      "reframe",
    ],
  },
  "action:video_retake": {
    title: "Video Retake",
    aliases: [
      "retake",
      "redo shot",
      "regenerate range",
      "regenerate segment",
      "fix a moment",
      "reshoot part",
      "Retake video",
    ],
  },
  "action:vace_extend": {
    title: "Video Extend",
    aliases: ["continue", "longer", "Extend video"],
  },
  "action:shots": {
    title: "Shots",
    aliases: [
      "coverage",
      "camera angles",
      "contact sheet",
      "storyboard",
      "multiple angles",
    ],
  },
  "action:zooms": {
    title: "Zooms",
    aliases: ["zoom ladder", "zoom in", "push in", "close-up", "macro"],
  },
  "action:layers": {
    title: "Edit Layers",
    aliases: [
      "layers",
      "decompose",
      "rgba",
      "transparent",
      "psd",
      "cutout",
      "separate",
    ],
  },
  "action:refocus": {
    title: "Refocus",
    aliases: [
      "focus",
      "depth of field",
      "dof",
      "bokeh",
      "lens blur",
      "background blur",
      "portrait mode",
      "blur background",
    ],
  },
  "action:rack_focus": {
    title: "Rack Focus",
    aliases: [
      "focus pull",
      "pull focus",
      "video bokeh",
      "video depth of field",
      "video lens blur",
    ],
  },
  "action:sdr_to_hdr": {
    title: "SDR to HDR",
    aliases: [
      "hdr",
      "exr",
      "hlg",
      "high dynamic range",
      "inverse tone map",
      "hdr export",
    ],
  },
  "action:vectorize": {
    title: "Vector / SVG",
    aliases: ["svg", "vector", "vectorize", "trace", "logo", "image trace"],
  },
  "action:breakdown": {
    title: "Breakdown",
    aliases: [
      "cutouts",
      "cut out",
      "segment",
      "extract objects",
      "sticker",
      "contact sheet",
    ],
  },
  "action:see_through": {
    title: "Layer Split",
    aliases: [
      "see-through",
      "see through",
      "split layers",
      "character parts",
      "live2d",
      "rigging parts",
      "psd layers",
      "amodal",
      "layer depth",
    ],
  },
  "action:video_edit": {
    title: "Video Edit",
    aliases: [
      "edit video",
      "change outfit",
      "video inpaint",
      "instruct video",
      "v2v",
    ],
  },
  "action:describe": { title: "Describe", aliases: ["caption", "prompt"] },
  "catalog:outpaint": {
    title: "Expand",
    aliases: [
      "outpaint",
      "zoom out",
      "uncrop",
      "Outpaint (fast)",
      "pan",
      "extend",
      "zoom",
    ],
  },
  "catalog:qwen21-restore": { title: "Restore", aliases: [] },
  "catalog:qwen21-camera": {
    title: "Angles",
    aliases: ["camera", "viewpoint", "Camera angle"],
  },
  "catalog:flux3-camera": {
    title: "Angles (FLUX.3)",
    aliases: ["camera", "viewpoint", "Camera angle"],
  },
  "catalog:qwen2511-camera": {
    title: "Angles (Qwen Edit 2511)",
    aliases: [
      "camera",
      "viewpoint",
      "multiple angles",
      "Camera angle (Qwen Edit 2511)",
    ],
  },
  "catalog:qwen21-remove-bg": {
    title: "Background Remover (RGBA)",
    aliases: [
      "cutout",
      "transparent",
      "png",
      "alpha",
      "Remove background (RGBA)",
    ],
  },
  "catalog:qwen21-outfit-swap": {
    title: "Outfit Swap",
    aliases: ["ai stylist", "clothes", "try on"],
  },
  "catalog:qwen21-unblur-background": {
    title: "Unblur Background",
    aliases: [],
  },
  "catalog:krea2-general-edit": {
    title: "Edit",
    aliases: ["instruction", "General edit"],
  },
  // Mask + prompt repaint. "Inpaint" names the family; erasing without a
  // prompt is the Object Remover family below / above.
  "catalog:krea2-inpaint": {
    title: "Inpaint",
    aliases: ["fill", "generative fill", "Inpaint Edit", "repaint"],
  },
  "catalog:krea2-anypaint": {
    title: "Inpaint + Expand",
    aliases: ["AnyPaint", "inpaint", "fill", "grow canvas", "outpaint"],
  },
  "catalog:qwen21-head-swap": { title: "Face Swap", aliases: ["head swap"] },
  "catalog:krea2-head-swap": {
    title: "Face Swap (Krea 2)",
    aliases: ["head swap", "Head swap (Krea 2)"],
  },
  "catalog:qwen21-body-swap": { title: "Body Swap", aliases: [] },
  "catalog:krea2-body-swap": { title: "Body Swap (Krea 2)", aliases: [] },
  "catalog:qwen21-next-scene": {
    title: "What's Next",
    aliases: ["next scene", "story"],
  },
  "catalog:qwen21-remove-box": {
    title: "Object Remover (box)",
    aliases: ["erase", "Remove object"],
  },
  "catalog:qwen2511-remove": {
    title: "Object Remover (text)",
    aliases: ["erase", "Remove object (text)"],
  },
  "catalog:qwen21-doodle": { title: "Doodle In", aliases: ["sketch", "draw"] },
  "catalog:qwen21-anything2real": {
    title: "Anything to Real",
    aliases: ["realistic", "anime to real"],
  },
  "catalog:qwen21-pano360": {
    title: "360 Panorama",
    aliases: ["360° panorama"],
  },
  "catalog:qwen21-character-sheet": {
    title: "Character Sheet",
    aliases: ["turnaround"],
  },
  "catalog:qwen21-realism": {
    title: "Phone-photo Realism",
    aliases: ["realism"],
  },
  "catalog:qwen2511-unblur-upscale": { title: "Unblur", aliases: ["sharpen"] },
  "catalog:flux3-restore": { title: "Restore (FLUX.3)", aliases: ["Restore"] },
  "catalog:flux3-outpaint": { title: "Expand (FLUX.3)", aliases: ["Outpaint"] },
  "catalog:qwen21-outpaint": {
    title: "Expand (Qwen 2.1)",
    aliases: ["Outpaint"],
  },
  "catalog:krea2-outpaint": {
    title: "Expand (Krea 2)",
    aliases: ["Outpaint (fast)"],
  },
  "catalog:moss-restyle-depth": { title: "Restyle from Depth", aliases: [] },
  "catalog:krea2-restyle-depth": {
    title: "Restyle from Depth (Krea 2)",
    aliases: ["Krea 2 restyle from depth"],
  },
  "catalog:krea2-layout-regions": {
    title: "Layout",
    aliases: ["regions", "compose", "Krea 2 layout from region map"],
  },
  "catalog:moss-charref": {
    title: "Character Reference",
    aliases: ["consistent character"],
  },
  "catalog:moss-colorize": { title: "Colorize", aliases: [] },
  "action:voiceover": {
    title: "Voiceover",
    aliases: [
      "tts",
      "text to speech",
      "voice clone",
      "narration",
      "speech",
      "stock voices",
    ],
  },
  "action:add_sound": {
    title: "Add Sound",
    aliases: [
      "sound effects",
      "foley",
      "ambience",
      "video to audio",
      "sfx",
      "Add sound to clip",
    ],
  },
  "action:ltx_restore": {
    title: "Restore video",
    aliases: [
      "restore",
      "old footage",
      "archival",
      "deblur",
      "unblur",
      "decompress",
      "compression artifacts",
      "colorize",
      "colourise",
      "black and white",
      "refine details",
      "sharpen video",
    ],
  },
  "action:ltx_alpha_matte": {
    title: "Alpha Matte",
    aliases: ["ltx vfx", "vfx", "matte", "rotoscope", "roto", "key", "mask"],
  },
  "action:ltx_clean_plate": {
    title: "Clean Plate",
    aliases: ["ltx vfx", "vfx", "remove people", "empty background"],
  },
  "action:ltx_day_to_night": {
    title: "Day to Night",
    aliases: ["ltx vfx", "vfx", "relight", "night"],
  },
  "action:ltx_add_water": {
    title: "Add Water",
    aliases: ["ltx vfx", "vfx", "flood", "rain", "water simulation"],
  },
  "action:ltx_cinemagraph": {
    title: "Cinemagraph",
    aliases: ["ltx vfx", "vfx", "loop", "living photo"],
  },
  "action:ltx_slow_motion": {
    title: "Slow Motion",
    aliases: ["ltx vfx", "vfx", "slowmo", "slow mo", "high speed"],
  },
  "action:ltx_ripple": {
    title: "Ripple Edit",
    aliases: ["ltx vfx", "vfx", "first frame edit", "propagate edit", "ripple"],
  },
  "action:ltx_edge_control": {
    title: "Edge Control",
    aliases: ["ltx vfx", "vfx", "canny", "union control", "restyle video"],
  },
  "action:ltx_blockout_render": {
    title: "Blockout to Render",
    aliases: ["ltx vfx", "vfx", "blockout", "previs", "grey box"],
  },
  "action:ltx_layout_render": {
    title: "Layout to Render",
    aliases: ["ltx vfx", "vfx", "playblast", "greybox", "previs", "3d viewport"],
  },
  "action:ltx_ingredients": {
    title: "Ingredients",
    aliases: ["ltx vfx", "vfx", "reference sheet", "elements to video", "multi reference"],
  },
  "action:ltx_sdr_to_hdr": {
    title: "SDR to HDR (video)",
    aliases: ["ltx vfx", "vfx", "hdr", "hdr video", "hlg", "exr", "aces", "acescg", "inverse tone map"],
  },
  "action:ltx_reshoot": {
    title: "Re-shoot",
    aliases: ["ltx vfx", "vfx", "reshoot", "new angle", "3d angles", "camera angle"],
  },
  "action:ltx_exploded_view": {
    title: "Exploded View",
    aliases: ["ltx vfx", "vfx", "product shot", "teardown", "xpldv"],
  },
  "action:ltx_paint_fluid": {
    title: "Paint Fluid",
    aliases: ["ltx vfx", "vfx", "smoke", "fire", "steam", "fluid"],
  },
  // Lightbox-only operations (no Tools-page card).
  "lightbox:vary": {
    title: "Vary",
    aliases: ["variations", "vary subtle", "vary strong"],
  },
  "inline:detail": {
    title: "Detail",
    aliases: ["refine", "sharpen", "upscale"],
  },
  "inline:realism": {
    title: "Realism",
    aliases: ["photo", "realistic", "refine"],
  },
  "inline:remix": { title: "Remix", aliases: ["reuse"] },
  "inline:reuse": { title: "Reuse", aliases: ["seed", "start frame", "use"] },
};

/** Card key of the single folded outpaint card (toolsPage OUTPAINT_CARD_KEY). */
export const EXPAND_KEY = "catalog:outpaint";

/** Catalog ids of the outpaint backends folded into the Expand card. */
const OUTPAINT_BACKENDS: ReadonlySet<string> = new Set(
  (
    registryJson as { tools: Array<{ id: string; outpaint?: unknown }> }
  ).tools
    .filter((t) => t.outpaint != null)
    .map((t) => t.id),
);

export function toolName(key: string): ToolName | undefined {
  return Object.prototype.hasOwnProperty.call(TOOL_NAMES, key)
    ? TOOL_NAMES[key]
    : undefined;
}

/** Canonical title for a key; `fallback` (or the key) when unmapped. */
export function toolTitle(key: string, fallback?: string): string {
  return toolName(key)?.title ?? fallback ?? key;
}

export function toolAliases(key: string): readonly string[] {
  return toolName(key)?.aliases ?? [];
}

/**
 * Card key that names a catalog (edit-tool registry) tool. Outpaint backends
 * fold into the single Expand card, so their runs read "Expand" too.
 */
export function catalogNameKey(id: string): string {
  return OUTPAINT_BACKENDS.has(id) ? EXPAND_KEY : `catalog:${id}`;
}

/** Canonical title for a catalog tool id (undefined when unmapped). */
export function catalogToolTitle(id: string): string | undefined {
  return toolName(catalogNameKey(id))?.title;
}
