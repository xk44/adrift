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
import { MAX_AUDIO_UPLOAD_BYTES, type ToolAudio } from "@/lib/tools/runTool";
import { readFileAsDataUrl } from "./ToolImageInput";

const AUDIO_EXT = /\.(wav|mp3|m4a|flac)$/i;

export function probeDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const a = document.createElement("audio");
    a.preload = "metadata";
    a.onloadedmetadata = () =>
      resolve(Number.isFinite(a.duration) ? a.duration : null);
    a.onerror = () => resolve(null);
    a.src = url;
  });
}

interface ToolAudioInputProps {
  label: string;
  value: ToolAudio | null;
  onChange: (audio: ToolAudio | null) => void;
  /** One-line help under the picker. */
  note?: string;
}

/** Upload a speech / audio file (click or drop): wav, mp3, m4a or flac. */
export function ToolAudioInput({
  label,
  value,
  onChange,
  note,
}: ToolAudioInputProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    if (!AUDIO_EXT.test(file.name)) {
      setError(
        "That file is not a supported audio file (wav, mp3, m4a or flac).",
      );
      return;
    }
    if (file.size > MAX_AUDIO_UPLOAD_BYTES) {
      setError(
        `That file is ${Math.round(file.size / 1048576)} MB; the limit is ${MAX_AUDIO_UPLOAD_BYTES / 1048576} MB.`,
      );
      return;
    }
    setError(null);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const duration = await probeDuration(dataUrl);
      onChange({
        id: `upload:${file.name}:${file.size}`,
        previewUrl: dataUrl,
        dataUrl,
        label: file.name,
        duration,
      });
    } catch {
      setError("Couldn't read that file.");
    }
  };

  const drop = useFileDrop((file) => void pickFile(file));

  return (
    <div
      className={dropZoneClass(drop.over)}
      data-testid="tool-audio-input"
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
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-light-100 dark:border-dark-750 bg-light-input dark:bg-dark-input p-2">
          <audio src={value.previewUrl} controls className="h-9 max-w-full" />
          <div className="min-w-0 text-xs text-light-500 dark:text-dark-400">
            <p className="truncate text-light-primary dark:text-dark-primary">
              {value.label}
            </p>
            {value.duration !== null && <p>{value.duration.toFixed(1)} s</p>}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className={INPUT_PICK_BUTTON}
          >
            <Upload className="w-3.5 h-3.5" /> Upload audio
          </button>
          <span className={DROP_HINT} aria-live="polite">
            {drop.over ? "Drop to use it" : "or drop a file here"}
          </span>
        </div>
      )}
      {note && (
        <p className="text-[11px] text-light-500 dark:text-dark-400">{note}</p>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="audio/*,.wav,.mp3,.m4a,.flac"
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
