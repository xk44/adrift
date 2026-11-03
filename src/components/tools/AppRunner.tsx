"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AudioLines, Film, Scissors } from "lucide-react";
import { useGenerationStore } from "@/store";
import { showToast } from "@/components/Toast";
import {
  appAutoAnimates,
  appEngines,
  appNeedsSecondImage,
  appVariantChoices,
  compileAppPrompt,
  APP_DEFAULT_VARIANT,
  appSoundParams,
  compileMotionPrompt,
  compileSoundPrompt,
  shouldAutoAnimate,
  shouldAutoSound,
  type AppTemplate,
} from "@/lib/tools/apps";
import {
  availableEngines,
  type EditEngineId,
  type EngineContext,
  preferredEngine,
} from "@/lib/tools/templates";
import {
  submitAddSound,
  submitAnimate,
  submitEngineEdit,
  type ToolImage,
} from "@/lib/tools/runTool";
import type { HubCard } from "@/lib/tools/hub";
import {
  MATCH_CUT_ENGINES,
  compileFollowUpPrompt,
  submitAppFollowUp,
} from "@/lib/tools/appFollowUp";
import { ToolImageInput } from "./ToolImageInput";
import { useToolHandoff } from "./useToolHandoff";
import { EditorReturnNote, useEditorOrigin } from "./EditorReturn";
import { CharacterProfilePicker } from "./CharacterProfilePicker";
import { pickProfileSlot } from "@/lib/tools/characterProfiles";
import { EnginePicker } from "./EnginePicker";
import { RunFooter, RunnerShell, errorMessage } from "./RunnerShell";
import { Segmented, field } from "./ToolRunner";
import { CinemaStudio } from "./CinemaStudio";
import {
  appendCinema,
  compileCinema,
  type CinemaSettings,
} from "@/lib/tools/cinema";

const MOTION_OPTIONS = [
  { id: "animate_low", label: "Gentle" },
  { id: "animate_high", label: "Lively" },
];

/**
 * Generic Apps runner: step 1 edits the photo with the app's templated
 * prompt; step 2 (optional) animates the finished image with LTXV i2v.
 */
