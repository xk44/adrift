/**
 * Theme token names shared by tailwind.config.ts and the preset table.
 *
 * Kept free of path aliases and runtime imports: Tailwind's config loader
 * imports this file directly.
 */

/** Keys of the Tailwind `dark.*` neutral scale (bg-dark-800, text-dark-400…). */
export const DARK_SCALE_KEYS = [
  "200",
  "300",
  "400",
  "500",
  "600",
  "700",
  "750",
  "800",
  "850",
  "900",
  "bg",
  "input",
  "primary",
] as const;

/** Keys of the Tailwind `light.*` neutral scale (bg-light-50, text-light-500…). */
export const LIGHT_SCALE_KEYS = [
  "50",
  "100",
  "200",
  "300",
  "400",
  "500",
  "600",
  "700",
  "bg",
  "input",
  "primary",
] as const;

export type DarkScaleKey = (typeof DARK_SCALE_KEYS)[number];
export type LightScaleKey = (typeof LIGHT_SCALE_KEYS)[number];

/**
 * CSS custom property holding a scale step as space-separated RGB channels
 * ("13 14 18"), so Tailwind opacity modifiers (bg-dark-800/50) keep working.
 */
export function scaleVar(scale: "dark" | "light", key: string): string {
  return `--c-${scale}-${key}`;
}

/** Channel variable behind the `splash` accent utilities. */
export const SPLASH_VAR = "--c-splash";

/** Tailwind color value reading a channel variable. */
export function channelColor(varName: string): string {
  return `rgb(var(${varName}) / <alpha-value>)`;
}
