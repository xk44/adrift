"use client";

import { useRef, useState } from "react";
import { AudioWaveform, Square } from "lucide-react";
import { useGenerationStore } from "@/store";
import { showToast } from "@/components/Toast";
import type { EngineContext } from "@/lib/tools/templates";
import type { HubCard } from "@/lib/tools/hub";
import type { ToolAudio, ToolVideo } from "@/lib/tools/runTool";
import {
  VOICE_CHANGE_DEFAULT_MATCH,
  VOICE_CHANGE_DEFAULT_QUALITY,
  VOICE_CHANGE_MATCHES,
  VOICE_CHANGE_QUALITIES,
  VOICE_CHANGE_TARGET_REF_SECONDS,
  voiceChangeMaxSeconds,
  voiceChangeSpan,
  type VoiceChangeMatch,
  type VoiceChangeQuality,
  type VoiceChangeSource,
} from "@/lib/tools/voiceChanger";
import {
  runVoiceChange,
  type VoiceChangeResult,
} from "@/lib/tools/voiceChangerRunner";
import { ToolAudioInput } from "./ToolAudioInput";
import { ToolVideoInput } from "./ToolVideoInput";
import { RunFooter, RunnerShell, errorMessage } from "./RunnerShell";
import { Segmented } from "./ToolRunner";
import { measureMedia } from "./DubRunner";

/**
 * Voice changer: speech (an audio file or a clip's soundtrack) + an optional
 * target voice sample -> the same words in the target voice (Chatterbox VC).
 * A clip comes back with the converted speech remuxed over its frames.
 */
export function VoiceChangerRunner({
  card,
  onBack,
}: {
  card: HubCard;
  ctx: EngineContext;
  onBack: () => void;
}) {
  const clientId = useGenerationStore((s) => s.clientId);
  const addRun = useGenerationStore((s) => s.addRun);
  const [source, setSource] = useState<VoiceChangeSource>("audio");
  const [audio, setAudio] = useState<ToolAudio | null>(null);
  const [video, setVideo] = useState<ToolVideo | null>(null);
  const [target, setTarget] = useState<ToolAudio | null>(null);
  const [quality, setQuality] = useState<VoiceChangeQuality>(
    VOICE_CHANGE_DEFAULT_QUALITY,
  );
  const [match, setMatch] = useState<VoiceChangeMatch>(
    VOICE_CHANGE_DEFAULT_MATCH,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VoiceChangeResult | null>(null);
  const cancelled = useRef(false);

  const inputSeconds = source === "audio" ? audio?.duration : video?.duration;
  const clipped =
    typeof inputSeconds === "number" &&
    inputSeconds > voiceChangeMaxSeconds(source);

  let validation: string | null = null;
  if (source === "audio" && !audio) validation = "Add the speech to convert.";
  else if (source === "video" && !video)
    validation = "Add a clip of someone talking.";

  const go = async () => {
    cancelled.current = false;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await runVoiceChange(
        { source, audio, video, target, quality, match },
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

  return (
    <RunnerShell
      title={card.title}
      subtitle={card.subtitle}
      model={card.model}
      blockedReason={card.available ? null : card.unavailableReason}
      checking={card.checking}
      onBack={onBack}
      testId="voice-changer"
      studio="audio"
    >
      <fieldset disabled={busy} className="space-y-4">
        <Segmented
          label="Convert"
          value={source}
          options={[
            { id: "audio", label: "Audio file" },
            { id: "video", label: "Video clip" },
          ]}
          onChange={(v) => {
            setSource(v as VoiceChangeSource);
            setResult(null);
          }}
        />
        {source === "audio" ? (
          <ToolAudioInput
            label="Speech to convert"
            value={audio}
            onChange={setAudio}
            note={`Up to ${voiceChangeMaxSeconds("audio")} s is converted. A clean recording of one speaker works best.`}
          />
        ) : (
          <ToolVideoInput
            label="Clip with speech"
            value={video}
            onChange={setVideo}
            note={`The first ${voiceChangeMaxSeconds("video")} s are re-voiced and the clip keeps its picture.`}
          />
        )}
        <ToolAudioInput
          label="Target voice (optional)"
          value={target}
          onChange={setTarget}
          note={`A few seconds of the voice to sound like; the first ${VOICE_CHANGE_TARGET_REF_SECONDS} s are used. Leave empty for the built-in voice. Only use voices you have permission to use.`}
        />
        <Segmented
          label="Quality"
          value={quality}
          options={VOICE_CHANGE_QUALITIES.map((q) => ({
            id: q.id,
            label: q.label,
          }))}
          onChange={(v) => setQuality(v as VoiceChangeQuality)}
        />
        <Segmented
          label="Voice match"
          value={match}
          options={VOICE_CHANGE_MATCHES.map((m) => ({
            id: m.id,
            label: m.label,
          }))}
          onChange={(v) => setMatch(v as VoiceChangeMatch)}
        />
        {clipped && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">
            Only the first {voiceChangeSpan(source, inputSeconds)} s will be
            converted.
          </p>
        )}
      </fieldset>

      <div className="flex flex-wrap items-start gap-2">
        <RunFooter
          label="Change voice"
          busy={busy}
          disabled={!card.available}
          validation={validation}
          error={error}
          queuedText={null}
          onRun={() => void go()}
          icon={<AudioWaveform className="h-4 w-4" />}
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
        <section className="space-y-3" data-testid="voice-changer-result">
          {result.video && (
            <video
              src={result.video.url}
              controls
              playsInline
              className="mx-auto max-h-[70vh] rounded-xl"
              data-testid="voice-changer-video"
            />
          )}
          <audio
            src={result.audio.url}
            controls
            className="h-9 w-full"
            data-testid="voice-changer-audio"
          />
        </section>
      )}
    </RunnerShell>
  );
}
