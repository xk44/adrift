/**
 * What the "Add Adrift to ComfyUI" card shows for a GET /api/setup/overlay
 * status. Pure, so it is unit-tested without React.
 */

export interface OverlayInstallStatus {
  comfyLocal: boolean;
  comfyUrl: string;
  customNodesDir: string | null;
  customNodes: boolean;
  installed: "missing" | "linked" | "copy" | "other" | null;
  configUrl: string | null;
  adriftUrl: string | null;
  loaded: boolean | null;
  loadedFrom: string[];
  frameAllowed: boolean;
  remoteSteps: string;
}

export type OverlayInstallView =
  | { kind: "remote"; text: string; steps: string }
  | { kind: "noCustomNodes"; text: string }
  | { kind: "blocked"; text: string }
  | { kind: "install"; text: string }
  | { kind: "restart"; text: string; urlStale: boolean }
  | { kind: "done"; text: string; urlStale: boolean };

export function overlayInstallView(s: OverlayInstallStatus): OverlayInstallView {
  if (!s.comfyLocal)
    return {
      kind: "remote",
      text: `ComfyUI runs on another machine (${s.comfyUrl}). On that machine, do this once:`,
      steps: s.remoteSteps,
    };
  if (!s.customNodes)
    return {
      kind: "noCustomNodes",
      text: `No custom_nodes folder at ${s.customNodesDir ?? "your ComfyUI folder"}. Check the ComfyUI folder in Setup.`,
    };
  if (s.installed === "other")
    return {
      kind: "blocked",
      text: `Something else is already at ${s.customNodesDir}/adrift_overlay. Move it aside, then check again.`,
    };
  if (s.installed === "missing" || s.installed === null)
    return {
      kind: "install",
      text: "Open Adrift right inside ComfyUI with Ctrl+Shift+J. Optional; you can do this later in Settings.",
    };
  const urlStale = !!s.adriftUrl && s.configUrl !== s.adriftUrl;
  if (s.loaded === true)
    return {
      kind: "done",
      text: "Adrift is in ComfyUI. Press Ctrl+Shift+J there (or the corner button).",
      urlStale,
    };
  return {
    kind: "restart",
    text:
      s.loaded === null
        ? "Installed. Start or restart ComfyUI, then check again."
        : "Installed. Restart ComfyUI to load it, then check again.",
    urlStale,
  };
}
