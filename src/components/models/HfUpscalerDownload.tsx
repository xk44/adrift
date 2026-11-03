"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Download, Loader2 } from "lucide-react";
import {
  HF_UPSCALE_FOLDERS,
  hfUpscaleProgressKey,
  type HfUpscaleFolder,
  type HfUpscalerFile,
} from "@/lib/hfUpscalers";
import { useModelStore } from "@/store/modelStore";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "confirmPickle" }
  | { kind: "downloading"; percent: number }
  | { kind: "conflict"; message: string }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

function sizeLabel(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 2 ** 20) return ` (${Math.max(1, Math.round(bytes / 1024))} KB)`;
  if (bytes < 2 ** 30) return ` (${Math.round(bytes / 2 ** 20)} MB)`;
  return ` (${(bytes / 2 ** 30).toFixed(1)} GB)`;
}

const btn =
  "inline-flex items-center gap-1 rounded-sm border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-2 py-1 text-[11px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50";

/**
 * Download panel for Hugging Face upscaler repos. Lists the repo's upscaler
 * files (pinned to its current commit) and saves one into
 * models/upscale_models or models/latent_upscale_models.
 */
export function HfUpscalerDownload({ repo }: { repo: string }) {
  const fetchAvailable = useModelStore((s) => s.fetchAvailable);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [files, setFiles] = useState<HfUpscalerFile[]>([]);
  const [revision, setRevision] = useState("");
  const [file, setFile] = useState("");
  const [folder, setFolder] = useState<HfUpscaleFolder>("upscale_models");
  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };
  useEffect(
    () => () => {
      stopPolling();
      abortRef.current?.abort();
    },
    [],
  );

  const load = async () => {
    setStatus({ kind: "loading" });
    try {
      const res = await fetch(
        `/api/hf/download?repo=${encodeURIComponent(repo)}`,
      );
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        gated?: boolean;
        revision?: string;
        files?: HfUpscalerFile[];
      };
      if (!res.ok || !data.ok) {
        setStatus({
          kind: "error",
          message: data.error ?? "Couldn't read this repo",
        });
        return;
      }
      if (data.gated) {
        setStatus({
          kind: "error",
          message:
            "This repo is gated. Accept its license on Hugging Face and download it there.",
        });
        return;
      }
      const list = data.files ?? [];
      if (list.length === 0) {
        setStatus({
          kind: "error",
          message: "No upscaler files ComfyUI can load in this repo.",
        });
        return;
      }
      setFiles(list);
      setRevision(data.revision ?? "");
      setFile(list[0].file);
      setFolder(list[0].folder);
      setStatus({ kind: "ready" });
    } catch {
      setStatus({ kind: "error", message: "Couldn't reach Hugging Face" });
    }
  };

  const selected = files.find((f) => f.file === file);

  const download = async (
    opts: { acceptPickle?: boolean; overwrite?: boolean } = {},
  ) => {
    if (!selected) return;
    if (selected.pickle && !opts.acceptPickle) {
      setStatus({ kind: "confirmPickle" });
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus({ kind: "downloading", percent: -1 });
    const key = hfUpscaleProgressKey(repo, selected.file);
    stopPolling();
    pollRef.current = setInterval(() => {
      void fetch(`/api/hf/download?key=${encodeURIComponent(key)}`)
        .then((r) => r.json())
        .then((p: { active?: boolean; percent?: number }) => {
          if (p.active && typeof p.percent === "number") {
            setStatus((s) =>
              s.kind === "downloading"
                ? { kind: "downloading", percent: p.percent! }
                : s,
            );
          }
        })
        .catch(() => {});
    }, 1000);
    try {
      const res = await fetch("/api/hf/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo,
          file: selected.file,
          revision,
          folder,
          acceptPickle: opts.acceptPickle === true,
          overwrite: opts.overwrite === true,
        }),
        signal: controller.signal,
      });
      stopPolling();
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        skipped?: boolean;
        needsPickleAck?: boolean;
        conflict?: boolean;
      };
      if (!res.ok || !data.ok) {
        if (data.needsPickleAck) setStatus({ kind: "confirmPickle" });
        else if (data.conflict)
          setStatus({
            kind: "conflict",
            message: data.error ?? "File already exists",
          });
        else
          setStatus({
            kind: "error",
            message: data.error ?? `Download failed (${res.status})`,
          });
        return;
      }
      await fetchAvailable(true);
      setStatus({
        kind: "done",
        message: data.skipped
          ? `Already in models/${folder}`
          : `Saved to models/${folder}`,
      });
    } catch {
      stopPolling();
      setStatus(
        controller.signal.aborted
          ? { kind: "ready" }
          : { kind: "error", message: "Download failed" },
      );
    } finally {
      abortRef.current = null;
    }
  };

  if (status.kind === "idle") {
    return (
      <button type="button" className={btn} onClick={() => void load()}>
        <Download className="h-3.5 w-3.5" /> Download upscaler
      </button>
    );
  }
  if (status.kind === "loading") {
    return (
      <p className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking files…
      </p>
    );
  }

  const busy = status.kind === "downloading";
  return (
    <div className="space-y-2 text-[11px]">
      {files.length > 0 && (
        <div className="flex flex-col gap-1">
          <label className="text-[var(--text-muted)]">
            File
            <select
              className="mt-0.5 block w-full rounded-sm border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-1 py-0.5 text-[var(--text-primary)]"
              value={file}
              disabled={busy}
              onChange={(e) => {
                const next = files.find((f) => f.file === e.target.value);
                setFile(e.target.value);
                if (next) setFolder(next.folder);
                setStatus({ kind: "ready" });
              }}
            >
              {files.map((f) => (
                <option key={f.file} value={f.file}>
                  {f.file}
                  {sizeLabel(f.size)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[var(--text-muted)]">
            Save to
            <select
              className="mt-0.5 block w-full rounded-sm border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-1 py-0.5 text-[var(--text-primary)]"
              value={folder}
              disabled={busy}
              onChange={(e) => setFolder(e.target.value as HfUpscaleFolder)}
              title="Image upscalers go in upscale_models. Video latent upscalers (LTX and similar) go in latent_upscale_models."
            >
              {HF_UPSCALE_FOLDERS.map((f) => (
                <option key={f} value={f}>
                  models/{f}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {status.kind === "confirmPickle" && (
        <div className="space-y-1 rounded-sm border border-amber-500/40 bg-amber-500/10 p-2 text-[var(--text-secondary)]">
          <p className="flex gap-1">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
            This file is a pickle (.pth/.pt/.ckpt). It can run code when ComfyUI
            loads it. Only download it if you trust the uploader.
          </p>
          <div className="flex gap-1">
            <button
              type="button"
              className={btn}
              onClick={() => void download({ acceptPickle: true })}
            >
              Download anyway
            </button>
            <button
              type="button"
              className={btn}
              onClick={() => setStatus({ kind: "ready" })}
            >
              Not now
            </button>
          </div>
        </div>
      )}

      {status.kind === "conflict" && (
        <div className="space-y-1 rounded-sm border border-[var(--border-secondary)] p-2 text-[var(--text-secondary)]">
          <p>{status.message}</p>
          <button
            type="button"
            className={btn}
            onClick={() =>
              void download({ acceptPickle: selected?.pickle, overwrite: true })
            }
          >
            Replace it
          </button>
        </div>
      )}

      {status.kind === "error" && (
        <p className="text-rose-400">{status.message}</p>
      )}
      {status.kind === "done" && (
        <p className="text-emerald-400">{status.message}</p>
      )}

      {busy ? (
        <div className="flex items-center gap-2 text-[var(--text-muted)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {status.percent >= 0
            ? `Downloading ${status.percent}%`
            : "Downloading…"}
          <button
            type="button"
            className={btn}
            onClick={() => abortRef.current?.abort()}
          >
            Cancel
          </button>
        </div>
      ) : (
        files.length > 0 &&
        status.kind !== "confirmPickle" &&
        status.kind !== "conflict" && (
          <button type="button" className={btn} onClick={() => void download()}>
            <Download className="h-3.5 w-3.5" /> Download
          </button>
        )
      )}
    </div>
  );
}
