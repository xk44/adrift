"use client";

import { useState, useCallback } from "react";
import { useGenerationStore, useUIStore } from "@/store";
import {
  resolveWorkflowForAction,
  mergeActionAndSlotAssignments,
} from "@/lib/workflowAssignments";
import type { ImagineRun } from "@/types";

interface UseInpaintOptions {
  onSuccess?: (promptId: string) => void;
  onError?: (error: string) => void;
}

interface InpaintResult {
  ok: boolean;
  promptId?: string;
  error?: string;
}

export function useInpaint(options: UseInpaintOptions = {}) {
  const { onSuccess, onError } = options;
  const [isLoading, setIsLoading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const clientId = useGenerationStore((s) => s.clientId);
  const setError = useGenerationStore((s) => s.setError);
  const selectedWorkflowPath = useUIStore((s) => s.selectedWorkflowPath);
  const selectedWorkflowName = useUIStore((s) => s.selectedWorkflowName);
  const defaultWorkflowPath = useUIStore((s) => s.defaultWorkflowPath);
  const defaultWorkflowName = useUIStore((s) => s.defaultWorkflowName);
  const actionWorkflowMap = useUIStore((s) => s.actionWorkflowMap);
  const workflowControlOverrides = useUIStore(
    (s) => s.workflowControlOverrides,
  );

  /**
   * Resolve the effective workflow path for the edit.inpaint slot,
   * falling through: slot assignment → legacy actionWorkflowMap → server
   * default inpaint graph (the Create picker's t2i selection never applies).
   */
  const resolveInpaintWorkflowPath = useCallback((): string | undefined => {
    const assignments = mergeActionAndSlotAssignments(actionWorkflowMap);
    const resolved = resolveWorkflowForAction("edit.inpaint", {
      assignments,
      legacyActionMap: actionWorkflowMap,
      selectedWorkflowPath,
      selectedWorkflowName,
      defaultWorkflowPath,
      defaultWorkflowName,
    });
    return resolved?.workflowPath;
  }, [
    actionWorkflowMap,
    selectedWorkflowPath,
    selectedWorkflowName,
    defaultWorkflowPath,
    defaultWorkflowName,
  ]);

  const inpaint = useCallback(
    async (
      prompt: string,
      sourceImage: string,
      maskDataUrl: string | null,
      seed?: number,
      denoise?: number,
    ): Promise<InpaintResult> => {
      if (!prompt.trim()) {
        const error = "Please enter a prompt";
        setLastError(error);
        onError?.(error);
        return { ok: false, error };
      }

      if (!sourceImage) {
        const error = "No source image provided";
        setLastError(error);
        onError?.(error);
        return { ok: false, error };
      }

      setIsLoading(true);
      setLastError(null);
      setError(null);

      const effectiveWorkflowPath = resolveInpaintWorkflowPath();

      try {
        const response = await fetch("/api/jobs/inpaint", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            client_id: clientId,
            source_image: sourceImage,
            mask_data: maskDataUrl,
            seed,
            denoise: denoise ?? 1.0,
            workflow_path: effectiveWorkflowPath ?? undefined,
            ...(workflowControlOverrides &&
            Object.keys(workflowControlOverrides).length > 0
              ? { workflow_control_overrides: workflowControlOverrides }
              : {}),
          }),
        });

        const data = await response.json();

        if (!data.ok) {
          const error = data.error ?? "Inpaint failed";
          setLastError(error);
          setError(error);
          onError?.(error);
          return { ok: false, error };
        }

        const promptId = data.prompt_id;

        const run: ImagineRun = {
          run_id: data.request_id ?? promptId,
          prompt,
          parsedPrompt: prompt,
          width: 0,
          height: 0,
          jobs: [
            {
              prompt_id: promptId,
              seed: data.seed,
              index: 0,
              status: "queued",
              progress: 0,
              images: [],
            },
          ],
          createdAt: new Date().toISOString(),
          status: "queued",
          params: { denoise: denoise ?? 1.0 },
          action: "inpaint",
        };

        useGenerationStore.getState().addRun(run);

        onSuccess?.(promptId);
        return { ok: true, promptId };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Network error";
        setLastError(message);
        setError(message);
        onError?.(message);
        return { ok: false, error: message };
      } finally {
        setIsLoading(false);
      }
    },
    [
      clientId,
      resolveInpaintWorkflowPath,
      workflowControlOverrides,
      onSuccess,
      onError,
      setError,
    ],
  );

  return {
    inpaint,
    isLoading,
    lastError,
  };
}

export default useInpaint;
