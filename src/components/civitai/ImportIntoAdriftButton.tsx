"use client";

import { Wrench } from "lucide-react";
import type { CivitaiModel, CivitaiSource } from "@/lib/civitai";
import {
  civitaiWorkflowImportUrl,
  isCivitaiWorkflowModel,
} from "@/lib/userTools/registry";
import { useUserToolsStore } from "@/store/userToolsStore";
import { navigateTo } from "@/lib/navUrlSync";

/**
 * Explore card action for Workflows listings: open the Tools page import
 * review with this version. Renders nothing for other model types.
 */
export function ImportIntoAdriftButton({
  model,
  versionId,
  source,
}: {
  model: CivitaiModel;
  versionId?: number;
  source: CivitaiSource;
}) {
  if (!isCivitaiWorkflowModel(model)) return null;
  return (
    <button
      type="button"
      onClick={() => {
        useUserToolsStore
          .getState()
          .requestImport(civitaiWorkflowImportUrl(source, model.id, versionId));
        navigateTo("tools");
      }}
      data-testid="civitai-import-workflow"
      title="Turn this workflow into a tool in Adrift"
      className="flex w-full items-center justify-center gap-1.5 rounded-full bg-splash px-3 py-1.5 text-xs font-semibold text-white transition-[opacity,transform] duration-150 hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-splash focus-visible:ring-offset-2 active:scale-[0.97]"
    >
      <Wrench className="h-3.5 w-3.5" /> Import into Adrift
    </button>
  );
}
