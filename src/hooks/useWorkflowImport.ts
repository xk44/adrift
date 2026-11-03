"use client";

import { useCallback } from "react";
import { useUIStore } from "@/store";
import { useOverlayStore } from "@/store/overlayStore";
import { readImportFile } from "@/lib/pngMeta";
import { showToast } from "@/components/Toast";

/**
 * Import a PNG (tEXt "cj"/"workflow"/"prompt" chunks) or .json workflow.
 * cj chunk -> restore the prompt (flags carry pack/sref/aspect/seed);
 * otherwise load the graph as a custom (overlay) workflow.
 */
export function useWorkflowImport() {
  const setPromptValue = useUIStore((s) => s.setPromptValue);
  const setSelectedWorkflow = useUIStore((s) => s.setSelectedWorkflow);
  const setOverlayWorkflow = useOverlayStore((s) => s.setOverlayWorkflow);

  return useCallback(
    async (file: File): Promise<boolean> => {
      try {
        const meta = await readImportFile(file);
        if (meta.kind === "cj" && meta.promptText) {
          setPromptValue(meta.promptText);
          showToast("Restored Adrift params from image", "success");
          return true;
        }
        const graph = meta.kind === "none" ? undefined : meta.workflow;
        if (graph) {
          const name = file.name.replace(/\.(png|json)$/i, "") || "Imported";
          setOverlayWorkflow(graph, name);
          setSelectedWorkflow(`__overlay__/${name}`, name);
          showToast(`Loaded workflow "${name}"`, "success");
          return true;
        }
        showToast("No workflow metadata found in file", "error");
      } catch {
        showToast("Could not read workflow from file", "error");
      }
      return false;
    },
    [setPromptValue, setSelectedWorkflow, setOverlayWorkflow],
  );
}
