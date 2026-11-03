"use client";

import { useEffect, useRef, useState } from "react";
import { LayoutGrid, Square } from "lucide-react";
import { useGenerationStore } from "@/store";
import { showToast } from "@/components/Toast";
import type { EngineContext } from "@/lib/tools/templates";
import type { HubCard } from "@/lib/tools/hub";
import type { ToolAudio, ToolImage, ToolVideo } from "@/lib/tools/runTool";
import { analyzeAudioUrl, type BeatAnalysis } from "@/lib/tools/beats";
import {
  GRID_ASPECTS,
  GRID_INTENSITIES,
  GRID_MAX_DEFAULT,
  GRID_MAX_MAX,
  GRID_MAX_MIN,
  GRID_SOURCE_MAX_SECONDS,
  GRID_STYLES,
  GRID_STYLE_INFO,
  GRID_VIDEO_MAX_SECONDS,
  GRID_VIDEO_MIN_SECONDS,
  type GridAspect,
  type GridIntensity,
  type GridStyle,
} from "@/lib/tools/gridVideo";
import {
  runGridVideo,
  type GridVideoResult,
} from "@/lib/tools/gridVideoRunner";
import { RunFooter, RunnerShell, errorMessage } from "./RunnerShell";
import { Segmented } from "./ToolRunner";
import { measureMedia } from "./DubRunner";
import { ToolVideoInput } from "./ToolVideoInput";
import { ToolImageInput } from "./ToolImageInput";
import { ToolAudioInput } from "./ToolAudioInput";

const GRID_SIZES = Array.from(
  { length: GRID_MAX_MAX - GRID_MAX_MIN + 1 },
  (_, i) => GRID_MAX_MIN + i,
);

/**
 * Grid Video: one short clip (or a still) + a song -> a beat-synced grid
 * music video as long as the song. Beats are detected in the browser; the
 * CJGridVideo node renders the plan on the ComfyUI box (no model).
 */
