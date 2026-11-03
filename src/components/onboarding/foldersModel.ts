/**
 * Pure state for the Folders editor (setup wizard step + Settings card).
 * Client-safe; the server is the authority on paths (lib/paths/*).
 */
import type { DirKey, DirRowView, DirsResponse } from "./api";

export interface FolderMeta {
  label: string;
  help: string;
}

export const FOLDER_META: Record<DirKey, FolderMeta> = {
  comfyRoot: {
    label: "ComfyUI folder",
    help: "Where ComfyUI is installed. Used to start it and to find models and custom nodes.",
  },
  models: {
    label: "Models",
    help: "Checkpoints, LoRAs and the rest. Starter packs and downloads save here. ComfyUI reads another folder only if its extra_model_paths.yaml lists it.",
  },
  input: {
    label: "Input",
    help: "Images and poses you upload for ComfyUI to use.",
  },
  output: {
    label: "Output",
    help: "What ComfyUI renders. Adrift's gallery and cleanup read it from here.",
  },
  data: {
    label: "Adrift library",
    help: "Adrift's own data: database, styles, wildcards, moodboards, edits. To move it, copy the old folder over, then restart Adrift.",
  },
};

export const FOLDER_ORDER: readonly DirKey[] = [
  "comfyRoot",
  "models",
  "input",
  "output",
  "data",
];

/** Rows shown: everything, or just Adrift's own folder without ComfyUI. */
export function visibleFolderKeys(noComfy: boolean): DirKey[] {
  return noComfy ? ["data"] : [...FOLDER_ORDER];
}

export interface FolderRowState {
  key: DirKey;
  /** What the input holds when not on the default. */
  value: string;
  useDefault: boolean;
  locked: boolean;
}

export type FolderRows = Record<DirKey, FolderRowState>;

export function initialFolderRows(resp: DirsResponse): FolderRows {
  const out = {} as FolderRows;
  for (const key of FOLDER_ORDER) {
    const r = resp.dirs.find((d) => d.key === key);
    out[key] = {
      key,
      value: r?.display ?? "",
      useDefault: !r || r.source === "default",
      locked: !!r?.envLocked,
    };
  }
  return out;
}

/** Join a folder and a child name in the folder's own separator style. */
export function joinDir(root: string, name: string): string {
  const win = root.includes("\\") && !root.includes("/");
  const sep = win ? "\\" : "/";
  const trimmed = root.replace(/[\\/]+$/, "");
  return `${trimmed || sep}${trimmed ? sep : ""}${name}`;
}

/**
 * The value a row shows. Locked rows show the env value; default rows of
 * models / input / output follow the ComfyUI folder as it is being edited.
 */
export function folderValue(
  key: DirKey,
  rows: FolderRows,
  resp: DirsResponse,
): string {
  const row = rows[key];
  const view = resp.dirs.find((d) => d.key === key);
  if (row.locked) return view?.display ?? row.value;
  if (!row.useDefault) return row.value;
  if (key === "comfyRoot" || key === "data") return view?.defaultDisplay ?? "";
  const root = folderValue("comfyRoot", rows, resp).trim();
  return root ? joinDir(root, key) : (view?.defaultDisplay ?? "");
}

/**
 * PUT body: null for rows on their default, the typed path otherwise.
 * Locked (env) rows and hidden rows are left out.
 */
export function folderSavePayload(
  rows: FolderRows,
  noComfy: boolean,
): Partial<Record<DirKey, string | null>> {
  const out: Partial<Record<DirKey, string | null>> = {};
  for (const key of visibleFolderKeys(noComfy)) {
    const r = rows[key];
    if (r.locked) continue;
    out[key] = r.useDefault ? null : r.value.trim() || null;
  }
  return out;
}

/** Status shown before any check came back (from the GET payload). */
export function rowView(
  resp: DirsResponse,
  key: DirKey,
): DirRowView | undefined {
  return resp.dirs.find((d) => d.key === key);
}
