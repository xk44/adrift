"use client";

import {
  DROP_HINT,
  INPUT_PICK_BUTTON,
  INPUT_REMOVE_BUTTON,
  dropZoneClass,
  useFileDrop,
} from "./useFileDrop";
import { useMemo, useRef, useState } from "react";
import { Images, Upload, X } from "lucide-react";
import { useGenerationStore } from "@/store";
import type { ToolImage } from "@/lib/tools/runTool";
import { resampleDataUrl } from "@/lib/canvasResample";
import {
  TOOL_UPLOAD_MAX_SIDE,
  dataUrlMime,
  uploadResizePlan,
} from "@/lib/tools/uploadPrep";

const GALLERY_LIMIT = 60;

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function measure(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}

export async function urlToDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch ${res.status}`);
  // Original bytes under their own type (a JPEG stays labelled as one);
  // anything else keeps the PNG label the server validators expect.
  const blob = await res.blob();
  const type = /^image\/(?:jpeg|webp)$/.test(blob.type)
    ? blob.type
    : "image/png";
  return readFileAsDataUrl(new File([blob], "image", { type }));
}

/**
 * An image data URL ready to upload: the original bytes when within
 * `maxSide` (null = never resample), else one high-quality resample to the
 * cap in the source's own format (lib/tools/uploadPrep.ts).
 */
export async function prepareUploadDataUrl(
  dataUrl: string,
  maxSide: number | null = TOOL_UPLOAD_MAX_SIDE,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const size = await measure(dataUrl);
  const plan = uploadResizePlan(
    size.width,
    size.height,
    dataUrlMime(dataUrl),
    maxSide,
  );
  if (!plan) return { dataUrl, ...size };
  const out = await resampleDataUrl(
    dataUrl,
    plan.width,
    plan.height,
    plan.mime,
    plan.quality,
  );
  return { dataUrl: out, width: plan.width, height: plan.height };
}

interface ToolImageInputProps {
  label: string;
  value: ToolImage | null;
  onChange: (image: ToolImage | null) => void;
  /** Load gallery pixels into a data URL (needed for 2nd references). */
  needsPixels?: boolean;
  /**
   * Uploads larger than this are resampled down to it (null = keep any size,
   * e.g. a client-side tool that exports at the photo's own resolution).
   */
  maxSide?: number | null;
}

/** Pick an image from the gallery or upload one (click or drop). */
export function ToolImageInput({
  label,
  value,
  onChange,
  needsPixels = false,
  maxSide = TOOL_UPLOAD_MAX_SIDE,
}: ToolImageInputProps) {
  const gallery = useGenerationStore((s) => s.gallery);
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recent = useMemo(
    () =>
      gallery
        .filter((g) => g.url && !g.videoUrl && !g.hidden && g.runId)
        .slice(0, GALLERY_LIMIT),
    [gallery],
  );

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("That file is not an image.");
      return;
    }
    setError(null);
    try {
      const { dataUrl, ...size } = await prepareUploadDataUrl(
        await readFileAsDataUrl(file),
        maxSide,
      );
      onChange({
        id: `upload:${file.name}:${file.size}`,
        source: "upload",
        previewUrl: dataUrl,
        dataUrl,
        label: file.name,
        ...size,
      });
      setOpen(false);
    } catch {
      setError("Couldn't read that file.");
    }
  };

  const drop = useFileDrop((file) => void pickFile(file));

  return (
    <div
      className={dropZoneClass(drop.over)}
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
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={value.previewUrl}
            alt={value.label}
            className="h-16 w-16 rounded-lg object-cover"
          />
          <div className="min-w-0 text-xs text-light-500 dark:text-dark-400">
            <p className="truncate text-light-primary dark:text-dark-primary">
              {value.label}
            </p>
            {value.width > 0 && (
              <p>
                {value.width} × {value.height}
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className={INPUT_PICK_BUTTON}
          >
            <Images className="w-3.5 h-3.5" /> From gallery
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className={INPUT_PICK_BUTTON}
          >
            <Upload className="w-3.5 h-3.5" /> Upload
          </button>
          <span className={DROP_HINT} aria-live="polite">
            {drop.over ? "Drop to use it" : "or drop an image here"}
          </span>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          void pickFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {open && !value && (
        <div
          className="grid grid-cols-4 sm:grid-cols-6 gap-1.5 max-h-56 overflow-y-auto rounded-xl border border-light-100 dark:border-dark-750 p-2"
          role="listbox"
          aria-label="Gallery images"
        >
          {recent.length === 0 && (
            <p className="col-span-full py-4 text-center text-xs text-light-500 dark:text-dark-400">
              No images yet. Generate or upload one.
            </p>
          )}
          {recent.map((g) => (
            <button
              type="button"
              key={g.id}
              role="option"
              aria-selected={false}
              onClick={async () => {
                setError(null);
                try {
                  const dataUrl = needsPixels
                    ? await urlToDataUrl(g.url)
                    : undefined;
                  onChange({
                    id: g.id,
                    source: "gallery",
                    previewUrl: g.url,
                    dataUrl,
                    label: g.prompt?.slice(0, 60) || "Gallery image",
                    width: g.width,
                    height: g.height,
                    runId: g.runId,
                    jobIndex: g.jobIndex,
                  });
                  setOpen(false);
                } catch {
                  setError("Couldn't load that image.");
                }
              }}
              className="aspect-square overflow-hidden rounded-lg border-2 border-transparent hover:border-splash focus:outline-none focus:ring-2 focus:ring-splash"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={g.url}
                alt={g.prompt?.slice(0, 80) || "Gallery image"}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      )}

      {error && (
        <p role="alert" className="text-[11px] text-red-500">
          {error}
        </p>
      )}
    </div>
  );
}
