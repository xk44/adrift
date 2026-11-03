"use client";

import { useCallback, useRef, useState } from "react";

export type InstallConfirmPhase = "idle" | "confirming" | "installing" | "result";

export interface InstallConfirmPending {
  workflowId: string;
  workflowName: string;
  packIds: string[];
}

export interface InstallConfirmResult {
  message: string;
  isError: boolean;
}

export interface InstallConfirmState {
  phase: InstallConfirmPhase;
  pending: InstallConfirmPending | null;
  result: InstallConfirmResult | null;
}

/**
 * Manages the non-blocking inline confirmation flow for ComfyUI Manager
 * missing-node pack installs.
 *
 * State machine:
 *   idle → confirming → installing → result → idle
 *                      ↘ idle (cancel)
 *
 * Safety guarantees:
 *  - Only unambiguous (non-empty) packIds are queued.
 *  - The confirming phase shows the exact pack IDs the user is about to queue
 *    so there is no ambiguity about what will be installed.
 *  - No auto-install: the user must explicitly click "Confirm" after reviewing.
 */
export function useInstallConfirmFlow() {
  const [state, setState] = useState<InstallConfirmState>({
    phase: "idle",
    pending: null,
    result: null,
  });

  // Track the current fetch so we can ignore stale responses if the user
  // cancels / re-triggers during an in-flight request.
  const abortRef = useRef<AbortController | null>(null);

  /** Begin the confirmation flow – shows the inline prompt with pack IDs. */
  const requestConfirm = useCallback(
    (workflowId: string, workflowName: string, packIds: string[]) => {
      if (packIds.length === 0) return;
      abortRef.current?.abort();
      setState({
        phase: "confirming",
        pending: { workflowId, workflowName, packIds },
        result: null,
      });
    },
    [],
  );

  const cancelConfirm = useCallback(() => {
    abortRef.current?.abort();
    setState({ phase: "idle", pending: null, result: null });
  }, []);

  /** Execute the install after user confirms. Queues tasks via the API. */
  const executeInstall = useCallback(async () => {
    const { pending } = state as InstallConfirmState & { phase: "confirming" };
    if (!pending) return;

    const { packIds } = pending;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState((prev) =>
      prev.phase === "confirming"
        ? { ...prev, phase: "installing" }
        : prev,
    );

    try {
      const response = await fetch("/api/comfy/workflows/missing-nodes/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packIds }),
        signal: controller.signal,
      });
      const data = await response.json();

      if (controller.signal.aborted) return; // stale

      if (!response.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      const queued = Array.isArray(data.queued) ? data.queued.length : 0;
      const failed = Array.isArray(data.failed) ? data.failed.length : 0;
      setState({
        phase: "result",
        pending: null,
        result: {
          message: `Queued ${queued} missing-node install task${queued === 1 ? "" : "s"}${failed ? `; ${failed} failed to queue` : ""}. Restart ComfyUI after Manager finishes.`,
          isError: false,
        },
      });
    } catch (err) {
      if (controller.signal.aborted) return; // cancelled
      setState({
        phase: "result",
        pending: null,
        result: {
          message:
            err instanceof Error ? err.message : "Failed to queue install tasks",
          isError: true,
        },
      });
    }
  }, [state]);

  const dismissResult = useCallback(() => {
    setState({ phase: "idle", pending: null, result: null });
  }, []);

  return {
    state,
    requestConfirm,
    cancelConfirm,
    executeInstall,
    dismissResult,
  };
}

/** Build the confirmation prompt text shown in the inline banner. */
export function buildConfirmPromptText(
  packIds: string[],
  workflowName: string,
): string {
  const label =
    packIds.length === 1 ? "1 pack" : `${packIds.length} packs`;
  return `Queue ${label} for ${workflowName}? ${packIds.join(", ")}`;
}

export function buildResultMessage(
  queued: number,
  failed: number,
): string {
  const base = `Queued ${queued} missing-node install task${queued === 1 ? "" : "s"}`;
  const suffix = failed > 0 ? `; ${failed} failed to queue` : "";
  return `${base}${suffix}. Restart ComfyUI after Manager finishes.`;
}