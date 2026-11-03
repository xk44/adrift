import type { GalleryImage, LoraWeight } from "@/types";

/**
 * "Style DNA" — a compact, shareable fingerprint of the style-defining recipe
 * behind an image (model + style params + LoRAs), separate from its content
 * prompt. Pure/DOM-free so it's unit-testable and reusable across web/native.
 *
 * The DNA intentionally excludes the subject prompt and seed: it captures *how*
 * an image looks (transferable style), not *what* it depicts or its exact roll.
 */

/**
 * Param ids that shape style (as opposed to subject/composition). Keys are the
 * registry's canonical param `id`s (parser stores paramsMap keyed by id), and
 * `flag` uses each param's primary flag form. Kept in sync with
 * lib/oj/registry.json — only style-defining params belong here (subject params
 * like --no, seed, steps, cfg are intentionally excluded).
 */
interface StyleParamDef {
  key: string;
  flag: string;
  label: string;
  /** boolean flag param (registry kind: "flag") — present ⇒ emit flag with no value */
  bool?: boolean;
}

const STYLE_PARAM_KEYS: StyleParamDef[] = [
  { key: "sref", flag: "--sref", label: "Style ref" },
  { key: "sw", flag: "--sw", label: "Style weight" },
  { key: "sv", flag: "--sv", label: "Style engine" },
  { key: "stylize", flag: "--stylize", label: "Stylize" },
  { key: "chaos", flag: "--chaos", label: "Chaos" },
  { key: "weird", flag: "--weird", label: "Weird" },
  { key: "raw", flag: "--raw", label: "Raw", bool: true },
  { key: "version", flag: "--version", label: "Version" },
  { key: "niji", flag: "--niji", label: "Niji", bool: true },
  { key: "profile", flag: "--profile", label: "Profile" },
  { key: "stylization", flag: "--stylization", label: "Krea stylize" },
  {
    key: "minimalism_maximalism",
    flag: "--minimalism-maximalism",
    label: "Krea min/max",
  },
  { key: "ar", flag: "--ar", label: "Aspect" },
];

export interface StyleDNAChip {
  label: string;
  value: string;
  /** flag form for prompt injection, e.g. "--stylize 250"; empty for model/lora */
  flag: string;
}

function formatParamValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const parts = value.map((v) => String(v)).filter(Boolean);
    return parts.length ? parts.join(" ") : null;
  }
  const s = String(value).trim();
  return s.length ? s : null;
}

function loraChips(loras: LoraWeight[] | undefined): StyleDNAChip[] {
  if (!loras || loras.length === 0) return [];
  return loras.map((l) => {
    const strength =
      typeof l.strength === "number"
        ? l.strength.toFixed(2).replace(/\.?0+$/, "")
        : "";
    const name = l.name || "lora";
    return {
      label: "LoRA",
      value: strength ? `${name}@${strength}` : name,
      flag: "",
    };
  });
}

/** Structured chips for display. Order: model → style params → loras. */
export function styleDNAChips(image: GalleryImage): StyleDNAChip[] {
  const chips: StyleDNAChip[] = [];

  if (image.model) {
    chips.push({ label: "Model", value: image.model, flag: "" });
  }

  const params = image.paramsMap ?? {};
  for (const { key, flag, label, bool } of STYLE_PARAM_KEYS) {
    const raw = params[key];
    if (bool) {
      // Flag param: only present-and-truthy counts; emit flag with no value.
      if (raw === true || raw === "true" || raw === 1) {
        chips.push({ label, value: "on", flag });
      }
      continue;
    }
    const formatted = formatParamValue(raw);
    if (formatted) {
      chips.push({ label, value: formatted, flag: `${flag} ${formatted}` });
    }
  }

  chips.push(...loraChips(image.loras));
  return chips;
}

/**
 * One-line DNA string, e.g.
 *   "DNA · flux-dev · --sref 123456 · --stylize 250 · lora:filmgrain@0.6"
 */
export function buildStyleDNA(image: GalleryImage): string {
  const chips = styleDNAChips(image);
  if (chips.length === 0) return "DNA · (no style metadata)";
  const parts = chips.map((c) =>
    c.label === "LoRA" ? `lora:${c.value}` : c.flag || c.value,
  );
  return `DNA · ${parts.join(" · ")}`;
}

/**
 * The param-flag suffix to graft a DNA's style onto a prompt, e.g.
 *   "--sref 123456 --stylize 250"
 * (Model and LoRAs are engine/adapter concerns, not prompt flags, so they're
 * excluded here — only the flags are appended.)
 */
export function styleDNAPromptFlags(image: GalleryImage): string {
  return styleDNAChips(image)
    .filter((c) => c.flag)
    .map((c) => c.flag)
    .join(" ");
}

export function hasStyleDNA(image: GalleryImage): boolean {
  return styleDNAChips(image).length > 0;
}