export function GridVideoRunner({
  card,
  onBack,
}: {
  card: HubCard;
  ctx: EngineContext;
  onBack: () => void;
}) {
  const clientId = useGenerationStore((s) => s.clientId);
  const addRun = useGenerationStore((s) => s.addRun);
  const [kind, setKind] = useState<"video" | "image">("video");
  const [video, setVideo] = useState<ToolVideo | null>(null);
  const [image, setImage] = useState<ToolImage | null>(null);
  const [music, setMusic] = useState<ToolAudio | null>(null);
  const [beats, setBeats] = useState<BeatAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [style, setStyle] = useState<GridStyle>("poster");
  const [aspect, setAspect] = useState<GridAspect>("1:1");
  const [gridMax, setGridMax] = useState(String(GRID_MAX_DEFAULT));
  const [intensity, setIntensity] = useState<GridIntensity>("medium");
  const [hd, setHd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GridVideoResult | null>(null);
  const cancelled = useRef(false);

  // Beat detection runs once per picked track (WebAudio, in the browser).
  useEffect(() => {
    setBeats(null);
    if (!music) return;
    let live = true;
    setAnalyzing(true);
    analyzeAudioUrl(music.previewUrl)
      .then((a) => live && setBeats(a))
      .catch(() => live && setBeats(null))
      .finally(() => live && setAnalyzing(false));
    return () => {
      live = false;
    };
  }, [music]);

  const sourceData =
    kind === "video"
      ? video?.dataUrl
        ? { dataUrl: video.dataUrl, label: video.label }
        : null
      : image?.dataUrl
        ? { dataUrl: image.dataUrl, label: image.label }
        : null;
  const musicSeconds = music?.duration ?? null;
  const validation = !sourceData
    ? kind === "video"
      ? "Add a source clip."
      : "Pick a source image."
    : !music
      ? "Add a music track."
      : musicSeconds === null
        ? "Couldn't read the music length."
        : musicSeconds < GRID_VIDEO_MIN_SECONDS
          ? `The music is under ${GRID_VIDEO_MIN_SECONDS} s.`
          : analyzing
            ? "Finding the beats..."
            : null;

  const go = async () => {
    if (!sourceData || !music || musicSeconds === null) return;
    cancelled.current = false;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await runGridVideo(
        {
          kind,
          dataUrl: sourceData.dataUrl,
          label: sourceData.label,
          seconds: kind === "video" ? (video?.duration ?? null) : null,
        },
        {
          dataUrl: music.dataUrl,
          label: music.label,
          seconds: musicSeconds,
          beats: beats?.beats ?? [],
          bpm: beats?.bpm ?? null,
        },
        {
          style,
          aspect,
          gridMax: Number(gridMax),
          intensity,
          resolution: hd ? 1080 : 720,
        },
        {
          fetchImpl: fetch,
          clientId,
          onRun: addRun,
          measure: measureMedia,
          isCancelled: () => cancelled.current,
        },
      );
      setResult(res);
      showToast(`${card.title}: done.`, "success");
    } catch (e) {
      if (cancelled.current) showToast("Stopped waiting.", "info");
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const beatNote = !music
    ? `The video is as long as the song (up to ${GRID_VIDEO_MAX_SECONDS} s); cuts land on its beats.`
    : analyzing
      ? "Finding the beats..."
      : beats && beats.confidence > 0
        ? `${Math.round(beats.bpm)} BPM, ${beats.beats.length} beats found.`
        : "No clear beat found; cuts follow a steady 120 BPM grid.";

  return (
    <RunnerShell
      title={card.title}
      subtitle={card.subtitle}
      model={card.model}
      blockedReason={card.available ? null : card.unavailableReason}
      checking={card.checking}
      onBack={onBack}
      testId="grid-video"
    >
      <fieldset disabled={busy} className="space-y-4">
        <Segmented
          label="Source"
          value={kind}
          options={[
            { id: "video", label: "Clip" },
            { id: "image", label: "Image" },
          ]}
          onChange={(v) => setKind(v as "video" | "image")}
        />
        {kind === "video" ? (
          <ToolVideoInput
            label="Source clip"
            value={video}
            onChange={setVideo}
            note={`A short clip; the first ${GRID_SOURCE_MAX_SECONDS} s are used and loop back and forth to fill the song.`}
          />
        ) : (
          <ToolImageInput
            label="Source image"
            value={image}
            onChange={setImage}
            needsPixels
          />
        )}
        <ToolAudioInput
          label="Music"
          value={music}
          onChange={setMusic}
          note={beatNote}
        />
        <Segmented
          label="Style"
          value={style}
          options={GRID_STYLES.map((s) => ({
            id: s,
            label: GRID_STYLE_INFO[s].label,
          }))}
          onChange={(v) => setStyle(v as GridStyle)}
        />
        <p className="-mt-2 text-[11px] text-light-500 dark:text-dark-400">
          {GRID_STYLE_INFO[style].blurb}
        </p>
        <Segmented
          label="Aspect"
          value={aspect}
          options={GRID_ASPECTS.map((a) => ({ id: a, label: a }))}
          onChange={(v) => setAspect(v as GridAspect)}
        />
        <Segmented
          label="Largest grid"
          value={gridMax}
          options={GRID_SIZES.map((n) => ({
            id: String(n),
            label: `${n}x${n}`,
          }))}
          onChange={setGridMax}
        />
        <Segmented
          label="Intensity"
          value={intensity}
          options={GRID_INTENSITIES.map((i) => ({
            id: i,
            label: i === "low" ? "Calm" : i === "medium" ? "Punchy" : "Frantic",
          }))}
          onChange={(v) => setIntensity(v as GridIntensity)}
        />
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={hd}
            onChange={(e) => setHd(e.target.checked)}
          />
          1080p (slower; default 720p)
        </label>
      </fieldset>

      <div className="flex flex-wrap items-start gap-2">
        <RunFooter
          label="Make grid video"
          busy={busy}
          disabled={!card.available}
          validation={validation}
          error={error}
          queuedText={null}
          onRun={() => void go()}
          icon={<LayoutGrid className="h-4 w-4" />}
        />
        {busy && (
          <button
            type="button"
            onClick={() => {
              cancelled.current = true;
            }}
            className="flex items-center gap-1.5 rounded-xl border border-light-100 px-4 py-2.5 text-sm dark:border-dark-750"
          >
            <Square className="h-3.5 w-3.5" /> Stop waiting
          </button>
        )}
      </div>

      {result && (
        <section className="space-y-3" data-testid="grid-video-result">
          <video
            src={result.video.url}
            controls
            playsInline
            className="mx-auto max-h-[70vh] rounded-xl"
            data-testid="grid-video-video"
          />
        </section>
      )}
    </RunnerShell>
  );
}
