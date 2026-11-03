/**
 * useImagine - Hook for image generation
 * Handles prompt submission, API calls, and run tracking
 */

"use client";

import { useCallback, useRef, useState } from "react";
import { useGenerationStore, useUIStore, selectSettingsString } from "@/store";
import { useOverlayStore } from "@/store/overlayStore";
import { useModelStore } from "@/store/modelStore";
import {
  resolveWorkflowForAction,
  imagineWorkflowPathForPrompt,
  mergeActionAndSlotAssignments,
  routeSlotWorkflowPath,
} from "@/lib/workflowAssignments";
import type {
  ImagineRun,
  GalleryImage,
  ErrorCategory,
  ImageAttachment,
} from "@/types";
import { v4 as uuidv4 } from "uuid";
import { historyTexts } from "@/lib/comfy/outputs";
import { buildGalleryParamChips } from "@/lib/galleryParams";
import { galleryTileCount } from "@/lib/galleryMedia";
import {
  createRequestSequence,
  isAbortError,
} from "@/lib/util/requestSequence";
import { layoutBoxesBody } from "@/lib/mossLayoutUi";
import {
  classifyCreateException,
  classifyCreateResponse,
  type CreateFailure,
} from "@/lib/create/createFailure";
import { expandDynamicPrompt } from "@/lib/oj/dynamicPrompts";
import { speedTierFlag } from "@/lib/oj/speedTier";
import { videoBatchFlag } from "@/lib/oj/videoDefault";
import { graphControlFlagsFromSettings } from "@/lib/oj/graphControls";
import {
  noteSubmittedPack,
  runSubmitMemoryGuard,
} from "@/lib/comfy/memoryClient";
import { showToast } from "@/components/Toast";
import { useCharacterLoraStore } from "@/store/characterLoraStore";
import { promptHasOwnLora } from "@/lib/characters/characterLoras";

/** Read a File as a base64 data: URL (server-ingestable, unlike a blob: URL). */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

/**
 * Prepare image attachments for the JSON request body: drop the non-serializable
 * File and, when the url is a local blob: URL, replace it with a data: URL so the
 * server can fetch the bytes (needed for --sv2 style-reference upload, etc.).
 */
async function attachmentsForUpload(
  attachments: ImageAttachment[],
): Promise<ImageAttachment[]> {
  return Promise.all(
    attachments.map(async (a) => {
      const { file, ...rest } = a;
      if (file && a.url.startsWith("blob:")) {
        try {
          return { ...rest, url: await fileToDataUrl(file) };
        } catch {
          return rest; // fall back to the (dead) blob url rather than break submit
        }
      }
      return rest;
    }),
  );
}

interface UseImagineOptions {
  onSuccess?: (runs: ImagineRun[]) => void;
  onError?: (error: string) => void;
}

interface ImagineResult {
  ok: boolean;
  runs?: ImagineRun[];
  error?: string;
  errorCategory?: ErrorCategory;
  warnings?: { unknownFlags?: string[]; nodes?: string[] };
}

