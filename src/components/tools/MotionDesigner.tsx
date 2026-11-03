"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  Loader2,
  Mic,
  Music,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Upload,
  Wand2,
} from "lucide-react";
import { useGenerationStore } from "@/store";
import { ASPECTS, type Aspect, type MotionSpec } from "@/lib/motion/spec";
import {
  MOTION_TEMPLATES,
  THEMES,
  buildTemplate,
  compileOutline,
  templateById,
  themeById,
  type Outline,
  type TemplateInput,
} from "@/lib/motion/templates";
import { renderFrame } from "@/lib/motion/render";
import { locate, sceneSpans, totalDuration } from "@/lib/motion/timeline";
import { MOTION_SCENES, MOTION_TONES } from "@/lib/motion/prompt";
import {
  MUSIC_MOODS,
  exportFilename,
  musicBed,
  narrate,
  uploadExport,
  writeOutline,
  type AudioCue,
} from "@/lib/motion/client";
import {
  blobToDataUrl,
  exportSize,
  extensionFor,
  recordSpec,
} from "@/lib/motion/exporter";
import {
  VOICEOVER_KOKORO_DEFAULT_VOICE,
  VOICEOVER_KOKORO_VOICES,
} from "@/lib/oj/voiceoverVoices";
import type { ToolVideo } from "@/lib/tools/runTool";
import { MOTION_MODEL_LINE } from "@/lib/tools/motionCard";
import { RunnerShell, errorMessage } from "./RunnerShell";
import { ToolVideoInput } from "./ToolVideoInput";
import { MotionJsonEditor, MotionSceneForm } from "./MotionSpecEditor";

const PREVIEW_SCALE = 0.75;
const card =
  "rounded-xl border border-light-100 dark:border-dark-750 bg-white/60 dark:bg-dark-900/40";
const chip = (on: boolean) =>
  `rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
    on
      ? "border-splash bg-splash/10 text-splash"
      : "border-light-100 dark:border-dark-750 text-light-500 dark:text-dark-400 hover:border-splash/60"
  }`;
const field =
  "w-full rounded-lg border border-light-100 dark:border-dark-750 bg-white dark:bg-dark-900 px-2.5 py-2 text-sm text-light-primary dark:text-dark-primary focus:border-splash focus:outline-none";
const ghostBtn =
  "flex items-center gap-1.5 rounded-xl border border-light-100 dark:border-dark-750 px-3.5 py-2 text-sm text-light-500 dark:text-dark-400 hover:border-splash/60 hover:text-splash disabled:cursor-not-allowed disabled:opacity-40";
const primaryBtn =
  "flex items-center gap-2 rounded-xl bg-splash px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40";

const ASPECT_LABEL: Record<Aspect, string> = {
  "16:9": "16:9 landscape",
  "9:16": "9:16 vertical",
  "1:1": "1:1 square",
  "4:5": "4:5 portrait",
};

function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function usesVideo(spec: MotionSpec): boolean {
  return (
    spec.background === "video" ||
    spec.scenes.some((s) => s.background === "video")
  );
}

/** Template thumbnail: one still frame of the template's sample. */
function TemplateThumb({
  id,
  active,
  onPick,
}: {
  id: string;
  active: boolean;
  onPick: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const t = templateById(id);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    try {
      const spec = buildTemplate(id, {}, { aspect: "16:9" });
      const span = sceneSpans(spec)[Math.min(1, spec.scenes.length - 1)];
      renderFrame(
        ctx,
        spec,
        Math.min(
          span.end - 0.05,
          span.start +
            spec.scenes[Math.min(1, spec.scenes.length - 1)].duration * 0.8,
        ),
      );
    } catch {
      /* thumbnails are decoration */
    }
  }, [id]);
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={active}
      className={`group overflow-hidden rounded-xl border text-left transition-colors ${
        active
          ? "border-splash ring-1 ring-splash"
          : "border-light-100 dark:border-dark-750 hover:border-splash/60"
      }`}
    >
      <canvas
        ref={ref}
        width={320}
        height={180}
        className="block aspect-video w-full bg-black"
        aria-hidden
      />
      <span className="block px-2 py-1.5">
        <span className="block text-xs font-medium text-light-primary dark:text-dark-primary">
          {t.label}
        </span>
        <span className="line-clamp-2 block text-[11px] leading-snug text-light-500 dark:text-dark-400">
          {t.description}
        </span>
      </span>
    </button>
  );
}

