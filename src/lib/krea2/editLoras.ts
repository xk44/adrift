/**
 * Krea 2 edit-LoRA registry
 * Edit LoRAs are `LoraLoaderModelOnly` safetensors on Krea-2-Raw, but each is
 * trained for a specific edit *node family* — the file alone doesn't say which,
 * so every entry is tagged with `family` and that selects the workflow:
 *
 *   krea2edit → grounded-encode graph (edit_instruct / edit_structural)
 *   ostris    → Kontext multi-ref graph (edit_ostris)
 *
 * The bundled registry seeds known LoRAs; user-added ones (via
 * /api/krea2-edit-loras/add) are merged in server-side from data/edit-loras.json.
 */

import registry from "./editLoraRegistry.json";
import type { EditLora, EditLoraFamily } from "@/types";

export type { EditLora, EditLoraFamily } from "@/types";

export interface EditFamilyInfo {
  label: string;
  action: string;
  structuralAction?: string;
  nodes: string;
  note: string;
}

interface EditLoraRegistry {
  families: Record<string, EditFamilyInfo>;
  loras: EditLora[];
}

const REGISTRY = registry as EditLoraRegistry;

export function getEditFamilies(): Record<string, EditFamilyInfo> {
  return REGISTRY.families;
}

export function getBuiltinEditLoras(): EditLora[] {
  return REGISTRY.loras;
}

/** The workflow action for a LoRA's family, honoring a structure-lock request. */
export function editActionFor(
  family: EditLoraFamily,
  structural = false,
): string {
  const info = REGISTRY.families[family];
  if (!info) return "edit_instruct";
  if (structural && info.structuralAction) return info.structuralAction;
  return info.action;
}

/** Merge the bundled registry with user-added entries (custom wins on id). */
export function mergeEditLoras(custom: EditLora[] | undefined): EditLora[] {
  const byId = new Map<string, EditLora>();
  for (const l of REGISTRY.loras) byId.set(l.id, l);
  for (const l of custom ?? []) byId.set(l.id, { ...l, custom: true });
  return Array.from(byId.values());
}

/**
 * Move the LoRA with `id` to the front so tools that default to the first
 * installed LoRA of a family pick it (ADRIFT_DEFAULT_EDIT_LORA). Unknown or
 * empty ids leave the bundled order, whose grounded default is Identity Edit
 * v1.2 (Krea 2 Community License; v2 is non-commercial).
 */
export function preferEditLora<T extends { id: string }>(
  loras: T[],
  id: string | undefined,
): T[] {
  const want = id?.trim();
  const idx = want ? loras.findIndex((l) => l.id === want) : -1;
  if (idx <= 0) return loras;
  return [loras[idx], ...loras.slice(0, idx), ...loras.slice(idx + 1)];
}

export function isEditFamily(value: unknown): value is EditLoraFamily {
  return (
    value === "krea2edit" ||
    value === "ostris" ||
    value === "qwen" ||
    value === "krea2inpaint"
  );
}
