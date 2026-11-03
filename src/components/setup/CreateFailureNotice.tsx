"use client";

import { Settings2, Wrench, X } from "lucide-react";
import { RunFailureNotice } from "@/components/tools/RunFailureNotice";
import { openSetup } from "@/components/setup/SetupDialog";
import { openSetupTab } from "@/lib/setupNav";
import type { CreateFailure } from "@/lib/create/createFailure";

const actionClass =
  "inline-flex min-h-[36px] items-center gap-1 rounded-lg bg-red-500/15 px-2.5 py-1 text-[12px] font-semibold text-red-700 transition-colors hover:bg-red-500/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:text-red-300";

/** Create's failed-submit notice: plain explanation plus the next step. */
export function CreateFailureNotice({
  failure,
  onDismiss,
}: {
  failure: CreateFailure;
  onDismiss: () => void;
}) {
  const actions = (
    <>
      {failure.action === "setup" && (
        <button
          type="button"
          onClick={openSetup}
          className={actionClass}
          data-testid="create-failure-open-setup"
        >
          <Settings2 className="h-3.5 w-3.5" aria-hidden />
          Open checklist
        </button>
      )}
      {failure.action === "nodes" && (
        <button
          type="button"
          onClick={() => openSetupTab("nodes")}
          className={actionClass}
        >
          <Wrench className="h-3.5 w-3.5" aria-hidden />
          Open node packs
        </button>
      )}
      <button type="button" onClick={onDismiss} className={actionClass}>
        <X className="h-3.5 w-3.5" aria-hidden />
        Dismiss
      </button>
    </>
  );
  return <RunFailureNotice failure={failure} actions={actions} />;
}

export default CreateFailureNotice;