export function AppRunner({
  app,
  card,
  ctx,
  onBack,
}: {
  app: AppTemplate;
  card: HubCard;
  ctx: EngineContext;
  onBack: () => void;
}) {
  const clientId = useGenerationStore((s) => s.clientId);
  const addRun = useGenerationStore((s) => s.addRun);

  const engines = useMemo(
    () => availableEngines(appEngines(app), ctx),
    [app, ctx],
  );
  const [engineId, setEngineId] = useState<EditEngineId | null>(null);
  const engine =
    engines.find((e) => e.id === engineId) ?? preferredEngine(engines);
  const needsSecond = appNeedsSecondImage(app);
  // A profile fills the second slot when that one is the person/reference.
  const profileToSecond =
    needsSecond &&
    pickProfileSlot(["Photo", app.inputs?.second?.label ?? "Reference"]) === 1;

  const [image, setImage] = useState<ToolImage | null>(null);
  const [second, setSecond] = useState<ToolImage | null>(null);
  const [text, setText] = useState("");
  const [variant, setVariant] = useState(APP_DEFAULT_VARIANT);
  const variantChoices = useMemo(() => appVariantChoices(app), [app]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Lightbox "Tools" panel: the open image arrives as the main input.
  const editorOrigin = useEditorOrigin(card.title);
  useToolHandoff(card.key, {
    onImage: setImage,
    onError: setError,
    onHandoff: editorOrigin.onHandoff,
  });
  const [step1RunId, setStep1RunId] = useState<string | null>(null);

  const [motion, setMotion] = useState(app.motion ?? "");
  const [motionKind, setMotionKind] = useState("animate_low");
  const [animBusy, setAnimBusy] = useState(false);
  const [animError, setAnimError] = useState<string | null>(null);
  const [animQueued, setAnimQueued] = useState(false);
  const [cinema, setCinema] = useState<CinemaSettings>({});
  // One-action chain (e.g. Sketch to Video): animate as soon as step 1 lands.
  const [autoChain, setAutoChain] = useState(() => appAutoAnimates(app));
  const [animatedRunId, setAnimatedRunId] = useState<string | null>(null);
  // Step 3 (apps with `sound`): MMAudio foley on the finished clip.
  const [clipRunId, setClipRunId] = useState<string | null>(null);
  const [sound, setSound] = useState(app.sound ?? "");
  const [soundBusy, setSoundBusy] = useState(false);
  const [soundError, setSoundError] = useState<string | null>(null);
  const [soundQueued, setSoundQueued] = useState(false);
  const [soundedRunId, setSoundedRunId] = useState<string | null>(null);
  const clip = useGenerationStore((s) =>
    clipRunId ? s.runs.find((r) => r.run_id === clipRunId) : undefined,
  );
  const clipJob = clip?.jobs?.[0];
  const clipDone =
    clipJob?.status === "done" && (clipJob.videos?.length ?? 0) > 0;
  // Follow-up chain (apps with `followUp`) replaces the Animate step.
  const followUp = app.followUp;
  const [followText, setFollowText] = useState(followUp?.prompt ?? "");
  const [followEngine, setFollowEngine] = useState(MATCH_CUT_ENGINES[0].id);
  const [autoFollow, setAutoFollow] = useState(true);
  const [followBusy, setFollowBusy] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);
  const [followQueued, setFollowQueued] = useState<string | null>(null);
  const [followedRunId, setFollowedRunId] = useState<string | null>(null);
  const motionPrompt = appendCinema(
    compileMotionPrompt(app, motion),
    compileCinema(cinema),
  );

  const step1 = useGenerationStore((s) =>
    step1RunId ? s.runs.find((r) => r.run_id === step1RunId) : undefined,
  );
  const step1Job = step1?.jobs?.[0];
  const step1Done = step1Job?.status === "done" && step1Job.images.length > 0;
  const step1Failed =
    step1Job?.status === "error" || step1Job?.status === "cancelled";

  const prompt = compileAppPrompt(app, text, variant);

  let validation: string | null = null;
  if (engine) {
    if (!image) validation = "Add a photo to start.";
    else if (needsSecond && !second)
      validation = `Add the ${app.inputs?.second?.label.toLowerCase() ?? "reference"} to start.`;
  }

  const run = async () => {
    if (!engine || !image) return;
    setBusy(true);
    setError(null);
    setAnimQueued(false);
    try {
      const r = await submitEngineEdit({
        fetchImpl: fetch,
        engine,
        prompt,
        image,
        secondImage: second,
        ctx,
        clientId,
        title: app.name,
        editMode: app.editMode,
        onWarnings: (w) => w.forEach((m) => showToast(m, "info", 8000)),
      });
      addRun(r);
      editorOrigin.track(r.run_id);
      setStep1RunId(r.run_id);
      showToast(`${app.name} queued. Progress shows in Create.`, "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const animate = async () => {
    if (!step1 || !step1Job) return;
    setAnimatedRunId(step1.run_id);
    setAnimBusy(true);
    setAnimError(null);
    try {
      const r = await submitAnimate({
        fetchImpl: fetch,
        runId: step1.run_id,
        jobIndex: step1Job.index ?? 0,
        motion: motionKind as "animate_low" | "animate_high",
        prompt: motionPrompt,
        clientId,
      });
      addRun(r);
      setClipRunId(r.run_id);
      setSoundQueued(false);
      setAnimQueued(true);
      showToast("Animation queued. Progress shows in Create.", "success");
    } catch (e) {
      setAnimError(errorMessage(e));
    } finally {
      setAnimBusy(false);
    }
  };

  const addSound = async () => {
    if (!clip || !clipJob) return;
    setSoundedRunId(clip.run_id);
    setSoundBusy(true);
    setSoundError(null);
    try {
      const r = await submitAddSound({
        fetchImpl: fetch,
        runId: clip.run_id,
        jobIndex: clipJob.index ?? 0,
        params: appSoundParams(app, sound),
        clientId,
      });
      addRun(r);
      setSoundQueued(true);
      showToast("Sound queued. Progress shows in Create.", "success");
    } catch (e) {
      setSoundError(errorMessage(e));
    } finally {
      setSoundBusy(false);
    }
  };

  const runFollowUp = async () => {
    if (!followUp || !step1 || !step1Job || !image) return;
    setFollowedRunId(step1.run_id);
    setFollowBusy(true);
    setFollowError(null);
    setFollowQueued(null);
    try {
      const labels: string[] = [];
      await submitAppFollowUp({
        fetchImpl: fetch,
        app,
        image,
        step1Url: step1Job.images[0],
        clientId,
        engine: followEngine,
        prompt: followText,
        onRun: (r, label) => {
          addRun(r);
          labels.push(label);
        },
      });
      setFollowQueued(`${labels.join(" + ")} queued.`);
      showToast(
        `${labels.join(" + ")} queued. Progress shows in Create.`,
        "success",
      );
    } catch (e) {
      setFollowError(errorMessage(e));
    } finally {
      setFollowBusy(false);
    }
  };

  const followRef = useRef(runFollowUp);
  followRef.current = runFollowUp;
  useEffect(() => {
    if (
      followUp &&
      shouldAutoAnimate({
        enabled: autoFollow,
        step1RunId,
        step1Done,
        animatedRunId: followedRunId,
      })
    )
      void followRef.current();
  }, [followUp, autoFollow, step1RunId, step1Done, followedRunId]);

  const soundRef = useRef(addSound);
  soundRef.current = addSound;
  useEffect(() => {
    if (
      app.sound &&
      shouldAutoSound({ enabled: autoChain, clipRunId, clipDone, soundedRunId })
    )
      void soundRef.current();
  }, [app.sound, autoChain, clipRunId, clipDone, soundedRunId]);

  const animateRef = useRef(animate);
  animateRef.current = animate;
  useEffect(() => {
    if (
      !followUp &&
      shouldAutoAnimate({
        enabled: autoChain,
        step1RunId,
        step1Done,
        animatedRunId,
      })
    )
      void animateRef.current();
  }, [followUp, autoChain, step1RunId, step1Done, animatedRunId]);

  return (
    <RunnerShell
      title={app.name}
      subtitle={app.description}
      blockedReason={
        engine
          ? null
          : (card.unavailableReason ??
            "No edit model is installed on this server.")
      }
      checking={!engine && card.checking}
      onBack={onBack}
      testId={`app-runner-${app.id}`}
      studio
    >
      <section className="space-y-4">
        <CharacterProfilePicker
          toolKey={card.key}
          disabled={busy}
          needsPixels={profileToSecond}
          onApply={(img, _next, prev) => {
            const cur = profileToSecond ? second : image;
            const put = profileToSecond ? setSecond : setImage;
            if (img) put(img);
            else if (prev?.refs.some((r) => r.id === cur?.id)) put(null);
          }}
        />
        <ToolImageInput label="Photo" value={image} onChange={setImage} />
        {needsSecond && (
          <ToolImageInput
            label={app.inputs?.second?.label ?? "Reference"}
            value={second}
            onChange={setSecond}
            needsPixels
          />
        )}
      </section>

      {app.inputs?.text && (
        <section className="space-y-1.5">
          <label
            htmlFor="app-text"
            className="text-xs font-medium text-light-primary dark:text-dark-primary"
          >
            {app.inputs.text.label}
          </label>
          <input
            id="app-text"
            className={field}
            maxLength={120}
            placeholder={app.inputs.text.placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </section>
      )}

      {variantChoices.length > 0 && (
        <Segmented
          label={app.variantLabel ?? "Variant"}
          value={variant}
          options={variantChoices}
          onChange={setVariant}
        />
      )}

      {engines.length > 0 && (
        <EnginePicker engines={engines} value={engine} onChange={setEngineId} />
      )}

      <details className="text-[11px] text-light-500 dark:text-dark-400">
        <summary className="cursor-pointer">Prompt sent</summary>
        <p className="mt-1 font-mono">{prompt}</p>
      </details>

      {editorOrigin.fromEditor && <EditorReturnNote />}
      {editorOrigin.fromVideoEditor && <EditorReturnNote video />}
      <RunFooter
        label={
          (followUp ? autoFollow : autoChain)
            ? "Generate video"
            : "Step 1: Generate"
        }
        busy={busy}
        disabled={!engine}
        validation={validation}
        error={error}
        queuedText={step1RunId ? "Queued." : null}
        onRun={run}
      />

      {followUp && (
        <section
          className="space-y-3 rounded-xl border border-light-100 dark:border-dark-750 p-4"
          aria-label={followUp.label}
          data-testid="app-follow-up"
        >
          <div>
            <h3 className="text-sm font-semibold text-light-primary dark:text-dark-primary">
              {followUp.label}
            </h3>
            <p className="mt-0.5 text-[11px] text-light-500 dark:text-dark-400">
              {followUp.kind === "match_cut"
                ? `${followUp.cutout ? "Transparent sticker (Qwen-Image 2.1 alpha) + " : ""}a transition clip from your photo to the sticker`
                : "Step 1 is the clean plate; the bullet-time sweep runs on your photo · Wan 2.2"}
            </p>
          </div>
          <textarea
            rows={2}
            maxLength={500}
            className={`${field} resize-y`}
            placeholder={
              followUp.kind === "match_cut" ? "how it moves" : "the subject"
            }
            value={followText}
            onChange={(e) => setFollowText(e.target.value)}
            aria-label={
              followUp.kind === "match_cut" ? "How it moves" : "Subject"
            }
          />
          {followUp.kind === "match_cut" && (
            <Segmented
              label="Video model"
              value={followEngine}
              options={MATCH_CUT_ENGINES.map((e) => ({
                id: e.id,
                label: e.label,
              }))}
              onChange={setFollowEngine}
            />
          )}
          <label className="flex items-center gap-2 text-[11px] text-light-500 dark:text-dark-400">
            <input
              type="checkbox"
              checked={autoFollow}
              onChange={(e) => setAutoFollow(e.target.checked)}
              data-testid="app-auto-follow-up"
            />
            Run automatically when step 1 finishes
          </label>
          <p className="text-[11px] text-light-500 dark:text-dark-400">
            Sends:{" "}
            <span className="font-mono">
              {compileFollowUpPrompt(app, followText)}
            </span>
          </p>
          <RunFooter
            label="Run step 2"
            icon={<Scissors className="w-4 h-4" />}
            busy={followBusy}
            disabled={!step1Done}
            validation={
              !step1RunId
                ? "Run step 1 first."
                : step1Failed
                  ? "Step 1 failed; run it again."
                  : !step1Done
                    ? "Waiting for step 1 to finish..."
                    : null
            }
            error={followError}
            queuedText={followQueued}
            onRun={runFollowUp}
          />
        </section>
      )}

      {!followUp && (
        <section
          className="space-y-3 rounded-xl border border-light-100 dark:border-dark-750 p-4"
          aria-label="Animate"
        >
          <div>
            <h3 className="text-sm font-semibold text-light-primary dark:text-dark-primary">
              Step 2: Animate (optional)
            </h3>
            <p className="mt-0.5 text-[11px] text-light-500 dark:text-dark-400">
              Turns the step-1 result into a short clip · LTX-Video · open weights
            </p>
          </div>
          <textarea
            rows={2}
            maxLength={500}
            className={`${field} resize-y`}
            placeholder="describe the motion"
            value={motion}
            onChange={(e) => setMotion(e.target.value)}
            aria-label="Motion"
          />
          <Segmented
            label="Motion"
            value={motionKind}
            options={MOTION_OPTIONS}
            onChange={setMotionKind}
          />
          <CinemaStudio toolId="animate" value={cinema} onChange={setCinema} />
          <label className="flex items-center gap-2 text-[11px] text-light-500 dark:text-dark-400">
            <input
              type="checkbox"
              checked={autoChain}
              onChange={(e) => setAutoChain(e.target.checked)}
              data-testid="app-auto-animate"
            />
            {app.sound
              ? "Animate and add sound automatically when step 1 finishes"
              : "Animate automatically when step 1 finishes"}
          </label>
          {motionPrompt && (
            <p className="text-[11px] text-light-500 dark:text-dark-400">
              Sends: <span className="font-mono">{motionPrompt}</span>
            </p>
          )}
          <RunFooter
            label="Animate"
            icon={<Film className="w-4 h-4" />}
            busy={animBusy}
            disabled={!step1Done}
            validation={
              !step1RunId
                ? "Run step 1 first."
                : step1Failed
                  ? "Step 1 failed; run it again."
                  : !step1Done
                    ? "Waiting for step 1 to finish..."
                    : null
            }
            error={animError}
            queuedText={animQueued ? "Animation queued." : null}
            onRun={animate}
          />
        </section>
      )}

      {app.sound && (
        <section
          className="space-y-3 rounded-xl border border-light-100 dark:border-dark-750 p-4"
          aria-label="Add sound"
          data-testid="app-sound-step"
        >
          <div>
            <h3 className="text-sm font-semibold text-light-primary dark:text-dark-primary">
              Step 3: Add sound
            </h3>
            <p className="mt-0.5 text-[11px] text-light-500 dark:text-dark-400">
              Foley matched to the clip · MMAudio · non-commercial (CC BY-NC 4.0)
            </p>
          </div>
          <textarea
            rows={2}
            maxLength={500}
            className={`${field} resize-y`}
            placeholder="describe the sound"
            value={sound}
            onChange={(e) => setSound(e.target.value)}
            aria-label="Sound"
          />
          <p className="text-[11px] text-light-500 dark:text-dark-400">
            Sends: <span className="font-mono">{compileSoundPrompt(app, sound)}</span>
          </p>
          <RunFooter
            label="Add sound"
            icon={<AudioLines className="w-4 h-4" />}
            busy={soundBusy}
            disabled={!clipDone}
            validation={
              !clipRunId
                ? "Animate first."
                : clipJob?.status === "error" || clipJob?.status === "cancelled"
                  ? "The animation failed; run it again."
                  : !clipDone
                    ? "Waiting for the clip to finish..."
                    : null
            }
            error={soundError}
            queuedText={soundQueued ? "Sound queued." : null}
            onRun={addSound}
          />
        </section>
      )}
    </RunnerShell>
  );
}
