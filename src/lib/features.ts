/**
 * Build-time feature switches.
 *
 * STYLE_CODES_ENABLED gates numeric style codes and their catalogs. Style
 * reference by image (`--sref <image URL>`, `--sv 2`), moodboards, style
 * presets and the style-LoRA browser are not affected.
 *
 * The public export flips this to false.
 */
export const STYLE_CODES_ENABLED = false;
