"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ImageIcon,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Square,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { useGenerationStore } from "@/store";
import { useBoardRunStore, useBoardStore } from "@/store/boardStore";
import { showToast } from "@/components/Toast";
import type { HubCard } from "@/lib/tools/hub";
import type { EditLoraListResponse } from "@/lib/tools/toolsPage";
import type { ToolImage, ToolVideo } from "@/lib/tools/runTool";
import {
  BOARD_CLIP,
  BOARD_LIMITS,
  BOARD_PROMPT,
  BOARD_PROMPT_FLUX3,
  boardId,
  boardTool,
  boardToolTitle,
  isPickStep,
  laneProgress,
  mediaAfter,
  nextTools,
  stepIssue,
  type Board,
  type BoardLane,
  type BoardStep,
  type BoardToolDef,
} from "@/lib/tools/board";
import {
  laneBlocker,
  runBoardLane,
  seedBoardClip,
  seedBoardSource,
  type BoardRunDeps,
} from "@/lib/tools/boardRunner";
import { RunnerHeader, RUN_BUTTON, errorMessage } from "./RunnerShell";
import { ToolImageInput } from "./ToolImageInput";
import { ToolVideoInput } from "./ToolVideoInput";
import {
  boardFromRecipe,
  reusableRecipeBoard,
  type LtxShotRecipe,
} from "@/lib/tools/ltxShots";
import { field } from "./ToolRunner";
import { useConfirm } from "@/components/ui/ConfirmDialog";

const SECONDARY =
  "flex h-9 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium text-light-primary shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)] transition-[background-color,transform] duration-150 hover:bg-light-input active:scale-[0.96] disabled:opacity-40 dark:text-dark-primary dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)] dark:hover:bg-dark-input";

const ICON_BUTTON =
  "flex h-7 w-7 items-center justify-center rounded-full text-light-500 transition-[background-color,color] duration-150 hover:bg-light-input hover:text-light-primary disabled:opacity-30 disabled:hover:bg-transparent dark:text-dark-400 dark:hover:bg-dark-input dark:hover:text-dark-primary";

interface ToolState {
  available: boolean;
  reason: string | null;
  nc: boolean;
}

/** Availability per board tool from the hub cards (prompt/source: always). */
function toolStates(cards: HubCard[]): Map<string, ToolState> {
  const out = new Map<string, ToolState>();
  for (const c of cards) {
    if (c.kind !== "action") continue;
    out.set(c.id, {
      available: c.available,
      reason: c.checking ? "Checking..." : c.unavailableReason,
      nc: c.nc,
    });
  }
  return out;
}

function MediaThumb({
  url,
  media,
  label,
}: {
  url?: string;
  media: "image" | "video" | null;
  label: string;
}) {
  if (url && media === "video")
    return (
      <video
        src={url}
        muted
        loop
        playsInline
        aria-label={label}
        className="h-full w-full object-cover"
      />
    );
  if (url)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={label} className="h-full w-full object-cover" />;
  const Icon = media === "video" ? Video : ImageIcon;
  return (
    <span
      aria-label={label}
      role="img"
      className="flex h-full w-full items-center justify-center text-light-400 dark:text-dark-300"
    >
      <Icon className="h-4 w-4" />
    </span>
  );
}

/** SVG connector between two cards; tinted by the upstream step's state. */
function Connector({
  state,
}: {
  state: "done" | "broken" | "running" | "idle";
}) {
  const tone =
    state === "done"
      ? "text-emerald-500"
      : state === "broken"
        ? "text-red-500"
        : state === "running"
          ? "text-splash"
          : "text-light-400 dark:text-dark-300";
  return (
    <svg
      aria-hidden
      width="40"
      height="24"
      viewBox="0 0 40 24"
      className={`mt-[54px] flex-shrink-0 ${tone}`}
    >
      <path
        d="M2 12 C 14 12, 22 12, 32 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={
          state === "broken" || state === "idle" ? "4 4" : undefined
        }
        className={state === "running" ? "animate-pulse" : undefined}
      />
      <path d="M30 7 L37 12 L30 17 Z" fill="currentColor" />
    </svg>
  );
}

