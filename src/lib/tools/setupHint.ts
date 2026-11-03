/**
 * One-line "what's missing" hint for a disabled tool card or runner banner.
 * The availability checks (toolsPage.ts, templates.ts) produce full,
 * actionable sentences; cards only have room for a few words, so this maps
 * those sentences to "Needs X model" style labels. Presentation only: it
 * never decides availability.
 */

/** "diffusion_models/fibo2_edit_turbo_bf16.safetensors" -> "fibo2_edit_turbo_bf16". */
export function prettyModelFile(file: string): string {
  const base = file.replace(/\\/g, "/").split("/").pop() ?? file;
  return base.replace(/\.(safetensors|ckpt|pt|pth|bin|gguf|onnx)$/i, "");
}

/** Drop the " · open weights" style suffixes the hub adds to model lines. */
function cleanModel(model: string | null | undefined): string | null {
  const m = model?.split(" · ")[0]?.trim();
  return m ? m : null;
}

function trimPeriod(s: string): string {
  return s.trim().replace(/\.$/, "");
}

export function setupHint(
  reason: string | null | undefined,
  model?: string | null,
): string | null {
  const r = reason?.trim();
  if (!r) return null;
  const name = cleanModel(model);

  const missing = r.match(
    /^Model not installed: (.*?)(?: \(\+(\d+) more\))?\. Download/,
  );
  if (missing) {
    const files = missing[1].split(", ").filter(Boolean);
    if (files.length > 0 && files.every((f) => f.startsWith("node:")))
      return "Needs custom nodes";
    if (name) return `Needs ${name} model`;
    const extra = files.length - 1 + Number(missing[2] ?? 0);
    const first = prettyModelFile(files[0] ?? "");
    return first
      ? `Needs ${first}${extra > 0 ? ` +${extra}` : ""}`
      : "Needs a model";
  }

  const lora = r.match(/^LoRA not installed(?:: ([^,.]+))?/);
  if (lora) return lora[1] ? `Needs ${lora[1]} LoRA` : "Needs a LoRA";
  if (/edit LoRA/i.test(r) && /^(Needs|No)\b/.test(r))
    return "Needs an edit LoRA";

  const pack = r.match(/^The (.+?) pack isn't installed/);
  if (pack) return `Needs the ${pack[1]} pack`;
  if (/^No text-to-image pack/.test(r)) return "Needs an image pack";

  const nodes = r.match(/^Needs (?:ComfyUI )?custom nodes[\s:(]+([^:),]+)/);
  if (nodes) return `Needs ${nodes[1].trim()} nodes`;

  const base = r.match(/^(.+?) base model or workflow is not installed/);
  if (base) return `Needs ${base[1]} model`;

  const oneOf = r.match(/^Needs one of: ([^,(]+)/);
  if (oneOf) return `Needs ${oneOf[1].trim()} model`;

  const engine = r.match(/^(.+?) (?:isn't installed|tool isn't listed)/);
  if (engine) return `Needs ${engine[1]} model`;

  if (/^Couldn't check/.test(r)) return "Couldn't check models";
  if (/^Not set up on this server/.test(r)) return "Not set up yet";

  if (r.length <= 36) return trimPeriod(r);
  return name ? `Needs ${name}` : "Needs setup";
}
