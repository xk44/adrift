"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, RotateCcw } from "lucide-react";
import {
  GRADE_PRESETS,
  GRADE_SLIDERS,
  NEUTRAL_GRADE,
  applyGrade,
  fitWithin,
  presetSettings,
  type GradeSettings,
} from "@/lib/tools/colorGrade";
import {
  GRADE_PNG_KEY,
  addPngTextChunk,
  asciiJson,
  gradeExportNames,
  gradeSidecar,
} from "@/lib/tools/colorGradeExport";
import type { ToolImage } from "@/lib/tools/runTool";
import { smoothContext } from "@/lib/canvasResample";
import { ToolImageInput } from "./ToolImageInput";
import { RunnerShell } from "./RunnerShell";

const PREVIEW_MAX = 1200;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load that image."));
    img.src = src;
  });
}

/** Draw `img` at (w,h) onto `canvas` and grade it in place. */
function render(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  w: number,
  h: number,
  s: GradeSettings,
) {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  smoothContext(ctx);
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  applyGrade(data.data, w, h, s);
  ctx.putImageData(data, 0, 0);
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Client-side Color Grade: sliders + looks over a canvas, PNG export. No model. */
export function ColorGrade({ onBack }: { onBack: () => void }) {
  const [image, setImage] = useState<ToolImage | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [preset, setPreset] = useState("none");
  const [settings, setSettings] = useState<GradeSettings>(NEUTRAL_GRADE);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [saveSettings, setSaveSettings] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    setImg(null);
    setError(null);
    const src = image?.dataUrl ?? image?.previewUrl;
    if (!src) return;
    let alive = true;
    loadImage(src)
      .then((el) => alive && setImg(el))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [image]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !img) return;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const { width, height } = fitWithin(
        img.naturalWidth,
        img.naturalHeight,
        PREVIEW_MAX,
      );
      try {
        render(canvas, img, width, height, settings);
      } catch {
        setError("This image can't be read for grading; upload it instead.");
      }
    });
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [img, settings]);

  const pickPreset = (id: string) => {
    setPreset(id);
    setSettings(presetSettings(id));
  };

  const setOne = (key: keyof GradeSettings, value: number) => {
    setPreset("");
    setSettings((s) => ({ ...s, [key]: value }));
  };

  const exportPng = useCallback(async () => {
    if (!img) return;
    setExporting(true);
    setError(null);
    try {
      const canvas = document.createElement("canvas");
      render(canvas, img, img.naturalWidth, img.naturalHeight, settings);
      const blob = await new Promise<Blob | null>((r) =>
        canvas.toBlob(r, "image/png"),
      );
      if (!blob) throw new Error("Export failed.");
      // The grade settings travel with the PNG (tEXt) and, if asked, as a
      // .grade.json file next to it.
      const sidecar = gradeSidecar({
        preset,
        settings,
        width: img.naturalWidth,
        height: img.naturalHeight,
        source: image?.label,
      });
      const names = gradeExportNames(Date.now());
      const png = addPngTextChunk(
        new Uint8Array(await blob.arrayBuffer()),
        GRADE_PNG_KEY,
        asciiJson(sidecar),
      );
      saveBlob(new Blob([png as Uint8Array<ArrayBuffer>], { type: "image/png" }), names.png);
      if (saveSettings)
        saveBlob(
          new Blob([asciiJson(sidecar, 2)], { type: "application/json" }),
          names.json,
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }, [img, settings, preset, image, saveSettings]);

  return (
    <RunnerShell
      title="Color Grade"
      subtitle="Grade a still with film looks and fine sliders, then export a full-resolution PNG. Runs in your browser."
      model="Runs locally in the browser · no model"
      onBack={onBack}
      testId="color-grade"
    >
      <ToolImageInput
        label="Photo"
        value={image}
        onChange={setImage}
        needsPixels
        maxSide={null}
      />

      {image && (
        <div className="overflow-hidden rounded-xl border border-light-100 dark:border-dark-750 bg-black/5 dark:bg-black/30">
          <canvas
            ref={canvasRef}
            className="mx-auto block h-auto max-h-[60vh] w-auto max-w-full"
            aria-label="Graded preview"
          />
        </div>
      )}

      <section className="space-y-1.5">
        <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
          Look
        </span>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Look">
          {GRADE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={preset === p.id}
              onClick={() => pickPreset(p.id)}
              className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                preset === p.id
                  ? "border-splash bg-splash/10 text-splash"
                  : "border-light-100 dark:border-dark-750 text-light-500 dark:text-dark-400 hover:border-splash/60"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {GRADE_SLIDERS.map((sl) => (
          <label key={sl.key} className="block space-y-1">
            <span className="flex justify-between text-xs text-light-primary dark:text-dark-primary">
              {sl.label}
              <span className="tabular-nums text-light-500 dark:text-dark-400">
                {settings[sl.key]}
              </span>
            </span>
            <input
              type="range"
              min={sl.min}
              max={sl.max}
              step={sl.step}
              value={settings[sl.key]}
              onChange={(e) => setOne(sl.key, Number(e.target.value))}
              className="w-full accent-splash"
            />
          </label>
        ))}
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={exportPng}
          disabled={!img || exporting}
          className="flex items-center gap-2 rounded-xl bg-splash px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Download className="w-4 h-4" /> Export PNG
        </button>
        <button
          type="button"
          onClick={() => pickPreset("none")}
          className="flex items-center gap-1.5 rounded-xl border border-light-100 dark:border-dark-750 px-4 py-2.5 text-sm text-light-500 dark:text-dark-400 hover:text-splash"
        >
          <RotateCcw className="w-4 h-4" /> Reset
        </button>
        <label className="flex items-center gap-2 text-xs text-light-500 dark:text-dark-400">
          <input
            type="checkbox"
            checked={saveSettings}
            onChange={(e) => setSaveSettings(e.target.checked)}
          />
          Also save the settings (.json)
        </label>
      </div>
      {!image && (
        <p className="text-[11px] text-light-500 dark:text-dark-400">
          Add a photo to start.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}
    </RunnerShell>
  );
}