/** Popover listing the tools that fit after a step. */
function ToolPicker({
  tools,
  states,
  onPick,
  onClose,
  title,
}: {
  tools: BoardToolDef[];
  states: Map<string, ToolState>;
  onPick: (id: string) => void;
  onClose: () => void;
  title: string;
}) {
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const shown = tools.filter((t) =>
    boardToolTitle(t.id).toLowerCase().includes(q.trim().toLowerCase()),
  );
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className="absolute left-0 top-full z-30 mt-2 w-64 rounded-xl bg-light-bg p-2 shadow-[0_8px_30px_rgba(0,0,0,0.18),0_0_0_1px_rgba(0,0,0,0.06)] dark:bg-dark-bg dark:shadow-[0_8px_30px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,255,255,0.08)]"
    >
      <input
        autoFocus
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Find a tool"
        aria-label="Find a tool"
        className={`${field} mb-1.5 h-8 py-1 text-xs`}
      />
      <ul className="max-h-72 space-y-0.5 overflow-y-auto" role="list">
        {shown.length === 0 && (
          <li className="px-2 py-3 text-center text-[11px] text-light-500 dark:text-dark-400">
            Nothing fits here.
          </li>
        )}
        {shown.map((t) => {
          const st = states.get(t.gate ?? t.id);
          const free = t.in === null && !t.gate;
          const ok = free || (st?.available ?? false);
          const reason = free ? null : (st?.reason ?? "Not installed");
          return (
            <li key={t.id}>
              <button
                type="button"
                disabled={!ok}
                title={ok ? undefined : (reason ?? undefined)}
                onClick={() => onPick(t.id)}
                data-testid={`board-pick-${t.id}`}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-light-primary hover:bg-light-input focus:bg-light-input focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 dark:text-dark-primary dark:hover:bg-dark-input dark:focus:bg-dark-input"
              >
                {t.out === "video" ? (
                  <Video className="h-3.5 w-3.5 flex-shrink-0 text-light-500 dark:text-dark-400" />
                ) : (
                  <ImageIcon className="h-3.5 w-3.5 flex-shrink-0 text-light-500 dark:text-dark-400" />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {boardToolTitle(t.id)}
                </span>
                {st?.nc && (
                  <span
                    className="rounded-full bg-amber-500/10 px-1.5 text-[9px] font-semibold text-amber-600 dark:text-amber-400"
                    title="Non-commercial model license"
                  >
                    NC
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AddStepButton({
  lane,
  after,
  states,
  disabled,
  onAdd,
  compact = false,
}: {
  lane: BoardLane;
  after: number;
  states: Map<string, ToolState>;
  disabled: boolean;
  onAdd: (tool: string, after: number) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const tools = nextTools(lane, after);
  const full = lane.steps.length >= BOARD_LIMITS.steps;
  const label =
    after < 0 ? "Add the first step" : `Add a step after step ${after + 1}`;
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  return (
    <div className="relative">
      <button
        ref={btn}
        type="button"
        disabled={disabled || full || tools.length === 0}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={full ? `Up to ${BOARD_LIMITS.steps} steps per lane` : label}
        onClick={() => setOpen((v) => !v)}
        className={
          compact
            ? ICON_BUTTON
            : "flex h-[132px] w-28 flex-shrink-0 flex-col items-center justify-center gap-1.5 rounded-2xl text-[11px] font-medium text-light-500 shadow-[inset_0_0_0_1.5px_rgba(0,0,0,0.1)] transition-[background-color,color] duration-150 [box-shadow:inset_0_0_0_1.5px_rgba(0,0,0,0.1)] hover:bg-light-input hover:text-splash disabled:opacity-40 dark:text-dark-400 dark:[box-shadow:inset_0_0_0_1.5px_rgba(255,255,255,0.12)] dark:hover:bg-dark-input"
        }
      >
        <Plus className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
        {!compact && (after < 0 ? "First step" : "Next step")}
      </button>
      {open && (
        <ToolPicker
          title={label}
          tools={tools}
          states={states}
          onClose={close}
          onPick={(id) => {
            setOpen(false);
            onAdd(id, after);
          }}
        />
      )}
    </div>
  );
}

function StatusChip({
  step,
  issue,
}: {
  step: BoardStep;
  issue: string | null;
}) {
  if (step.status === "running")
    return (
      <span className="flex items-center gap-1 text-[10px] font-medium text-splash">
        <Loader2 className="h-3 w-3 animate-spin" /> Running
      </span>
    );
  if (step.status === "done")
    return (
      <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
        <Check className="h-3 w-3" /> Done
      </span>
    );
  if (step.status === "error")
    return (
      <span className="flex items-center gap-1 text-[10px] font-medium text-red-500">
        <X className="h-3 w-3" /> Failed
      </span>
    );
  return (
    <span
      className={`text-[10px] font-medium ${issue ? "text-amber-600 dark:text-amber-400" : "text-light-500 dark:text-dark-400"}`}
    >
      {issue ? "Needs input" : "Ready"}
    </span>
  );
}

function StepCard({
  lane,
  index,
  busy,
  states,
  onText,
  onSource,
  onClip,
  onMove,
  onRemove,
  onReset,
  onAdd,
  registerRef,
  focusSibling,
}: {
  lane: BoardLane;
  index: number;
  busy: boolean;
  states: Map<string, ToolState>;
  onText: (stepId: string, text: string) => void;
  onSource: (stepId: string, image: ToolImage | null) => void;
  onClip: (stepId: string, video: ToolVideo | null) => void;
  onMove: (stepId: string, delta: -1 | 1) => void;
  onRemove: (stepId: string) => void;
  onReset: (stepId: string) => void;
  onAdd: (tool: string, after: number) => void;
  registerRef: (stepId: string, el: HTMLDivElement | null) => void;
  focusSibling: (index: number) => void;
}) {
  const step = lane.steps[index];
  const tool = boardTool(step.tool);
  const issue = stepIssue(lane, index);
  const inMedia = mediaAfter(lane, index - 1);
  const prev = index > 0 ? lane.steps[index - 1] : null;
  const title = boardToolTitle(step.tool);
  const st = states.get(tool?.gate ?? step.tool);
  const nc = st?.nc ?? false;
  // Hub availability (ComfyUI pack/model check); the run itself is the
  // final word, so this only warns.
  const missing =
    (tool?.in !== null || !!tool?.gate) && st && !st.available
      ? (st.reason ?? "Not installed")
      : null;
  const last = index === lane.steps.length - 1;

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || busy) return;
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      onMove(step.id, e.key === "ArrowLeft" ? -1 : 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      focusSibling(index + (e.key === "ArrowLeft" ? -1 : 1));
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onRemove(step.id);
      focusSibling(Math.max(0, index - 1));
    }
  };

  return (
    <div
      ref={(el) => registerRef(step.id, el)}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label={`Step ${index + 1}: ${title}, ${step.status === "idle" ? (issue ?? "ready") : step.status}`}
      aria-describedby={issue ? `${step.id}-issue` : undefined}
      data-testid={`board-step-${index}`}
      data-status={step.status}
      className={`w-60 flex-shrink-0 space-y-2 rounded-2xl bg-light-input/60 p-3 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)] focus:outline-none focus-visible:ring-2 focus-visible:ring-splash dark:bg-dark-input/60 dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] ${
        step.status === "running"
          ? "shadow-[inset_0_0_0_1.5px_rgb(var(--c-splash)/0.45)] dark:shadow-[inset_0_0_0_1.5px_rgb(var(--c-splash)/0.45)]"
          : ""
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-splash/10 px-1.5 text-[10px] font-semibold tabular-nums text-splash">
          {index + 1}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-light-primary dark:text-dark-primary">
          {title}
        </span>
        {nc && (
          <span
            className="rounded-full bg-amber-500/10 px-1.5 text-[9px] font-semibold text-amber-600 dark:text-amber-400"
            title="Non-commercial model license"
          >
            NC
          </span>
        )}
        <StatusChip step={step} issue={issue} />
      </div>

      <div className="flex items-center gap-1.5">
        {tool?.in !== null && (
          <>
            <span className="h-14 w-14 flex-shrink-0 overflow-hidden rounded-lg bg-light-bg shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)] dark:bg-dark-bg dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
              <MediaThumb
                url={prev?.status === "done" ? prev.outputUrl : undefined}
                media={inMedia ?? tool?.in ?? null}
                label={`Input of step ${index + 1}`}
              />
            </span>
            <ArrowRight
              aria-hidden
              className="h-3 w-3 flex-shrink-0 text-light-400 dark:text-dark-300"
            />
          </>
        )}
        <span className="h-14 w-14 flex-shrink-0 overflow-hidden rounded-lg bg-light-bg shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)] dark:bg-dark-bg dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
          <MediaThumb
            url={step.status === "done" ? step.outputUrl : undefined}
            media={tool?.out ?? null}
            label={`Output of step ${index + 1}`}
          />
        </span>
        {step.status === "done" && step.outputUrl && (
          <a
            href={step.outputUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-[10px] text-splash hover:underline"
          >
            Open
          </a>
        )}
      </div>

      {isPickStep(step.tool) ? (
        step.runId ? (
          <div className="flex items-center gap-2 text-[11px] text-light-500 dark:text-dark-400">
            <span className="min-w-0 flex-1 truncate">
              {step.label ??
                (step.tool === BOARD_CLIP ? "Picked clip" : "Picked image")}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                step.tool === BOARD_CLIP
                  ? onClip(step.id, null)
                  : onSource(step.id, null)
              }
              className="text-splash hover:underline disabled:opacity-40"
            >
              Change
            </button>
          </div>
        ) : step.tool === BOARD_CLIP ? (
          <ToolVideoInput
            label="Clip"
            note="Short clips work best: the LTX VFX steps use the first 4 to 5 s."
            value={null}
            onChange={(v) => onClip(step.id, v)}
          />
        ) : (
          <ToolImageInput
            label="Image"
            value={null}
            onChange={(img) => onSource(step.id, img)}
          />
        )
      ) : (
        tool?.textLabel && (
          <textarea
            aria-label={`Step ${index + 1} ${tool.textLabel.toLowerCase()}`}
            className={`${field} min-h-[52px] py-1.5 text-xs`}
            placeholder={
              step.tool === BOARD_PROMPT || step.tool === BOARD_PROMPT_FLUX3
                ? "a lighthouse on a cliff at dusk"
                : `${tool.textLabel}${tool.textRequired ? "" : " (optional)"}`
            }
            maxLength={BOARD_LIMITS.text}
            defaultValue={step.text}
            disabled={busy}
            onBlur={(e) => onText(step.id, e.target.value)}
          />
        )
      )}

      {issue && step.status !== "done" && (
        <p
          id={`${step.id}-issue`}
          className="text-[11px] text-amber-600 dark:text-amber-400"
        >
          {issue}
        </p>
      )}
      {missing && step.status !== "done" && (
        <p className="text-[11px] text-light-500 dark:text-dark-400">
          {missing}
        </p>
      )}
      {step.error && (
        <p role="alert" className="line-clamp-3 text-[11px] text-red-500">
          {step.error}
        </p>
      )}

      <div className="flex items-center gap-0.5 pt-0.5">
        <button
          type="button"
          aria-label={`Move step ${index + 1} left`}
          title="Move left (Alt+Left)"
          disabled={busy || index === 0}
          onClick={() => onMove(step.id, -1)}
          className={ICON_BUTTON}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={`Move step ${index + 1} right`}
          title="Move right (Alt+Right)"
          disabled={busy || last}
          onClick={() => onMove(step.id, 1)}
          className={ICON_BUTTON}
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        {!last && (
          <AddStepButton
            lane={lane}
            after={index}
            states={states}
            disabled={busy}
            onAdd={onAdd}
            compact
          />
        )}
        <span className="flex-1" />
        {(step.status === "done" || step.status === "error") &&
          !isPickStep(step.tool) && (
            <button
              type="button"
              aria-label={`Run step ${index + 1} again`}
              title="Run again from here"
              disabled={busy}
              onClick={() => onReset(step.id)}
              className={ICON_BUTTON}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
        <button
          type="button"
          aria-label={`Remove step ${index + 1}`}
          title="Remove (Delete)"
          disabled={busy}
          onClick={() => onRemove(step.id)}
          className={`${ICON_BUTTON} hover:text-red-500 dark:hover:text-red-400`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function LaneRow({
  board,
  lane,
  states,
  busy,
  running,
  onRun,
  onStop,
}: {
  board: Board;
  lane: BoardLane;
  states: Map<string, ToolState>;
  busy: boolean;
  running: boolean;
  onRun: () => void;
  onStop: () => void;
}) {
  const dispatch = useBoardStore((s) => s.dispatch);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const [seeding, setSeeding] = useState(false);
  const progress = laneProgress(lane);
  const blocker = laneBlocker(lane);
  const base = { boardId: board.id, laneId: lane.id };
  const [confirm, confirmDialog] = useConfirm();
  const focusStep = (stepId: string | undefined) => {
    if (!stepId) return;
    requestAnimationFrame(() => refs.current.get(stepId)?.focus());
  };

  const addStep = (tool: string, after: number) => {
    const stepId = boardId("step");
    dispatch({
      type: "addStep",
      ...base,
      stepId,
      tool,
      after,
      now: Date.now(),
    });
    focusStep(stepId);
  };
  const onSource = async (stepId: string, image: ToolImage | null) => {
    if (!image) {
      dispatch({
        type: "setSource",
        ...base,
        stepId,
        source: null,
        now: Date.now(),
      });
      return;
    }
    setSeeding(true);
    try {
      const source = await seedBoardSource(fetch, image);
      dispatch({ type: "setSource", ...base, stepId, source, now: Date.now() });
    } catch (e) {
      showToast(errorMessage(e), "error");
    } finally {
      setSeeding(false);
    }
  };
  const onClip = async (stepId: string, video: ToolVideo | null) => {
    if (!video) {
      dispatch({
        type: "setSource",
        ...base,
        stepId,
        source: null,
        now: Date.now(),
      });
      return;
    }
    setSeeding(true);
    try {
      const source = await seedBoardClip(fetch, video);
      dispatch({ type: "setSource", ...base, stepId, source, now: Date.now() });
    } catch (e) {
      showToast(errorMessage(e), "error");
    } finally {
      setSeeding(false);
    }
  };

  const connector = (i: number): "done" | "broken" | "running" | "idle" => {
    const next = lane.steps[i + 1];
    if (next && next.status !== "done" && stepIssue(lane, i + 1)) {
      const up = boardTool(lane.steps[i].tool)?.out;
      const want = boardTool(next.tool)?.in;
      if (want !== up) return "broken";
    }
    if (next?.status === "running") return "running";
    return lane.steps[i].status === "done" ? "done" : "idle";
  };

  return (
    <section
      aria-label={lane.title}
      className="space-y-3 rounded-3xl bg-light-input/25 p-3 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.05)] dark:bg-dark-input/25 dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)] sm:p-4"
      data-testid="board-lane"
    >
      {confirmDialog}
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Lane name"
          defaultValue={lane.title}
          key={lane.title}
          maxLength={BOARD_LIMITS.title}
          onBlur={(e) =>
            dispatch({
              type: "renameLane",
              ...base,
              title: e.target.value.trim() || lane.title,
              now: Date.now(),
            })
          }
          className="h-8 w-40 min-w-0 sm:w-56 rounded-lg bg-transparent px-2 text-sm font-semibold text-light-primary hover:bg-light-input focus:bg-light-input focus:outline-none focus:ring-2 focus:ring-splash dark:text-dark-primary dark:hover:bg-dark-input dark:focus:bg-dark-input"
        />
        <span className="text-[11px] tabular-nums text-light-500 dark:text-dark-400">
          {progress.done} of {progress.total} done
        </span>
        {seeding && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-light-500 dark:text-dark-400" />
        )}
        <span className="flex-1" />
        {running ? (
          <button type="button" onClick={onStop} className={SECONDARY}>
            <Square className="h-3 w-3" /> Stop after this step
          </button>
        ) : (
          <button
            type="button"
            onClick={onRun}
            disabled={busy || seeding || blocker !== null}
            title={blocker ?? "Run the pending steps in order"}
            className={SECONDARY}
            data-testid="board-run-lane"
          >
            <Play className="h-3 w-3" /> Run lane
          </button>
        )}
        <button
          type="button"
          aria-label={`Remove ${lane.title}`}
          disabled={busy}
          onClick={async () => {
            if (
              lane.steps.length === 0 ||
              (await confirm({
                title: `Remove ${lane.title}?`,
                message: "Its steps are removed too.",
                confirmLabel: "Remove",
                danger: true,
              }))
            )
              dispatch({ type: "removeLane", ...base, now: Date.now() });
          }}
          className={`${ICON_BUTTON} hover:text-red-500`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {blocker && lane.steps.length > 0 && !running && (
        <p className="-mt-1 px-2 text-[11px] text-light-500 dark:text-dark-400">
          {blocker}
        </p>
      )}
      <ol
        className="-mx-3 flex items-start overflow-x-auto px-3 pb-2 sm:-mx-4 sm:px-4"
        aria-label={`${lane.title} steps`}
      >
        {lane.steps.map((s, i) => (
          <li key={s.id} className="flex items-start">
            <StepCard
              lane={lane}
              index={i}
              busy={busy}
              states={states}
              registerRef={(id, el) => {
                if (el) refs.current.set(id, el);
                else refs.current.delete(id);
              }}
              focusSibling={(j) => focusStep(lane.steps[j]?.id)}
              onText={(stepId, text) =>
                dispatch({
                  type: "setStepText",
                  ...base,
                  stepId,
                  text,
                  now: Date.now(),
                })
              }
              onSource={(stepId, img) => void onSource(stepId, img)}
              onClip={(stepId, v) => void onClip(stepId, v)}
              onMove={(stepId, delta) => {
                dispatch({
                  type: "moveStep",
                  ...base,
                  stepId,
                  delta,
                  now: Date.now(),
                });
                focusStep(stepId);
              }}
              onRemove={(stepId) =>
                dispatch({
                  type: "removeStep",
                  ...base,
                  stepId,
                  now: Date.now(),
                })
              }
              onReset={(stepId) =>
                dispatch({
                  type: "resetFrom",
                  ...base,
                  stepId,
                  now: Date.now(),
                })
              }
              onAdd={addStep}
            />
            <Connector
              state={i < lane.steps.length - 1 ? connector(i) : "idle"}
            />
          </li>
        ))}
        <li className="flex-shrink-0">
          <AddStepButton
            lane={lane}
            after={lane.steps.length - 1}
            states={states}
            disabled={busy}
            onAdd={addStep}
          />
        </li>
      </ol>
    </section>
  );
}

/**
 * Tools > Board: lanes of chained tool steps. Each step runs one existing
 * tool on the previous step's output via the step runner; boards persist in
 * localStorage (useBoardStore).
 */
export function BoardRunner({
  card,
  hubCards,
  editLoras,
  onBack,
  recipe,
}: {
  card: HubCard;
  hubCards: HubCard[];
  editLoras: EditLoraListResponse | null;
  onBack: () => void;
  /** Opened from an LTX VFX shot card: open or make that recipe's board. */
  recipe?: LtxShotRecipe;
}) {
  const clientId = useGenerationStore((s) => s.clientId);
  const addRun = useGenerationStore((s) => s.addRun);
  const boards = useBoardStore((s) => s.boards);
  const activeId = useBoardStore((s) => s.activeId);
  const dispatch = useBoardStore((s) => s.dispatch);
  const states = useMemo(() => toolStates(hubCards), [hubCards]);
  const board = boards.find((b) => b.id === activeId) ?? null;
  const [confirm, confirmDialog] = useConfirm();
  // The live run sits in useBoardRunStore, not component state: leaving the
  // view mid-run keeps it going, and on return Stop is still reachable.
  const runBoardId = useBoardRunStore((s) => s.boardId);
  const runLaneId = useBoardRunStore((s) => s.laneId);
  const runningLane = runBoardId === board?.id ? runLaneId : null;
  const busy =
    runBoardId !== null ||
    boards.some((b) =>
      b.lanes.some((l) => l.steps.some((s) => s.status === "running")),
    );
  const stop = () => useBoardRunStore.getState().requestCancel();

  const createBoard = () =>
    dispatch({
      type: "createBoard",
      id: boardId("board"),
      laneId: boardId("lane"),
      now: Date.now(),
    });

  // A shot card reopens its untouched board, else makes a fresh one.
  const recipeOpened = useRef<string | null>(null);
  useEffect(() => {
    if (!recipe || recipeOpened.current === recipe.id) return;
    recipeOpened.current = recipe.id;
    const state = useBoardStore.getState();
    const reuse = reusableRecipeBoard(state, recipe.id);
    if (reuse) {
      state.dispatch({ type: "selectBoard", boardId: reuse });
      return;
    }
    if (state.boards.length >= BOARD_LIMITS.boards) {
      showToast(
        "Board limit reached: delete a board to add this shot.",
        "error",
      );
      return;
    }
    state.dispatch({
      type: "addBoard",
      board: boardFromRecipe(recipe, boardId, Date.now()),
    });
  }, [recipe]);

  const runLanes = async (laneIds: string[]) => {
    if (!board) return;
    const run = useBoardRunStore.getState();
    if (!run.begin(board.id)) return;
    const cancelled = () => useBoardRunStore.getState().cancelRequested;
    const deps: BoardRunDeps = {
      fetchImpl: fetch,
      clientId,
      onRun: addRun,
      editLoras,
      isCancelled: cancelled,
    };
    for (const laneId of laneIds) {
      if (cancelled()) break;
      const lane = useBoardStore
        .getState()
        .boards.find((b) => b.id === board.id)
        ?.lanes.find((l) => l.id === laneId);
      if (!lane || laneBlocker(lane)) continue;
      run.setLane(laneId);
      try {
        const end = await runBoardLane(lane, deps, (stepId, patch) =>
          dispatch({
            type: "patchStep",
            boardId: board.id,
            laneId,
            stepId,
            patch,
          }),
        );
        if (end.steps.some((s) => s.status === "error"))
          showToast(`${lane.title}: a step failed.`, "error");
      } catch (e) {
        showToast(errorMessage(e), "error");
      }
    }
    const stopped = cancelled();
    run.finish();
    if (stopped) showToast("Board stopped.", "info");
  };

  const runnableLanes =
    board?.lanes.filter((l) => laneBlocker(l) === null).map((l) => l.id) ?? [];

  return (
    <div className="flex-1 min-w-0 overflow-y-auto" data-testid="tool-board">
      {confirmDialog}
      <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 pb-28 pt-5 sm:px-6 sm:pb-10">
        <div className="max-w-3xl">
          <RunnerHeader
            title={card.title}
            subtitle={card.subtitle}
            model={card.model}
            onBack={onBack}
          />
        </div>

        <div
          className="flex flex-wrap items-center gap-2"
          role="toolbar"
          aria-label="Boards"
        >
          {boards.map((b) => (
            <button
              key={b.id}
              type="button"
              aria-pressed={b.id === activeId}
              disabled={busy}
              onClick={() => dispatch({ type: "selectBoard", boardId: b.id })}
              className={`flex h-8 max-w-[12rem] items-center rounded-full px-3 text-xs font-medium transition-[background-color,color] duration-150 disabled:opacity-50 ${
                b.id === activeId
                  ? "bg-light-primary text-light-bg dark:bg-dark-primary dark:text-dark-bg"
                  : "text-light-500 hover:bg-light-input hover:text-light-primary dark:text-dark-400 dark:hover:bg-dark-input dark:hover:text-dark-primary"
              }`}
            >
              <span className="truncate">{b.title}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={createBoard}
            disabled={busy || boards.length >= BOARD_LIMITS.boards}
            className={SECONDARY}
            data-testid="board-new"
          >
            <Plus className="h-3.5 w-3.5" /> New board
          </button>
        </div>

        {!board ? (
          <div className="flex flex-col items-center gap-3 rounded-3xl py-16 text-center shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
            <p className="max-w-sm text-sm text-pretty text-light-500 dark:text-dark-400">
              Chain tools into lanes: start from a prompt or one of your images,
              then add edits, upscales, motion and sound. Each step feeds the
              next.
            </p>
            <button type="button" onClick={createBoard} className={RUN_BUTTON}>
              <Plus className="h-4 w-4" /> New board
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label="Board name"
                key={`${board.id}:${board.title}`}
                defaultValue={board.title}
                maxLength={BOARD_LIMITS.title}
                onBlur={(e) =>
                  dispatch({
                    type: "renameBoard",
                    boardId: board.id,
                    title: e.target.value.trim() || board.title,
                    now: Date.now(),
                  })
                }
                className="h-9 min-w-0 max-w-xs flex-1 rounded-lg bg-transparent px-2 text-base font-semibold text-light-primary hover:bg-light-input focus:bg-light-input focus:outline-none focus:ring-2 focus:ring-splash dark:text-dark-primary dark:hover:bg-dark-input dark:focus:bg-dark-input"
              />
              <span className="flex-1" />
              {busy ? (
                <button
                  type="button"
                  onClick={stop}
                  className={SECONDARY}
                >
                  <Square className="h-3 w-3" /> Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void runLanes(runnableLanes)}
                  disabled={runnableLanes.length === 0}
                  className={RUN_BUTTON}
                  data-testid="board-run-all"
                >
                  <Play className="h-4 w-4" /> Run board
                </button>
              )}
              <button
                type="button"
                aria-label="Delete board"
                disabled={busy}
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Delete ${board.title}?`,
                      message: "Results already in your gallery stay there.",
                      confirmLabel: "Delete",
                      danger: true,
                    })
                  )
                    dispatch({ type: "deleteBoard", boardId: board.id });
                }}
                className={`${ICON_BUTTON} h-9 w-9 hover:text-red-500`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <p className="text-[11px] text-pretty text-light-500 dark:text-dark-400">
              Each step is an ordinary run and shows up in your gallery too.
              Editing or moving a step resets the steps after it. Keyboard: Tab
              to a card, Left/Right to move between cards, Alt+Left/Right to
              reorder, Delete to remove.
            </p>
            <div className="space-y-4">
              {board.lanes.map((lane) => (
                <LaneRow
                  key={lane.id}
                  board={board}
                  lane={lane}
                  states={states}
                  busy={busy}
                  running={runningLane === lane.id}
                  onRun={() => void runLanes([lane.id])}
                  onStop={stop}
                />
              ))}
            </div>
            <button
              type="button"
              disabled={busy || board.lanes.length >= BOARD_LIMITS.lanes}
              onClick={() =>
                dispatch({
                  type: "addLane",
                  boardId: board.id,
                  laneId: boardId("lane"),
                  now: Date.now(),
                })
              }
              className={SECONDARY}
              data-testid="board-add-lane"
            >
              <Plus className="h-3.5 w-3.5" /> Add lane
            </button>
          </>
        )}
      </div>
    </div>
  );
}
