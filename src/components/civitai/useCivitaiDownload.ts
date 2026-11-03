"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CivitaiModel,
  CivitaiModelVersion,
  CivitaiSource,
} from "@/lib/civitai";
import {
  civitaiProgressKey,
  civitaiTypeRule,
  planCivitaiFile,
  type CivitaiFilePlan,
} from "@/lib/civitaiFolders";
import { useDownloadStore, type DownloadedModel } from "@/store/downloadStore";
import { useModelStore } from "@/store/modelStore";

export type CivitaiDownloadStatus =
  | "idle"
  | "confirmPickle"
  | "downloading"
  | "verifying"
  | "done"
  | "conflict"
  | "error";

export interface CivitaiDownloadState {
  status: CivitaiDownloadStatus;
  error?: string;
  skipped?: boolean;
  trainedWords?: string[];
}

/** Folder for a Civitai type; browse-only types fall back to checkpoints. */
export function targetDirForCivitaiType(modelType: string): string {
  return civitaiTypeRule(modelType).dest ?? "checkpoints";
}

export function primaryFileForVersion(version: CivitaiModelVersion) {
  return version.files.find((file) => file.primary) ?? version.files[0];
}

type VersionFile = CivitaiModelVersion["files"][number];

const PROGRESS_POLL_MS = 1000;

export function useCivitaiDownload({
  model,
  version,
  source,
  nsfw,
  preferredFileName,
}: {
  model: CivitaiModel;
  version: CivitaiModelVersion;
  source: CivitaiSource;
  nsfw: boolean;
  /** Pre-selected file (best for this GPU) until the user picks one. */
  preferredFileName?: string | null;
}) {
  const addDownload = useDownloadStore((s) => s.addDownload);
  const setActiveDownload = useDownloadStore((s) => s.setActiveDownload);
  const clearActiveDownload = useDownloadStore((s) => s.clearActiveDownload);
  const fetchAvailable = useModelStore((s) => s.fetchAvailable);
  const [state, setState] = useState<CivitaiDownloadState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const primaryFile = primaryFileForVersion(version);
  // Unset until the user picks: then the GPU-aware preference (which can
  // arrive after mount) wins, else Civitai's primary file.
  const [selectedName, setSelectedName] = useState<string | undefined>(
    undefined,
  );
  const selectedFile: VersionFile | undefined =
    version.files.find((file) => file.name === selectedName) ??
    (preferredFileName
      ? version.files.find((file) => file.name === preferredFileName)
      : undefined) ??
    primaryFile;
  const filename = selectedFile?.name ?? `${version.name}.safetensors`;
  const plan: CivitaiFilePlan = useMemo(
    () =>
      selectedFile
        ? planCivitaiFile(model.type, selectedFile)
        : { ok: false, reason: "This version has no files." },
    [model.type, selectedFile],
  );
  const files = useMemo(
    () =>
      version.files.map((file) => ({
        file,
        plan: planCivitaiFile(model.type, file),
      })),
    [model.type, version.files],
  );
  const targetDir = plan.ok ? plan.dest : targetDirForCivitaiType(model.type);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);
  useEffect(() => stopPolling, [stopPolling]);

  const selectFile = useCallback(
    (name: string) => {
      if (state.status === "downloading" || state.status === "verifying")
        return;
      setSelectedName(name);
      setState({ status: "idle" });
    },
    [state.status],
  );

  const download = useCallback(
    async (opts: { acceptPickle?: boolean; overwrite?: boolean } = {}) => {
      if (state.status === "downloading" || state.status === "verifying")
        return;
      if (!plan.ok || !selectedFile) return;
      // Warn before any bytes move.
      if (plan.pickle && !opts.acceptPickle) {
        setState({ status: "confirmPickle" });
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;

      setState({ status: "downloading" });
      setActiveDownload(version.id, -1, filename);

      const key = civitaiProgressKey(version.id, filename);
      stopPolling();
      pollRef.current = setInterval(() => {
        void fetch(`/api/civitai/download?key=${encodeURIComponent(key)}`)
          .then((r) => r.json())
          .then((p: { active?: boolean; percent?: number }) => {
            if (p.active && typeof p.percent === "number") {
              setActiveDownload(version.id, p.percent, filename);
            }
          })
          .catch(() => {});
      }, PROGRESS_POLL_MS);

      try {
        const response = await fetch("/api/civitai/download", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            modelVersionId: version.id,
            fileId: selectedFile.id,
            filename,
            targetDir,
            source,
            nsfw,
            acceptPickle: opts.acceptPickle === true,
            overwrite: opts.overwrite === true,
          }),
          signal: controller.signal,
        });
        stopPolling();

        const data = (await response.json()) as {
          ok: boolean;
          error?: string;
          path?: string;
          filename?: string;
          sha256?: string;
          skipped?: boolean;
          trainedWords?: string[];
          needsAuth?: boolean;
          needsPickleAck?: boolean;
          conflict?: boolean;
        };

        if (!response.ok || !data.ok) {
          clearActiveDownload(version.id);
          if (data.needsPickleAck) {
            setState({ status: "confirmPickle" });
          } else if (data.conflict) {
            setState({ status: "conflict", error: data.error });
          } else {
            setState({
              status: "error",
              error: data.needsAuth
                ? "Civitai needs your API key for this download. Add it in Settings."
                : (data.error ?? `Download failed (${response.status})`),
            });
          }
          return;
        }

        setState({ status: "verifying" });
        setActiveDownload(version.id, 100, filename);

        const trainedWords = data.trainedWords ?? version.trainedWords ?? [];
        const downloaded: DownloadedModel = {
          civitaiModelId: model.id,
          civitaiVersionId: version.id,
          modelName: model.name,
          versionName: version.name,
          type: model.type,
          filename: data.filename ?? filename,
          localPath: data.path ?? "",
          sha256: data.sha256,
          trainedWords,
          downloadedAt: new Date().toISOString(),
        };
        addDownload(downloaded);
        await fetchAvailable(true);

        setState({ status: "done", skipped: data.skipped, trainedWords });
        clearActiveDownload(version.id);
      } catch (err) {
        stopPolling();
        if (controller.signal.aborted) {
          setState({ status: "idle" });
        } else {
          setState({
            status: "error",
            error: err instanceof Error ? err.message : "Download failed",
          });
        }
        clearActiveDownload(version.id);
      } finally {
        abortRef.current = null;
      }
    },
    [
      addDownload,
      clearActiveDownload,
      fetchAvailable,
      filename,
      model,
      nsfw,
      plan,
      selectedFile,
      setActiveDownload,
      source,
      state.status,
      stopPolling,
      targetDir,
      version,
    ],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    stopPolling();
    clearActiveDownload(version.id);
    setState({ status: "idle" });
  }, [clearActiveDownload, stopPolling, version.id]);

  return {
    cancel,
    download,
    filename,
    files,
    plan,
    primaryFile,
    selectedFile,
    selectFile,
    state,
    targetDir,
  };
}