export function MotionDesigner({ onBack }: { onBack: () => void }) {
  const clientId = useGenerationStore((s) => s.clientId);
  const [mode, setMode] = useState<"template" | "ai">("template");
  const [templateId, setTemplateId] = useState(MOTION_TEMPLATES[0].id);
  const [inputs, setInputs] = useState<TemplateInput>(
    MOTION_TEMPLATES[0].sample,
  );
  const [themeId, setThemeId] = useState(MOTION_TEMPLATES[0].theme);
  const [aspect, setAspect] = useState<Aspect>(MOTION_TEMPLATES[0].aspect);
  const [pace, setPace] = useState(1);
  const [outline, setOutline] = useState<Outline | null>(null);
  const [spec, setSpec] = useState<MotionSpec>(() =>
    buildTemplate(MOTION_TEMPLATES[0].id),
  );
  const [edited, setEdited] = useState(false);
  const [editTab, setEditTab] = useState<"scenes" | "json">("scenes");

  // AI brief
  const [brief, setBrief] = useState("");
  const [sceneCount, setSceneCount] = useState<number>(MOTION_SCENES.default);
  const [tone, setTone] = useState<string>("clear");
  const [writing, setWriting] = useState(false);

  // Audio
  const [voice, setVoice] = useState(VOICEOVER_KOKORO_DEFAULT_VOICE);
  const [mood, setMood] = useState("upbeat");
  const [voiceCues, setVoiceCues] = useState<AudioCue[]>([]);
  const [music, setMusic] = useState<AudioCue | null>(null);
  const [audioBusy, setAudioBusy] = useState<string | null>(null);

  // Lower-third footage
  const [clip, setClip] = useState<ToolVideo | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Export
  const [exporting, setExporting] = useState(false);
  const [exportPct, setExportPct] = useState(0);
  const [result, setResult] = useState<{
    url: string;
    blob: Blob;
    mime: string;
  } | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  // Preview playback (DOM-driven so 60 fps doesn't re-render React).
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrubRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const tRef = useRef(0);
  const [playing, setPlaying] = useState(true);
  const [activeScene, setActiveScene] = useState(0);
  const duration = useMemo(() => totalDuration(spec), [spec]);
  const template = templateById(templateId);

  // Rebuild from the template form / style controls.
  const rebuild = useCallback(
    (next: {
      templateId?: string;
      inputs?: TemplateInput;
      themeId?: string;
      aspect?: Aspect;
      pace?: number;
      outline?: Outline | null;
    }) => {
      const tid = next.templateId ?? templateId;
      const th = next.themeId ?? themeId;
      const asp = next.aspect ?? aspect;
      const pce = next.pace ?? pace;
      const ol = next.outline !== undefined ? next.outline : outline;
      try {
        const s =
          mode === "ai" && ol
            ? compileOutline(ol, { aspect: asp, theme: th, pace: pce })
            : buildTemplate(tid, next.inputs ?? inputs, {
                aspect: asp,
                theme: th,
                pace: pce,
              });
        setSpec(s);
        setEdited(false);
        setVoiceCues([]);
        setMusic(null);
        tRef.current = 0;
        setPlaying(true);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [templateId, themeId, aspect, pace, outline, mode, inputs],
  );

  const pickTemplate = (id: string) => {
    const t = templateById(id);
    setMode("template");
    setTemplateId(id);
    setInputs(t.sample);
    setThemeId(t.theme);
    setAspect(t.aspect);
    try {
      setSpec(
        buildTemplate(id, {}, { aspect: t.aspect, theme: t.theme, pace }),
      );
      setEdited(false);
      setVoiceCues([]);
      setMusic(null);
      tRef.current = 0;
      setPlaying(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const setInput = <K extends keyof TemplateInput>(
    k: K,
    v: TemplateInput[K],
  ) => {
    const next = { ...inputs, [k]: v };
    setInputs(next);
    rebuild({ inputs: next });
  };

  const editSpec = (next: MotionSpec) => {
    setSpec(next);
    setEdited(true);
  };

  // Video element for "video" backgrounds.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (clip?.previewUrl) {
      v.src = clip.previewUrl;
      v.load();
    } else {
      v.removeAttribute("src");
      v.load();
    }
  }, [clip]);

  // Render loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { width, height } = exportSize(spec, PREVIEW_SCALE);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    let raf = 0;
    let last = performance.now();
    let lastScene = -1;
    const video = videoRef.current;
    const hasVideo = usesVideo(spec) && !!clip;
    if (hasVideo && video) {
      if (playing) void video.play().catch(() => undefined);
      else video.pause();
    }
    const frame = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (playing && !exporting) {
        tRef.current += dt;
        if (tRef.current >= duration) {
          tRef.current = 0;
          if (hasVideo && video) video.currentTime = 0;
        }
      }
      const t = Math.min(tRef.current, Math.max(0, duration - 1e-3));
      try {
        renderFrame(ctx, spec, t, { video: hasVideo ? video : null });
      } catch {
        /* a half-edited spec shouldn't kill the loop */
      }
      if (scrubRef.current) scrubRef.current.value = String(t);
      if (timeRef.current)
        timeRef.current.textContent = `${fmtTime(t)} / ${fmtTime(duration)}`;
      const sc = locate(spec, t).index;
      if (sc !== lastScene) {
        lastScene = sc;
        setActiveScene(sc);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [spec, playing, duration, clip, exporting]);

  const seek = (t: number) => {
    tRef.current = Math.max(0, Math.min(duration, t));
    const v = videoRef.current;
    if (v && clip)
      v.currentTime = Math.min(
        tRef.current,
        Number.isFinite(v.duration) ? v.duration : tRef.current,
      );
  };

  const seekScene = (i: number) => {
    const span = sceneSpans(spec)[i];
    if (span) seek(span.start + 0.01);
  };

  const deps = useMemo(
    () => ({
      fetchImpl: (u: string, init?: RequestInit) => fetch(u, init),
      clientId,
    }),
    [clientId],
  );

  const writeWithAi = async () => {
    setError(null);
    setWarning(null);
    setWriting(true);
    try {
      const { outline: ol } = await writeOutline(deps, {
        brief,
        scenes: sceneCount,
        tone,
        whiteboard: themeById(themeId).theme.font === "hand",
      });
      setOutline(ol);
      setMode("ai");
      const s = compileOutline(ol, { aspect, theme: themeId, pace });
      setSpec(s);
      setEdited(false);
      setVoiceCues([]);
      setMusic(null);
      tRef.current = 0;
      setPlaying(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setWriting(false);
    }
  };

  const addVoice = async () => {
    setError(null);
    setAudioBusy("Voicing scene 1…");
    try {
      const cues = await narrate(deps, spec, voice, (done, total) =>
        setAudioBusy(
          done < total
            ? `Voicing scene ${done + 1} of ${total}…`
            : "Finishing…",
        ),
      );
      if (!cues.length)
        setWarning(
          "No scene has narration to voice. Add a line under a scene.",
        );
      setVoiceCues(cues);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setAudioBusy(null);
    }
  };

  const addMusic = async () => {
    setError(null);
    setAudioBusy("Composing the music bed…");
    try {
      setMusic(await musicBed(deps, spec, mood));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setAudioBusy(null);
    }
  };

  const doExport = async () => {
    setError(null);
    setUploaded(null);
    if (usesVideo(spec) && !clip)
      setWarning(
        "No clip added: the lower third exports over a placeholder background.",
      );
    setExporting(true);
    setExportPct(0);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const video = usesVideo(spec) && clip ? videoRef.current : null;
      const r = await recordSpec(spec, {
        assets: { video },
        video,
        voice: voiceCues,
        music,
        onProgress: setExportPct,
        signal: ac.signal,
      });
      if (result) URL.revokeObjectURL(result.url);
      setResult({
        url: URL.createObjectURL(r.blob),
        blob: r.blob,
        mime: r.mime,
      });
    } catch (e) {
      if (!ac.signal.aborted) setError(errorMessage(e));
    } finally {
      setExporting(false);
      abortRef.current = null;
    }
  };

  useEffect(
    () => () => {
      if (result) URL.revokeObjectURL(result.url);
    },
    [result],
  );

  const download = () => {
    if (!result) return;
    const a = document.createElement("a");
    a.href = result.url;
    a.download = exportFilename(spec.title, result.mime).replace(
      /^cj_motion_/,
      "motion_",
    );
    a.click();
  };

  const upload = async () => {
    if (!result) return;
    setUploading(true);
    setError(null);
    try {
      const dataUrl = await blobToDataUrl(result.blob);
      setUploaded(
        await uploadExport(
          deps.fetchImpl,
          dataUrl,
          exportFilename(spec.title, result.mime),
        ),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  const nativeSize = ASPECTS[spec.aspect];
  const portrait = nativeSize.height > nativeSize.width;
  const spans = useMemo(() => sceneSpans(spec), [spec]);
  const showClip = usesVideo(spec);

  return (
    <RunnerShell
      title="Motion Designer"
      subtitle="Animated explainers, kinetic type, stat reveals, whiteboard steps and lower thirds. Start from a template or a brief, tweak every scene, export a video."
      model={MOTION_MODEL_LINE}
      onBack={onBack}
      testId="motion-designer"
    >
      {/* Preview */}
      <section className={`${card} overflow-hidden`}>
        <div
          className={`flex justify-center bg-black ${portrait ? "py-3" : ""}`}
        >
          <canvas
            ref={canvasRef}
            className={
              portrait
                ? "block h-[min(62vh,560px)] w-auto"
                : "block h-auto w-full"
            }
            style={{
              aspectRatio: `${nativeSize.width} / ${nativeSize.height}`,
            }}
            aria-label="Motion preview"
            data-testid="motion-preview"
            onClick={() => setPlaying((p) => !p)}
          />
        </div>
        <div className="flex items-center gap-3 px-3 py-2">
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-splash text-white hover:opacity-90"
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="ml-0.5 h-4 w-4" />
            )}
          </button>
          <div className="relative flex-1">
            <input
              ref={scrubRef}
              type="range"
              min={0}
              max={duration}
              step={0.01}
              defaultValue={0}
              aria-label="Scrub"
              className="relative z-10 w-full accent-splash"
              onInput={(e) => {
                setPlaying(false);
                seek(Number((e.target as HTMLInputElement).value));
              }}
            />
            <div
              className="pointer-events-none absolute inset-x-0 top-1/2 flex h-3 -translate-y-1/2"
              aria-hidden
            >
              {spans.slice(1).map((s, i) => (
                <span
                  key={i}
                  className="absolute h-3 w-px bg-light-500/50"
                  style={{
                    left: `${(s.start / Math.max(0.01, duration)) * 100}%`,
                  }}
                />
              ))}
            </div>
          </div>
          <span
            ref={timeRef}
            className="w-24 flex-shrink-0 text-right text-[11px] tabular-nums text-light-500 dark:text-dark-400"
          >
            0:00.0
          </span>
        </div>
        <div className="flex flex-wrap gap-1 border-t border-light-100 dark:border-dark-750 px-3 py-2">
          {spec.scenes.map((s, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                seekScene(i);
                setPlaying(true);
              }}
              className={`rounded-md px-2 py-0.5 text-[11px] tabular-nums ${
                i === activeScene
                  ? "bg-splash/15 text-splash"
                  : "text-light-500 dark:text-dark-400 hover:text-splash"
              }`}
            >
              {i + 1} · {s.duration.toFixed(1)}s
            </button>
          ))}
          <span className="ml-auto text-[11px] text-light-500 dark:text-dark-400">
            {nativeSize.width}×{nativeSize.height} · {spec.fps} fps
            {edited ? " · edited" : ""}
          </span>
        </div>
      </section>
      <video
        ref={videoRef}
        className="hidden"
        muted
        loop
        playsInline
        crossOrigin="anonymous"
      />

      {/* Source */}
      <section className="space-y-3">
        <div className="flex gap-1.5" role="tablist" aria-label="Start from">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "template"}
            className={chip(mode === "template")}
            onClick={() => setMode("template")}
          >
            Templates
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "ai"}
            className={chip(mode === "ai")}
            onClick={() => setMode("ai")}
          >
            <span className="inline-flex items-center gap-1">
              <Sparkles className="h-3.5 w-3.5" /> Write from a brief
            </span>
          </button>
        </div>

        {mode === "template" ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {MOTION_TEMPLATES.map((t) => (
                <TemplateThumb
                  key={t.id}
                  id={t.id}
                  active={t.id === templateId}
                  onPick={() => pickTemplate(t.id)}
                />
              ))}
            </div>
            <div
              className={`${card} grid grid-cols-1 gap-3 p-3 sm:grid-cols-2`}
            >
              {template.fields.title && (
                <label className="block space-y-1 text-xs text-light-primary dark:text-dark-primary">
                  <span>{template.fields.title}</span>
                  <input
                    className={field}
                    maxLength={120}
                    value={inputs.title}
                    onChange={(e) => setInput("title", e.target.value)}
                  />
                </label>
              )}
              {template.fields.subtitle && (
                <label className="block space-y-1 text-xs text-light-primary dark:text-dark-primary">
                  <span>{template.fields.subtitle}</span>
                  <input
                    className={field}
                    maxLength={160}
                    value={inputs.subtitle}
                    onChange={(e) => setInput("subtitle", e.target.value)}
                  />
                </label>
              )}
              {template.fields.value && (
                <div className="grid grid-cols-2 gap-2">
                  <label className="block space-y-1 text-xs text-light-primary dark:text-dark-primary">
                    <span>{template.fields.value}</span>
                    <input
                      type="number"
                      className={field}
                      value={inputs.value}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n)) setInput("value", n);
                      }}
                    />
                  </label>
                  {template.fields.unit && (
                    <label className="block space-y-1 text-xs text-light-primary dark:text-dark-primary">
                      <span>{template.fields.unit}</span>
                      <input
                        className={field}
                        maxLength={8}
                        value={inputs.unit}
                        onChange={(e) => setInput("unit", e.target.value)}
                      />
                    </label>
                  )}
                </div>
              )}
              {template.fields.lines && (
                <label className="block space-y-1 text-xs text-light-primary dark:text-dark-primary sm:col-span-2">
                  <span>{template.fields.lines}</span>
                  <textarea
                    rows={Math.min(6, Math.max(3, inputs.lines.length))}
                    className={field}
                    value={inputs.lines.join("\n")}
                    onChange={(e) =>
                      setInput("lines", e.target.value.split("\n").slice(0, 8))
                    }
                  />
                </label>
              )}
              {edited && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400 sm:col-span-2">
                  Changing these fields rebuilds the video and replaces your
                  scene edits.
                </p>
              )}
            </div>
          </>
        ) : (
          <div className={`${card} space-y-3 p-3`}>
            <label className="block space-y-1 text-xs text-light-primary dark:text-dark-primary">
              <span>What should the video explain?</span>
              <textarea
                rows={3}
                maxLength={600}
                className={field}
                placeholder="e.g. A 30-second explainer on how our recycling app turns scanned receipts into rewards, ending with a download call to action."
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
              />
            </label>
            <div className="flex flex-wrap items-end gap-3">
              <label className="block space-y-1 text-xs text-light-primary dark:text-dark-primary">
                <span>Scenes</span>
                <input
                  type="number"
                  min={MOTION_SCENES.min}
                  max={MOTION_SCENES.max}
                  className={`${field} w-20`}
                  value={sceneCount}
                  onChange={(e) => setSceneCount(Number(e.target.value))}
                />
              </label>
              <label className="block space-y-1 text-xs text-light-primary dark:text-dark-primary">
                <span>Tone</span>
                <select
                  className={`${field} w-32`}
                  value={tone}
                  onChange={(e) => setTone(e.target.value)}
                >
                  {MOTION_TONES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={writeWithAi}
                disabled={writing || !brief.trim()}
                className={primaryBtn}
              >
                {writing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Wand2 className="h-4 w-4" />
                )}
                {writing ? "Writing…" : outline ? "Rewrite" : "Write the video"}
              </button>
            </div>
            <p className="text-[11px] text-light-500 dark:text-dark-400">
              The local Qwen3-VL model writes a scene outline (layouts, words,
              narration); the layout engine turns it into a validated spec you
              can edit below. Pick the Whiteboard look first for a hand-drawn
              version.
            </p>
            {outline && (
              <p className="text-[11px] text-light-500 dark:text-dark-400">
                Outline: “{outline.title}” · {outline.scenes.length} scenes (
                {outline.scenes.map((s) => s.layout).join(", ")})
              </p>
            )}
          </div>
        )}
      </section>

      {/* Look */}
      <section className="space-y-2">
        <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
          Look
        </span>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Theme">
          {THEMES.map((th) => (
            <button
              key={th.id}
              type="button"
              aria-pressed={themeId === th.id}
              onClick={() => {
                setThemeId(th.id);
                rebuild({ themeId: th.id });
              }}
              className={`${chip(themeId === th.id)} flex items-center gap-1.5`}
            >
              <span
                className="h-3.5 w-3.5 rounded-full ring-1 ring-black/10"
                style={{
                  background: `linear-gradient(135deg, ${th.theme.bg} 0 45%, ${th.theme.accent} 45% 75%, ${th.theme.accent2} 75%)`,
                }}
                aria-hidden
              />
              {th.label}
            </button>
          ))}
        </div>
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label="Aspect ratio"
        >
          {(Object.keys(ASPECTS) as Aspect[]).map((a) => (
            <button
              key={a}
              type="button"
              aria-pressed={aspect === a}
              onClick={() => {
                setAspect(a);
                rebuild({ aspect: a });
              }}
              className={chip(aspect === a)}
            >
              {ASPECT_LABEL[a]}
            </button>
          ))}
          <label className="ml-auto flex items-center gap-2 text-xs text-light-500 dark:text-dark-400">
            Pace
            <input
              type="range"
              min={0.6}
              max={1.6}
              step={0.1}
              value={2.2 - pace}
              onChange={(e) => {
                const p = Math.round((2.2 - Number(e.target.value)) * 10) / 10;
                setPace(p);
                rebuild({ pace: p });
              }}
              className="w-28 accent-splash"
              aria-label="Pace (slower to faster)"
            />
          </label>
        </div>
      </section>

      {showClip && (
        <ToolVideoInput
          label="Footage under the lower third"
          value={clip}
          onChange={setClip}
          note="The lower third is composited over this clip in the preview and the export (audio from the clip is not kept)."
        />
      )}

      {/* Editor */}
      <section className="space-y-2">
        <div
          className="flex items-center gap-1.5"
          role="tablist"
          aria-label="Edit"
        >
          <span className="mr-2 text-xs font-medium text-light-primary dark:text-dark-primary">
            Scenes
          </span>
          <button
            type="button"
            role="tab"
            aria-selected={editTab === "scenes"}
            className={chip(editTab === "scenes")}
            onClick={() => setEditTab("scenes")}
          >
            Form
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={editTab === "json"}
            className={chip(editTab === "json")}
            onClick={() => setEditTab("json")}
          >
            JSON
          </button>
          {edited && (
            <button
              type="button"
              className="ml-auto flex items-center gap-1 text-[11px] text-light-500 dark:text-dark-400 hover:text-splash"
              onClick={() => rebuild({})}
            >
              <RotateCcw className="h-3 w-3" /> Discard edits
            </button>
          )}
        </div>
        {editTab === "scenes" ? (
          <MotionSceneForm
            spec={spec}
            activeScene={activeScene}
            onChange={editSpec}
            onSeekScene={seekScene}
          />
        ) : (
          <MotionJsonEditor spec={spec} onApply={editSpec} />
        )}
      </section>

      {/* Sound */}
      <section className={`${card} space-y-3 p-3`}>
        <div className="text-xs font-medium text-light-primary dark:text-dark-primary">
          Sound (optional, runs on ComfyUI)
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block space-y-1 text-[11px] text-light-500 dark:text-dark-400">
            <span>Voice</span>
            <select
              className={`${field} w-56`}
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
            >
              {VOICEOVER_KOKORO_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={ghostBtn}
            onClick={addVoice}
            disabled={!!audioBusy || exporting}
          >
            <Mic className="h-4 w-4" />{" "}
            {voiceCues.length ? "Re-voice" : "Voice the narration"}
          </button>
          <label className="block space-y-1 text-[11px] text-light-500 dark:text-dark-400">
            <span>Music</span>
            <select
              className={`${field} w-32`}
              value={mood}
              onChange={(e) => setMood(e.target.value)}
            >
              {Object.keys(MUSIC_MOODS).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={ghostBtn}
            onClick={addMusic}
            disabled={!!audioBusy || exporting}
          >
            <Music className="h-4 w-4" />{" "}
            {music ? "New track" : "Add music bed"}
          </button>
        </div>
        <p
          className="text-[11px] text-light-500 dark:text-dark-400"
          aria-live="polite"
        >
          {audioBusy ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" /> {audioBusy}
            </span>
          ) : (
            <>
              {voiceCues.length
                ? `${voiceCues.length} voiced line${voiceCues.length > 1 ? "s" : ""}`
                : "No voiceover"}{" "}
              ·{" "}
              {music ? `${mood} music bed (ducks under the voice)` : "no music"}{" "}
              — mixed into the export.
            </>
          )}
        </p>
      </section>

      {/* Export */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {exporting ? (
            <button
              type="button"
              className={ghostBtn}
              onClick={() => abortRef.current?.abort()}
            >
              <Square className="h-4 w-4" /> Stop ({Math.round(exportPct * 100)}
              %)
            </button>
          ) : (
            <button
              type="button"
              className={primaryBtn}
              onClick={doExport}
              disabled={!!audioBusy}
            >
              <Download className="h-4 w-4" /> Export video
            </button>
          )}
          <span className="text-[11px] text-light-500 dark:text-dark-400">
            Records in real time ({duration.toFixed(1)}s) at {nativeSize.width}×
            {nativeSize.height}. MP4 when your browser can, otherwise WebM. Keep
            this tab visible while it records.
          </span>
        </div>
        {exporting && (
          <div className="h-1.5 overflow-hidden rounded-full bg-light-100 dark:bg-dark-750">
            <div
              className="h-full bg-splash transition-[width]"
              style={{ width: `${exportPct * 100}%` }}
            />
          </div>
        )}
        {result && !exporting && (
          <div className={`${card} space-y-2 p-3`}>
            <video
              src={result.url}
              controls
              playsInline
              className={`mx-auto block rounded-lg bg-black ${portrait ? "max-h-[60vh]" : "w-full"}`}
            />
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={primaryBtn} onClick={download}>
                <Download className="h-4 w-4" /> Download .
                {extensionFor(result.mime)}
              </button>
              <button
                type="button"
                className={ghostBtn}
                onClick={upload}
                disabled={uploading}
              >
                {uploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}{" "}
                Send to ComfyUI input
              </button>
              <span className="text-[11px] text-light-500 dark:text-dark-400">
                {(result.blob.size / 1024 / 1024).toFixed(1)} MB
              </span>
            </div>
            {uploaded && (
              <p className="text-[11px] text-light-500 dark:text-dark-400">
                Uploaded as{" "}
                <code className="rounded bg-light-100 px-1 dark:bg-dark-750">
                  {uploaded}
                </code>{" "}
                — pick it as the source clip in any video tool (voice, sound,
                upscale, lip sync).
              </p>
            )}
          </div>
        )}
      </section>

      {warning && (
        <p className="text-xs text-amber-600 dark:text-amber-400">{warning}</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}
    </RunnerShell>
  );
}
