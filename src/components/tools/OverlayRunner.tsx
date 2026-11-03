"use client";

import { useRef, useState } from "react";
import {
  Check,
  Film,
  ImagePlus,
  Layers,
  Loader2,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useGenerationStore } from "@/store";
import { showToast } from "@/components/Toast";
import type { EngineContext } from "@/lib/tools/templates";
import type { HubCard } from "@/lib/tools/hub";
import { MAX_VIDEO_UPLOAD_BYTES, type ToolVideo } from "@/lib/tools/runTool";
import {
  OVERLAY_BLENDS,
  OVERLAY_BLEND_LABELS,
  OVERLAY_LOOKS,
  OVERLAY_MAX_LAYERS,
  OVERLAY_MAX_SCALE,
  OVERLAY_MAX_SECONDS,
  OVERLAY_MIN_SCALE,
  overlaySeconds,
  type OverlayBlend,
} from "@/lib/tools/overlayComposite";
import {
  OVERLAY_CSS_BLEND,
  lookLayer,
  overlayPreviewBox,
  runOverlayComposite,
  uploadLayer,
  type OverlayDeps,
  type OverlayInputLayer,
  type OverlayLayerStatus,
} from "@/lib/tools/overlayRunner";
import { overlayLooksAvailable } from "@/lib/tools/pipelineCards";
import type { StepOutput } from "@/lib/tools/pipelines";
import { ToolVideoInput } from "./ToolVideoInput";
import { readFileAsDataUrl } from "./ToolImageInput";
import { RunFooter, RunnerShell, errorMessage } from "./RunnerShell";
import { field } from "./ToolRunner";

const STILL_TYPES = /\.(png|webp)$/i;
const CLIP_TYPES = /\.(webm|mov)$/i;

function measureImage(
  url: string,
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (typeof Image === "undefined") return resolve(null);
    const img = new Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function probeClip(
  url: string,
): Promise<{ width: number; height: number; duration: number | null }> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () =>
      resolve({
        width: v.videoWidth,
        height: v.videoHeight,
        duration: Number.isFinite(v.duration) ? v.duration : null,
      });
    v.onerror = () => resolve({ width: 0, height: 0, duration: null });
    v.src = url;
  });
}

function measureVideo(url: string): Promise<number | null> {
  return probeClip(url).then((m) => m.duration);
}

