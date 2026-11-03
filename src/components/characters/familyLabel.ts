/** Short display name for a LoRA family group (loraMetadata groups). */
const LABELS: Record<string, string> = {
  sdxl: "SDXL",
  sd15: "SD 1.5",
  sd2: "SD 2",
  sd3: "SD3",
  flux: "Flux",
  flux3: "Flux 2/3",
  krea2: "Krea 2",
  "qwen-image": "Qwen Image",
  ideogram4: "Ideogram 4",
  ltxv: "LTX Video",
  wan: "Wan",
  zimage: "Z-Image",
  minimax: "MiniMax H3",
};

export function familyLabel(group: string | null | undefined): string | null {
  if (!group) return null;
  return LABELS[group] ?? group;
}
