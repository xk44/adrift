import type { Config } from "tailwindcss";
import {
  DARK_SCALE_KEYS,
  LIGHT_SCALE_KEYS,
  SPLASH_VAR,
  channelColor,
  scaleVar,
} from "./src/lib/theme/tokens";

function scalePalette(
  scale: "dark" | "light",
  keys: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    keys.map((k) => [k, channelColor(scaleVar(scale, k))]),
  );
}

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // Dual neutral palettes + accent, as CSS channel variables so every
        // theme preset (src/lib/theme/themes.ts) repaints them and opacity
        // modifiers (bg-dark-800/50) keep working. Defaults == the original hex.
        light: scalePalette("light", LIGHT_SCALE_KEYS),
        dark: scalePalette("dark", DARK_SCALE_KEYS),
        // ── Accent ── ("splash"; Adrift red-orange by default)
        splash: channelColor(SPLASH_VAR),
      },
      fontFamily: {
        sans: [
          "var(--font-sans)",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "var(--font-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      boxShadow: {
        inset: "inset 0 1px 0 rgba(255,255,255,0.05)",
        card: "0 2px 8px rgba(0,0,0,0.3)",
        panel:
          "0 1px 3px rgba(0,0,0,0.06), 0 1px 2px -1px rgba(0,0,0,0.06), 0 2px 4px rgba(0,0,0,0.04)",
        "panel-dark":
          "0 1px 3px rgba(0,0,0,0.3), 0 1px 2px -1px rgba(0,0,0,0.2), 0 2px 4px rgba(0,0,0,0.15)",
      },
      animation: {
        "fade-in": "fadeIn 0.2s ease-out",
        "slide-up": "slideUp 0.3s ease-out",
        "sheet-up": "sheetUp 0.28s cubic-bezier(0.2, 0, 0, 1)",
        "scale-in": "scaleIn 0.2s ease-out",
        "pulse-soft": "pulseSoft 2s ease-in-out infinite",
        "civitai-progress": "civitaiProgress 1.5s ease-in-out infinite",
        "fade-out": "fadeOut 0.25s ease-in forwards",
      },
      keyframes: {
        fadeIn: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        fadeOut: {
          from: { opacity: "1" },
          to: { opacity: "0" },
        },
        sheetUp: {
          from: { opacity: "0", transform: "translateY(16px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        slideUp: {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        scaleIn: {
          from: { opacity: "0", transform: "scale(0.95)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        pulseSoft: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.7" },
        },
        civitaiProgress: {
          "0%": { width: "0%", marginLeft: "0%" },
          "50%": { width: "40%", marginLeft: "30%" },
          "100%": { width: "0%", marginLeft: "100%" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
