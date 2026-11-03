"use client";

import {
  DROP_HINT,
  INPUT_PICK_BUTTON,
  INPUT_REMOVE_BUTTON,
  dropZoneClass,
  useFileDrop,
} from "./useFileDrop";
import { useRef, useState } from "react";
import { Upload, X } from "lucide-react";
import { MAX_VIDEO_UPLOAD_BYTES, type ToolVideo } from "@/lib/tools/runTool";
import { readFileAsDataUrl } from "./ToolImageInput";
import { mp4VideoFps } from "@/lib/videoFps";

const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;

/** Clip metadata (duration / size) from a video URL. */
export function probeVideo(
  url: string,
): Promise<{ duration: number | null; width: number; height: number }> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () =>
      resolve({
        duration: Number.isFinite(v.duration) ? v.duration : null,
        width: v.videoWidth,
        height: v.videoHeight,
      });
    v.onerror = () => resolve({ duration: null, width: 0, height: 0 });
    v.src = url;
  });
}

interface ToolVideoInputProps {
  label: string;
  value: ToolVideo | null;
  onChange: (video: ToolVideo | null) => void;
  /** Help line under the picker (defaults to the H3 24 fps note). */
  note?: string;
}

/** Upload a short source clip (click or drop). Video tools never use the gallery. */
export function ToolVideoInput({
  label,
  value,
  onChange,
  note,
}: ToolVideoInputProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("video/") && !VIDEO_EXT.test(file.name)) {
      setError("That file is not a video (mp4, mov, m4v or webm).");
      return;
    }
    if (file.size > MAX_VIDEO_UPLOAD_BYTES) {
      setError(
        `That clip is ${Math.round(file.size / 1048576)} MB; the limit is ${MAX_VIDEO_UPLOAD_BYTES / 1048576} MB. Trim or compress it.`,
      );
      return;
    }
    setError(null);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const meta = await probeVideo(dataUrl);
      // <video> metadata has no fps; MP4 / MOV carry it in the file.
      const fps = await file
        .arrayBuffer()
        .then(mp4VideoFps)
        .catch(() => null);
      onChange({
        id: `upload:${file.name}:${file.size}`,
        previewUrl: dataUrl,
        dataUrl,
        label: file.name,
        ...meta,
        fps,
      });
    } catch {
      setError("Couldn't read that file.");
    }
  };

  const drop = useFileDrop((file) => void pickFile(file));

  return (
    <div
      className={dropZoneClass(drop.over)}
      data-testid="tool-video-input"
      {...drop.handlers}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
          {label}
        </span>
        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label={`Remove ${label.toLowerCase()}`}
            className={INPUT_REMOVE_BUTTON}
          >
            <X className="w-3 h-3" /> Remove
          </button>
        )}
      </div>

      {value ? (
        <div className="flex items-center gap-3 rounded-xl border border-light-100 dark:border-dark-750 bg-light-input dark:bg-dark-input p-2">
          <video
            src={value.previewUrl}
            muted
            controls
            playsInline
            className="h-20 w-32 rounded-lg bg-black object-contain"
          />
          <div className="min-w-0 text-xs text-light-500 dark:text-dark-400">
            <p className="truncate text-light-primary dark:text-dark-primary">
              {value.label}
            </p>
            <p>
              {value.width > 0 ? `${value.width} × ${value.height}` : ""}
              {value.duration !== null
                ? ` · ${value.duration.toFixed(1)} s`
                : ""}
              {value.fps ? ` · ${value.fps} fps` : ""}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className={INPUT_PICK_BUTTON}
          >
            <Upload className="w-3.5 h-3.5" /> Upload video
          </button>
          <span className={DROP_HINT} aria-live="polite">
            {drop.over ? "Drop to use it" : "or drop a clip here"}
          </span>
        </div>
      )}
      <p className="text-[11px] text-light-500 dark:text-dark-400">
        {note ??
          "24 fps clips, up to 15 s and 32 MB. The result follows the clip's framing at 480p."}
      </p>

      <input
        ref={fileRef}
        type="file"
        accept="video/*,.mp4,.mov,.m4v,.webm"
        className="hidden"
        onChange={(e) => {
          void pickFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {error && (
        <p role="alert" className="text-[11px] text-red-500">
          {error}
        </p>
      )}
    </div>
  );
}