export function useImagine(options: UseImagineOptions = {}) {
  const { onSuccess, onError } = options;

  const [isLoading, setIsLoading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  // lastError explained (title, plain message, next step) for Create's notice.
  const [lastFailure, setLastFailure] = useState<CreateFailure | null>(null);
  const requestSequenceRef = useRef(createRequestSequence());

  const clientId = useGenerationStore((s) => s.clientId);
  const addRun = useGenerationStore((s) => s.addRun);
  const addToGallery = useGenerationStore((s) => s.addToGallery);
  const addToPromptHistory = useGenerationStore((s) => s.addToPromptHistory);
  const setError = useGenerationStore((s) => s.setError);
  const addError = useGenerationStore((s) => s.addError);
  const setJobImages = useGenerationStore((s) => s.setJobImages);
  const wsConnected = useGenerationStore((s) => s.wsConnected);

  const promptValue = useUIStore((s) => s.promptValue);
  const settings = useUIStore((s) => s.settings);
  const selectedWorkflowPath = useUIStore((s) => s.selectedWorkflowPath);
  const selectedWorkflowName = useUIStore((s) => s.selectedWorkflowName);
  const defaultWorkflowPath = useUIStore((s) => s.defaultWorkflowPath);
  const defaultWorkflowName = useUIStore((s) => s.defaultWorkflowName);
  const actionWorkflowMap = useUIStore((s) => s.actionWorkflowMap);
  const workflowControlOverrides = useUIStore(
    (s) => s.workflowControlOverrides,
  );
  const mossLayoutBoxes = useUIStore((s) => s.mossLayoutBoxes);
  const imageAttachments = useUIStore((s) => s.imageAttachments);
  const setPromptValue = useUIStore((s) => s.setPromptValue);
  const setIsGenerating = useUIStore((s) => s.setIsGenerating);
  const resolveAlias = useModelStore((s) => s.resolveAlias);
  const defaultModel = useModelStore((s) => s.defaultModel);
  const defaultVae = useModelStore((s) => s.defaultVae);
  const defaultLoras = useModelStore((s) => s.defaultLoras);

  /**
   * Resolve the effective workflow path for the promptbar.imagine slot,
   * falling through: slot assignment → legacy actionWorkflowMap →
   * selectedWorkflowPath → defaultWorkflowPath.
   */
  const resolveImagineWorkflowPath = useCallback((): string | undefined => {
    const assignments = mergeActionAndSlotAssignments(actionWorkflowMap);
    const resolved = resolveWorkflowForAction("promptbar.imagine", {
      assignments,
      selectedWorkflowPath,
      selectedWorkflowName,
      defaultWorkflowPath,
      defaultWorkflowName,
    });
    return resolved?.workflowPath ?? selectedWorkflowPath ?? undefined;
  }, [
    actionWorkflowMap,
    selectedWorkflowPath,
    selectedWorkflowName,
    defaultWorkflowPath,
    defaultWorkflowName,
  ]);

  /** Graph assigned to a routing flag's slot (--audio → Text to Audio). */
  const resolveRouteSlotPath = useCallback(
    (prompt: string): string | undefined =>
      routeSlotWorkflowPath(
        prompt,
        mergeActionAndSlotAssignments(actionWorkflowMap),
      ),
    [actionWorkflowMap],
  );

  const buildPrompt = useCallback(
    (rawBasePrompt: string): string => {
      // Expand {a|b|c} dynamic-prompt / wildcard syntax exactly once per
      // generation, on the clean (unparsed) prompt text, before any
      // settings-derived --flags are appended below. This is a pure
      // brace/pipe transform so it can't touch prompt --flags or ComfyUI
      // (weight:1.2)/[bracket] attention syntax.
      //
      // Exception: `--grid` (XYZ-plot) mode leaves the braces intact so the
      // engine can expand them combinatorially into one job per combination.
      const gridMode = /(^|\s)--grid(\s|$)/.test(rawBasePrompt);
      const basePrompt = gridMode
        ? rawBasePrompt
        : expandDynamicPrompt(rawBasePrompt);
      const parts: string[] = [basePrompt.trim()];

      // Add settings that aren't in the prompt already
      if (
        settings.aspect !== "1:1" &&
        !basePrompt.includes("--ar") &&
        !basePrompt.includes("--aspect")
      ) {
        parts.push(`--ar ${settings.aspect}`);
      }
      if (
        settings.stylize !== 100 &&
        !basePrompt.includes("--stylize") &&
        !basePrompt.includes("--s ")
      ) {
        parts.push(`--stylize ${settings.stylize}`);
      }
      if (
        settings.chaos > 0 &&
        !basePrompt.includes("--chaos") &&
        !basePrompt.includes("--c ")
      ) {
        parts.push(`--chaos ${settings.chaos}`);
      }
      if (settings.modelMode === "Raw" && !basePrompt.includes("--raw")) {
        parts.push("--raw");
      }
      if (
        settings.quality !== 1 &&
        !basePrompt.includes("--quality") &&
        !basePrompt.includes("--q ")
      ) {
        parts.push(`--quality ${settings.quality}`);
      }
      // Speed tier (Draft / Quality); a typed --tier or --steps wins.
      const tierFlag = speedTierFlag(settings.speed);
      if (
        tierFlag &&
        !basePrompt.includes("--tier") &&
        !basePrompt.includes("--steps") &&
        !settings.steps
      ) {
        parts.push(tierFlag);
      }
      // Engine versions (Z-Image Turbo / Ideogram 4 / Krea 2) bake their own
      // models — don't let the user's default checkpoint/VAE leak into them.
      // Explicit settings.model still applies (Krea variant selection).
      const engineManaged =
        settings.modelVersion !== "custom" && settings.modelVersion !== "v7";
      const resolvedModel = settings.model
        ? (resolveAlias(settings.model, "checkpoint") ?? settings.model)
        : defaultModel && !engineManaged
          ? (resolveAlias(defaultModel, "checkpoint") ?? defaultModel)
          : undefined;
      const resolvedVae = settings.vae
        ? (resolveAlias(settings.vae, "vae") ?? settings.vae)
        : defaultVae && !engineManaged
          ? (resolveAlias(defaultVae, "vae") ?? defaultVae)
          : undefined;
      const resolvedLoras = (
        settings.loras && settings.loras.length > 0
          ? settings.loras
          : defaultLoras
      ).map((l) => ({
        ...l,
        name: resolveAlias(l.name, "lora") ?? l.name,
      }));

      if (
        resolvedModel &&
        !basePrompt.includes("--model") &&
        !basePrompt.includes("--v ")
      ) {
        parts.push(`--model ${resolvedModel}`);
      }
      if (resolvedVae && !basePrompt.includes("--vae")) {
        parts.push(`--vae ${resolvedVae}`);
      }
      // Add LoRAs if set and not in prompt (Character pill flags don't count)
      if (
        resolvedLoras.length > 0 &&
        !promptHasOwnLora(
          basePrompt,
          useCharacterLoraStore.getState().selected.map((c) => c.filename),
        )
      ) {
        // One flag per LoRA: the parser reads `--lora a b` as one name.
        const loraStr = resolvedLoras
          .filter((l) => l.name)
          .map((l) =>
            l.strength === 1.0 ? l.name : `${l.name}::${l.strength}`,
          )
          .map((l) => `--lora ${l}`)
          .join(" ");
        if (loraStr) {
          parts.push(loraStr);
        }
      }
      if (settings.sampler && !basePrompt.includes("--sampler")) {
        parts.push(`--sampler ${settings.sampler}`);
      }
      if (settings.scheduler && !basePrompt.includes("--scheduler")) {
        parts.push(`--scheduler ${settings.scheduler}`);
      }
      if (settings.steps && !basePrompt.includes("--steps")) {
        parts.push(`--steps ${settings.steps}`);
      }
      if (settings.cfg && !basePrompt.includes("--cfg")) {
        parts.push(`--cfg ${settings.cfg}`);
      }
      if (settings.seed !== undefined && !basePrompt.includes("--seed")) {
        parts.push(`--seed ${settings.seed}`);
      }
      if (settings.negative?.trim() && !basePrompt.includes("--no")) {
        parts.push(`--no ${settings.negative.trim()}`);
      }
      // Video variants (--vb); only on --video prompts, typed --vb wins.
      const vbFlag = videoBatchFlag(basePrompt, settings.videoBatch);
      if (vbFlag) parts.push(vbFlag);
      // Advanced: --clipskip / --tiledvae(-off) defaults (prompt flags win)
      parts.push(...graphControlFlagsFromSettings(settings, basePrompt));

      return parts.join(" ");
    },
    [settings, resolveAlias, defaultModel, defaultVae, defaultLoras],
  );

  const imagine = useCallback(
    async (prompt?: string): Promise<ImagineResult> => {
      const inputPrompt = prompt ?? promptValue;

      if (!inputPrompt.trim()) {
        const error = "Please enter a prompt";
        setLastError(error);
        onError?.(error);
        return { ok: false, error };
      }

      const request = requestSequenceRef.current.begin();
      setIsLoading(true);
      setIsGenerating(true);
      setLastError(null);
      setLastFailure(null);
      setError(null);

      let fullPrompt = buildPrompt(inputPrompt);

      // Routing flags (--video, --sref, --3d, …) keep their dedicated server
      // pipelines; a workflow_path would override them with the t2i graph.
      // A loaded overlay graph is explicit user JSON and always wins.
      const resolvedWorkflowPath = resolveImagineWorkflowPath();
      const effectiveWorkflowPath = resolvedWorkflowPath?.startsWith(
        "__overlay__/",
      )
        ? resolvedWorkflowPath
        : (resolveRouteSlotPath(fullPrompt) ??
          imagineWorkflowPathForPrompt(resolvedWorkflowPath, fullPrompt));

      // Resolve overlay workflow JSON when path starts with __overlay__/
      let overlayWorkflowJson: unknown | undefined;
      if (effectiveWorkflowPath?.startsWith("__overlay__/")) {
        // Try sessionStorage first, then overlayStore
        try {
          const stored = sessionStorage.getItem("cj_overlay_workflow_json");
          if (stored) overlayWorkflowJson = JSON.parse(stored);
        } catch {
          /* ignore */
        }
        if (!overlayWorkflowJson) {
          overlayWorkflowJson =
            useOverlayStore.getState().overlayWorkflow ?? undefined;
        }
      }

      try {
        const isKrea2Direct =
          settings.modelVersion === "krea-2-direct" ||
          settings.krea2Backend === "direct";
        // Memory preflight + unload-on-family-switch (local ComfyUI only).
        let guardPackId: string | undefined;
        if (!isKrea2Direct) {
          const guard = await runSubmitMemoryGuard(
            fullPrompt,
            overlayWorkflowJson ? "__overlay__/" : effectiveWorkflowPath,
            settings,
            {
              notify: (m, t) =>
                showToast(m, "info", t === "warning" ? 8000 : 4000),
            },
          );
          if (!guard.proceed) {
            return { ok: false, error: "Cancelled: not enough memory" };
          }
          fullPrompt = guard.prompt;
          guardPackId = guard.packId;
        }
        // Attachments carry a File + a blob: URL that the server can't read.
        // Serialize each file to a data: URL so server-side ingestion (e.g. the
        // --sv2 style-reference upload) has real bytes to work with.
        const uploadAttachments =
          imageAttachments.length > 0
            ? await attachmentsForUpload(imageAttachments)
            : undefined;
        const response = await fetch(
          isKrea2Direct ? "/api/jobs/krea2" : "/api/jobs/imagine",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            signal: request.signal,
            body: JSON.stringify({
              prompt: fullPrompt,
              client_id: clientId,
              batch_size: settings.batchSize ?? 1,
              workflow_path: overlayWorkflowJson
                ? undefined
                : (effectiveWorkflowPath ?? undefined),
              ...(overlayWorkflowJson
                ? { workflow_json: overlayWorkflowJson }
                : {}),
              source_images: uploadAttachments,
              ...(useUIStore.getState().runNext ? { run_next: true } : {}),
              ...(workflowControlOverrides &&
              Object.keys(workflowControlOverrides).length > 0
                ? { workflow_control_overrides: workflowControlOverrides }
                : {}),
              ...layoutBoxesBody(
                mossLayoutBoxes,
                overlayWorkflowJson ? undefined : effectiveWorkflowPath,
                isKrea2Direct,
              ),
            }),
          },
        );

        const data = await response.json();
        if (!request.isCurrent()) {
          return { ok: false, error: "Superseded request" };
        }

        if (!data.ok) {
          const error = data.error ?? "Generation failed";
          const category: ErrorCategory =
            data.errorCategory ??
            (error.includes("workflow")
              ? "workflow"
              : error.includes("queue")
                ? "queue"
                : error.includes("validation")
                  ? "validation"
                  : "unknown");

          console.error(`[useImagine] Error:`, error);
          setLastError(error);
          setLastFailure(classifyCreateResponse(data, response.status));
          setError(error);
          addError({ message: error, category });
          onError?.(error);
          return { ok: false, error, errorCategory: category };
        }

        noteSubmittedPack(guardPackId);
        const runs: ImagineRun[] = data.runs ?? [];
        for (const run of runs) {
          addRun(run);
        }

        if (fullPrompt.trim()) {
          addToPromptHistory(fullPrompt.trim());
        }

        const pollHistoryForPrompt = async (promptId: string, attempt = 0) => {
          try {
            const res = await fetch(`/api/comfy/history/${promptId}`);
            const history = await res.json();
            const hasOutput =
              history.ok &&
              (history.images?.length > 0 ||
                history.videos?.length > 0 ||
                history.meshes?.length > 0 ||
                history.audios?.length > 0);
            if (hasOutput) {
              const urls = (history.images ?? []).map(
                (img: { url: string }) => img.url,
              );
              const videoUrls = (history.videos ?? []).map(
                (v: { url: string }) => v.url,
              );
              const audioUrls = (history.audios ?? []).map(
                (a: { url: string }) => a.url,
              );
              const meshUrls = (history.meshes ?? []).map(
                (m: { url: string }) => m.url,
              );
              setJobImages(promptId, urls, {
                videos: videoUrls.length > 0 ? videoUrls : undefined,
                audios: audioUrls.length > 0 ? audioUrls : undefined,
                meshes: meshUrls.length > 0 ? meshUrls : undefined,
                texts: historyTexts(history),
              });
              return;
            }
          } catch {}

          if (attempt < 8) {
            const delayMs = 250 * Math.pow(2, attempt);
            setTimeout(() => {
              void pollHistoryForPrompt(promptId, attempt + 1);
            }, delayMs);
          }
        };

        for (const run of runs) {
          for (const job of run.jobs) {
            if (!wsConnected && job.prompt_id) {
              void pollHistoryForPrompt(job.prompt_id);
            }
          }
        }

        onSuccess?.(runs);

        // Optional custom nodes the server skipped (e.g. NegPiP missing)
        for (const w of data.warnings?.nodes ?? []) {
          showToast(w, "info", 8000);
        }

        if (data.warnings?.unknownFlags?.length) {
          showToast(
            `Not supported, ignored: ${data.warnings.unknownFlags.join(", ")}`,
            "info",
            8000,
          );
        }

        return {
          ok: true,
          runs,
          warnings: data.warnings,
        };
      } catch (error) {
        if (!request.isCurrent() || isAbortError(error)) {
          return { ok: false, error: "Superseded request" };
        }
        const message =
          error instanceof Error ? error.message : "Network error";
        console.error(`[useImagine] Error:`, error);
        setLastError(message);
        setLastFailure(classifyCreateException(message));
        setError(message);
        addError({ message, category: "network" });
        onError?.(message);
        return { ok: false, error: message, errorCategory: "network" };
      } finally {
        if (request.isCurrent()) {
          setIsLoading(false);
          setIsGenerating(false);
        }
      }
    },
    [
      promptValue,
      clientId,
      buildPrompt,
      resolveImagineWorkflowPath,
      resolveRouteSlotPath,
      imageAttachments,
      workflowControlOverrides,
      mossLayoutBoxes,
      settings.krea2Backend,
      settings.modelVersion,
      settings.batchSize,
      addRun,
      addToPromptHistory,
      setJobImages,
      wsConnected,
      setError,
      addError,
      setIsGenerating,
      onSuccess,
      onError,
    ],
  );

  const submitAndClear = useCallback(async (): Promise<ImagineResult> => {
    const result = await imagine();
    if (result.ok) {
      setPromptValue("");
    }
    return result;
  }, [imagine, setPromptValue]);

  const runToGalleryImages = useCallback((run: ImagineRun): GalleryImage[] => {
    const images: GalleryImage[] = [];

    for (const job of run.jobs) {
      const tiles = galleryTileCount(job);
      if (tiles > 0) {
        for (let i = 0; i < tiles; i++) {
          // Build full prompt with seed for copy functionality
          const fullPromptWithSeed = `${run.parsedPrompt || run.prompt} --seed ${job.seed}`;

          images.push({
            id: uuidv4(),
            url: job.images[i] ?? "",
            prompt: run.prompt,
            fullPrompt: fullPromptWithSeed,
            params: buildGalleryParamChips(run.params, job.seed),
            paramsMap: run.params,
            seed: job.seed,
            createdAt: run.createdAt,
            runId: run.run_id,
            jobIndex: job.index,
            width: run.width,
            height: run.height,
            model: run.model,
            vae: run.vae,
            loras: run.loras,
            sourceImages: run.sourceImages,
            videoUrl: job.videos?.[i] ?? job.videos?.[0],
            audioUrl: job.audios?.[i] ?? job.audios?.[0],
            meshUrl: job.meshes?.[i] ?? job.meshes?.[0],
            ...(job.meshes && job.meshes.length > 1
              ? { meshUrls: job.meshes }
              : {}),
          });
        }
      }
    }

    return images;
  }, []);

  const addRunToGallery = useCallback(
    (run: ImagineRun) => {
      const images = runToGalleryImages(run);
      if (images.length > 0) {
        addToGallery(images);
      }
    },
    [runToGalleryImages, addToGallery],
  );

  // Single dismiss path: the error banner renders hook-local lastError OR the
  // store error, so clearing only the store leaves the banner stuck.
  const clearError = useCallback(() => {
    setLastError(null);
    setLastFailure(null);
    setError(null);
  }, [setError]);

  return {
    imagine,
    submitAndClear,
    isLoading,
    lastError,
    lastFailure,
    clearError,
    buildPrompt,
    addRunToGallery,
    runToGalleryImages,
  };
}

export default useImagine;