async function toDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not read ${url} (${res.status})`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the cut-out"));
    reader.readAsDataURL(blob);
  });
}

const STATUS_LABEL: Record<OverlayLayerStatus, string> = {
  uploading: "Uploading",
  generating: "Drawing the sticker",
  cutting: "Cutting it out",
  ready: "Ready",
  error: "Failed",
};

let layerSeq = 0;
const nextId = () => `layer-${Date.now().toString(36)}-${++layerSeq}`;

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="flex justify-between text-[11px] text-light-500 dark:text-dark-400">
        <span>{label}</span>
        <span className="tabular-nums">{format(value)}</span>
      </span>
      <input
        type="range"
        className="w-full accent-splash"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Overlay Composite: a clip plus up to four RGBA layers (uploaded PNG / WebP
 * stills, WebM / MOV clips with alpha, or illustrated looks generated and cut
 * out on the fly), each placed, sized, faded, blended and timed, composited
 * with stock nodes.
 */
export function OverlayRunner({
  card,
  ctx,
  onBack,
}: {
  card: HubCard;
  ctx: EngineContext;
  onBack: () => void;
}) {
  const clientId = useGenerationStore((s) => s.clientId);
  const addRun = useGenerationStore((s) => s.addRun);
  const [video, setVideo] = useState<ToolVideo | null>(null);
  const [layers, setLayers] = useState<OverlayInputLayer[]>([]);
  const [status, setStatus] = useState<
    Record<string, { status: OverlayLayerStatus; error?: string }>
  >({});
  const [lookExtra, setLookExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [result, setResult] = useState<StepOutput | null>(null);
  const cancelled = useRef(false);
  const clip = useRef<OverlayDeps["clip"]>(undefined);
  const stillRef = useRef<HTMLInputElement>(null);
  const clipRef = useRef<HTMLInputElement>(null);

  const looks = overlayLooksAvailable(ctx);
  const full = layers.length >= OVERLAY_MAX_LAYERS;
  const span = overlaySeconds(video?.duration);
  const frame = {
    width: video?.width || 16,
    height: video?.height || 9,
  };

  const patch = (id: string, p: Partial<OverlayInputLayer>) =>
    setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, ...p } : l)));

  const addLook = (lookId: string) => {
    if (full) return;
    setLayers((ls) => [...ls, lookLayer(lookId, nextId())]);
  };

  const addFile = async (file: File | undefined, kind: "image" | "video") => {
    if (!file || full) return;
    setPickError(null);
    const okType = kind === "image" ? STILL_TYPES : CLIP_TYPES;
    if (!okType.test(file.name)) {
      setPickError(
        kind === "image"
          ? "Overlays need transparency: use a PNG or WebP."
          : "Animated overlays need alpha: use WebM (VP9) or MOV (ProRes 4444).",
      );
      return;
    }
    if (file.size > MAX_VIDEO_UPLOAD_BYTES) {
      setPickError(
        `That file is ${Math.round(file.size / 1048576)} MB; the limit is ${MAX_VIDEO_UPLOAD_BYTES / 1048576} MB.`,
      );
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const size =
        kind === "image"
          ? await measureImage(dataUrl)
          : await probeClip(dataUrl);
      if (!size || !size.width || !size.height) {
        setPickError("Couldn't read that file's size.");
        return;
      }
      setLayers((ls) => [
        ...ls,
        uploadLayer({
          id: nextId(),
          kind,
          label: file.name,
          dataUrl,
          width: size.width,
          height: size.height,
        }),
      ]);
    } catch {
      setPickError("Couldn't read that file.");
    }
  };

  let validation: string | null = null;
  if (!video) validation = "Add a clip first.";
  else if (layers.length === 0) validation = "Add at least one overlay.";
  else if (
    !looks.available &&
    layers.some((l) => l.source === "look" && !l.ref)
  )
    validation = looks.reason;

  const run = async () => {
    if (!video) return;
    cancelled.current = false;
    setBusy(true);
    setError(null);
    setResult(null);
    const deps: OverlayDeps = {
      fetchImpl: fetch,
      clientId,
      onRun: addRun,
      measure: (url) => measureVideo(url),
      toDataUrl,
      imageSize: measureImage,
      isCancelled: () => cancelled.current,
      clip: clip.current,
    };
    try {
      const out = await runOverlayComposite(
        { video, layers, lookExtra: lookExtra.trim() || undefined },
        deps,
        (id, u) => {
          setStatus((s) => ({
            ...s,
            [id]: { status: u.status, error: u.error },
          }));
          if (u.ref)
            patch(id, {
              ref: u.ref,
              ...(u.previewUrl ? { previewUrl: u.previewUrl } : {}),
              ...(u.width ? { width: u.width } : {}),
              ...(u.height ? { height: u.height } : {}),
            });
        },
      );
      clip.current = deps.clip;
      setLayers(out.layers);
      setResult(out.output);
      showToast(`${card.title}: clip ready.`, "success");
    } catch (e) {
      if (cancelled.current) showToast("Stopped.", "info");
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <RunnerShell
      title={card.title}
      subtitle={card.subtitle}
      model={card.model}
      blockedReason={card.available ? null : card.unavailableReason}
      checking={card.checking}
      onBack={onBack}
      testId="overlay-composite"
    >
      <fieldset disabled={busy} className="space-y-4">
        <ToolVideoInput
          label="Clip"
          value={video}
          onChange={(v) => {
            setVideo(v);
            clip.current = undefined;
            setResult(null);
          }}
          note={`The first ${OVERLAY_MAX_SECONDS} s are used, at 24 fps and up to 1280 px.`}
        />

        {video && layers.length > 0 && (
          <div
            className="relative mx-auto w-full max-w-xl overflow-hidden rounded-xl bg-black"
            style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
            data-testid="overlay-preview"
          >
            <video
              src={video.previewUrl}
              muted
              loop
              autoPlay
              playsInline
              className="absolute inset-0 h-full w-full object-fill"
            />
            {layers.map((l) => {
              const box = overlayPreviewBox(l, frame);
              const style = {
                left: `${box.left}%`,
                top: `${box.top}%`,
                width: `${box.width}%`,
                height: `${box.height}%`,
                opacity: l.opacity,
                mixBlendMode: OVERLAY_CSS_BLEND[l.blend],
              } as React.CSSProperties;
              if (!l.previewUrl)
                return (
                  <div
                    key={l.id}
                    style={style}
                    className="absolute flex items-center justify-center rounded-md border-2 border-dashed border-white/70 text-center text-[10px] font-medium text-white"
                  >
                    {l.label}
                  </div>
                );
              return l.kind === "video" ? (
                <video
                  key={l.id}
                  src={l.previewUrl}
                  muted
                  loop
                  autoPlay
                  playsInline
                  style={style}
                  className="absolute object-fill"
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={l.id}
                  src={l.previewUrl}
                  alt=""
                  style={style}
                  className="absolute object-fill"
                />
              );
            })}
          </div>
        )}

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
              Overlays ({layers.length}/{OVERLAY_MAX_LAYERS})
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={full}
                onClick={() => stillRef.current?.click()}
                className="flex items-center gap-1 rounded-lg border border-light-100 px-2.5 py-1.5 text-[11px] disabled:opacity-40 dark:border-dark-750"
              >
                <ImagePlus className="h-3.5 w-3.5" /> PNG / WebP
              </button>
              <button
                type="button"
                disabled={full}
                onClick={() => clipRef.current?.click()}
                className="flex items-center gap-1 rounded-lg border border-light-100 px-2.5 py-1.5 text-[11px] disabled:opacity-40 dark:border-dark-750"
              >
                <Film className="h-3.5 w-3.5" /> WebM / MOV
              </button>
            </div>
            <input
              ref={stillRef}
              type="file"
              accept="image/png,image/webp,.png,.webp"
              className="hidden"
              onChange={(e) => {
                void addFile(e.target.files?.[0], "image");
                e.target.value = "";
              }}
            />
            <input
              ref={clipRef}
              type="file"
              accept="video/webm,video/quicktime,.webm,.mov"
              className="hidden"
              onChange={(e) => {
                void addFile(e.target.files?.[0], "video");
                e.target.value = "";
              }}
            />
          </div>
          {pickError && <p className="text-[11px] text-red-500">{pickError}</p>}

          <div className="space-y-1.5">
            <span className="text-[11px] text-light-500 dark:text-dark-400">
              Or add an illustrated look (drawn, cut out, then composited)
            </span>
            <div className="flex flex-wrap gap-1.5" data-testid="overlay-looks">
              {OVERLAY_LOOKS.map((look) => (
                <button
                  key={look.id}
                  type="button"
                  disabled={full || !looks.available}
                  title={
                    looks.available ? undefined : (looks.reason ?? undefined)
                  }
                  onClick={() => addLook(look.id)}
                  className="rounded-full border border-light-100 px-3 py-1 text-[11px] text-light-primary transition-colors hover:border-splash hover:text-splash disabled:opacity-40 dark:border-dark-750 dark:text-dark-primary"
                >
                  {look.label}
                </button>
              ))}
            </div>
            {!looks.available && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                {looks.reason}
              </p>
            )}
          </div>

          {layers.some((l) => l.source === "look") && (
            <label className="block space-y-1">
              <span className="text-[11px] text-light-500 dark:text-dark-400">
                Look theme (optional, added to every look)
              </span>
              <input
                className={field}
                value={lookExtra}
                maxLength={120}
                placeholder="e.g. pastel palette, holiday theme"
                onChange={(e) => {
                  setLookExtra(e.target.value);
                  setLayers((ls) =>
                    ls.map((l) =>
                      l.source === "look"
                        ? { ...l, ref: undefined, previewUrl: undefined }
                        : l,
                    ),
                  );
                }}
              />
            </label>
          )}

          <ol className="space-y-2" data-testid="overlay-layers">
            {layers.map((l, i) => {
              const st = status[l.id];
              return (
                <li
                  key={l.id}
                  className="space-y-2 rounded-lg border border-light-100 p-3 dark:border-dark-750"
                >
                  <div className="flex items-center gap-2 text-xs">
                    <Layers className="h-3.5 w-3.5 text-light-500" />
                    <span className="flex-1 truncate text-light-primary dark:text-dark-primary">
                      {i + 1}. {l.label}
                      {l.kind === "video" ? " (animated)" : ""}
                    </span>
                    {st && (
                      <span className="flex items-center gap-1 text-[11px] text-light-500 dark:text-dark-400">
                        {st.status === "ready" ? (
                          <Check className="h-3 w-3 text-emerald-500" />
                        ) : st.status === "error" ? (
                          <X className="h-3 w-3 text-red-500" />
                        ) : (
                          <Loader2 className="h-3 w-3 animate-spin text-splash" />
                        )}
                        {STATUS_LABEL[st.status]}
                      </span>
                    )}
                    <button
                      type="button"
                      aria-label={`Remove ${l.label}`}
                      onClick={() =>
                        setLayers((ls) => ls.filter((x) => x.id !== l.id))
                      }
                      className="text-light-500 hover:text-red-500"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {st?.error && (
                    <p className="text-[11px] text-red-500">{st.error}</p>
                  )}
                  <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                    <Slider
                      label="Left / right"
                      value={l.x}
                      min={0}
                      max={1}
                      step={0.01}
                      format={pct}
                      onChange={(x) => patch(l.id, { x })}
                    />
                    <Slider
                      label="Up / down"
                      value={l.y}
                      min={0}
                      max={1}
                      step={0.01}
                      format={pct}
                      onChange={(y) => patch(l.id, { y })}
                    />
                    <Slider
                      label="Size (of frame width)"
                      value={l.scale}
                      min={OVERLAY_MIN_SCALE}
                      max={OVERLAY_MAX_SCALE}
                      step={0.01}
                      format={pct}
                      onChange={(scale) => patch(l.id, { scale })}
                    />
                    <Slider
                      label="Opacity"
                      value={l.opacity}
                      min={0}
                      max={1}
                      step={0.01}
                      format={pct}
                      onChange={(opacity) => patch(l.id, { opacity })}
                    />
                    <label className="block space-y-1">
                      <span className="text-[11px] text-light-500 dark:text-dark-400">
                        Blend
                      </span>
                      <select
                        className={field}
                        value={l.blend}
                        onChange={(e) =>
                          patch(l.id, { blend: e.target.value as OverlayBlend })
                        }
                      >
                        {OVERLAY_BLENDS.map((b) => (
                          <option key={b} value={b}>
                            {OVERLAY_BLEND_LABELS[b]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block space-y-1">
                        <span className="text-[11px] text-light-500 dark:text-dark-400">
                          Start (s)
                        </span>
                        <input
                          type="number"
                          className={field}
                          min={0}
                          max={span}
                          step={0.1}
                          value={l.start}
                          onChange={(e) =>
                            patch(l.id, {
                              start: Math.max(0, Number(e.target.value) || 0),
                            })
                          }
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-[11px] text-light-500 dark:text-dark-400">
                          End (s)
                        </span>
                        <input
                          type="number"
                          className={field}
                          min={0}
                          max={span}
                          step={0.1}
                          value={l.end ?? ""}
                          placeholder="end"
                          onChange={(e) =>
                            patch(l.id, {
                              end:
                                e.target.value === ""
                                  ? null
                                  : Math.max(0, Number(e.target.value) || 0),
                            })
                          }
                        />
                      </label>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
          {video && typeof video.duration !== "number" && layers.length > 0 && (
            <p className="text-[11px] text-light-500 dark:text-dark-400">
              The clip length is unknown, so overlays stay on for the whole
              clip.
            </p>
          )}
        </section>
      </fieldset>

      <div className="flex flex-wrap items-start gap-2">
        <RunFooter
          label="Composite"
          busy={busy}
          disabled={!card.available}
          validation={validation}
          error={error}
          queuedText={null}
          onRun={() => void run()}
          icon={<Layers className="h-4 w-4" />}
        />
        {busy && (
          <button
            type="button"
            onClick={() => {
              cancelled.current = true;
            }}
            className="flex items-center gap-1.5 rounded-xl border border-light-100 px-4 py-2.5 text-sm dark:border-dark-750"
          >
            <Square className="h-3.5 w-3.5" /> Stop after this step
          </button>
        )}
      </div>

      {result && (
        <video
          src={result.url}
          controls
          playsInline
          className="mx-auto max-h-[70vh] rounded-xl"
          data-testid="overlay-result"
        />
      )}
    </RunnerShell>
  );
}
