"use client";

/**
 * Editor start screen: "Edit a video" row. Resume the last video project,
 * open a file, or pick one of the recent videos from the gallery.
 */

import { useMemo, useRef, useState } from "react";
import { Clapperboard, Loader2, Play } from "lucide-react";
import { useGenerationStore } from "@/store";
import { useVideoEditStore } from "@/store/videoEditStore";
import { selectEditorVideos } from "../editorStartScreen";
import { openVideoFile, openVideoUrl } from "./openVideo";
import { firstVideoFile } from "@/lib/videoEdit/client";

export function VideoStartSection() {
  const gallery = useGenerationStore((s) => s.gallery);
  const resumeLabel = useVideoEditStore((s) => (s.edit ? s.label : null));
  const videos = useMemo(() => selectEditorVideos(gallery, 12), [gallery]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const pick = async (id: string, url: string, prompt: string) => {
    if (busy) return;
    setBusy(id);
    await openVideoUrl(url, prompt);
    setBusy(null);
  };

  const onFile = async (file: File | null) => {
    if (!file || busy) return;
    setBusy("file");
    setProgress(0);
    await openVideoFile(file, setProgress);
    setProgress(null);
    setBusy(null);
  };

  return (
    <section
      aria-labelledby="editor-video-heading"
      className="space-y-3"
      data-testid="editor-video-start"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2
          id="editor-video-heading"
          className="flex items-center gap-2 text-base font-medium text-[var(--text-primary)]"
        >
          <Clapperboard
            className="h-4 w-4 text-[var(--text-secondary)]"
            aria-hidden
          />
          Edit a video
        </h2>
        <span className="text-xs text-[var(--text-muted)]">
          Trim, split and join clips, run video tools on a range, export MP4.
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {resumeLabel !== null && (
            <button
              type="button"
              onClick={() => useVideoEditStore.getState().setActive(true)}
              className="flex h-9 max-w-[16rem] items-center gap-1.5 rounded-full bg-[var(--text-primary)] px-4 text-sm font-medium text-[var(--bg-primary)] hover:opacity-90"
              title={`Continue ${resumeLabel}`}
            >
              <Play className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate">Continue {resumeLabel}</span>
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="video/*"
            className="hidden"
            aria-label="Open a video file"
            onChange={(e) => {
              void onFile(firstVideoFile(e.target.files));
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={!!busy}
            className="flex h-9 items-center gap-1.5 rounded-full border border-[var(--border-secondary)] px-4 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            {busy === "file" && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            )}
            {progress !== null
              ? `Uploading ${Math.round(progress * 100)}%`
              : "Upload video"}
          </button>
        </div>
      </div>
      {videos.length > 0 && (
        <ul
          className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6"
          aria-label="Recent videos"
        >
          {videos.map((v) => (
            <li key={v.id}>
              <button
                type="button"
                onClick={() => void pick(v.id, v.url, v.prompt)}
                disabled={!!busy}
                aria-label={`Edit video: ${v.prompt || "untitled"}`}
                title={v.prompt || "Edit this video"}
                className="group relative block aspect-video w-full overflow-hidden rounded-xl bg-[var(--bg-tertiary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] disabled:opacity-60"
              >
                <video
                  src={`${v.url}#t=0.1`}
                  muted
                  playsInline
                  preload="metadata"
                  aria-hidden
                  className="h-full w-full object-cover transition-transform group-hover:scale-105"
                />
                {busy === v.id && (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/50">
                    <Loader2
                      className="h-5 w-5 animate-spin text-white"
                      aria-hidden
                    />
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
