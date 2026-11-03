/**
 * Board: a lightweight chaining canvas over the existing tools. A board holds
 * horizontal lanes; each lane is a chain of step cards where every step runs
 * one ordinary Adrift tool on the previous step's output (the same
 * /api/jobs/action route the lightbox and the Tools runners use).
 *
 * This file is the pure data model: the tool table, a reducer for every
 * board edit and the lane validation. boardRunner.ts executes lanes and
 * src/store/boardStore.ts persists the boards.
 */
import { getActionTool, type ActionToolId } from "./toolsPage";

export type BoardMedia = "image" | "video";

/** First-step tools (no input): a prompt, a picked image or a picked clip. */
export const BOARD_PROMPT = "prompt";
/** Text to image on FLUX.3 Klein, sized for an LTX-2.5 handoff (flux3Shots.ts). */
export const BOARD_PROMPT_FLUX3 = "prompt_flux3";
export const BOARD_SOURCE = "source";
export const BOARD_CLIP = "clip";

/** First steps the user fills by picking media (no job runs for them). */
export function isPickStep(tool: string): boolean {
  return tool === BOARD_SOURCE || tool === BOARD_CLIP;
}

export interface BoardToolDef {
  id: string;
  /** Input media; null = starts a lane. */
  in: BoardMedia | null;
  out: BoardMedia;
  /** Free-text field label (null = the tool takes no text). */
  textLabel: string | null;
  textRequired: boolean;
  /** Action tool whose hub availability gates this one (same pack). */
  gate?: ActionToolId;
}

/**
 * Action tools that take one image or one clip and nothing else (no second
 * reference, audio or smart-select clicks), so they can chain blindly.
 */
const CHAIN_TOOLS: { id: ActionToolId; in: BoardMedia; out: BoardMedia }[] = [
  { id: "edit_qwen21", in: "image", out: "image" },
  { id: "edit_flux3", in: "image", out: "image" },
  { id: "edit_fibo", in: "image", out: "image" },
  { id: "edit_photo", in: "image", out: "image" },
  { id: "restyle_locked", in: "image", out: "image" },
  { id: "remove_object", in: "image", out: "image" },
  { id: "relight", in: "image", out: "image" },
  { id: "bg_remove", in: "image", out: "image" },
  { id: "upscale", in: "image", out: "image" },
  { id: "upscale_seedvr2", in: "image", out: "image" },
  { id: "upscale_vosr2", in: "image", out: "image" },
  { id: "enhance_faces", in: "image", out: "image" },
  { id: "vectorize", in: "image", out: "image" },
  { id: "animate", in: "image", out: "video" },
  { id: "camera_move", in: "image", out: "video" },
  { id: "orbit_360", in: "image", out: "video" },
  { id: "wan_motion", in: "image", out: "video" },
  { id: "wan_camera", in: "image", out: "video" },
  { id: "interpolate", in: "video", out: "video" },
  { id: "upscale_video", in: "video", out: "video" },
  { id: "video_bg_remove", in: "video", out: "video" },
  { id: "video_edit", in: "video", out: "video" },
  { id: "vace_restyle", in: "video", out: "video" },
  { id: "video_remove_text", in: "video", out: "video" },
  { id: "add_sound", in: "video", out: "video" },
  // LTX-2.5 core (src/lib/oj/ltxVfx.ts): one photo or one clip in.
  { id: "ltx25_animate", in: "image", out: "video" },
  { id: "ltx_cinemagraph", in: "image", out: "video" },
  { id: "ltx_slow_motion", in: "image", out: "video" },
  { id: "ltx_exploded_view", in: "image", out: "video" },
  { id: "ltx_ingredients", in: "image", out: "video" },
  { id: "ltx_edge_control", in: "video", out: "video" },
  { id: "ltx_blockout_render", in: "video", out: "video" },
  { id: "ltx_layout_render", in: "video", out: "video" },
  { id: "ltx_reshoot", in: "video", out: "video" },
  { id: "ltx_restore", in: "video", out: "video" },
  { id: "ltx_day_to_night", in: "video", out: "video" },
  { id: "ltx_add_water", in: "video", out: "video" },
  { id: "ltx_clean_plate", in: "video", out: "video" },
  { id: "ltx_alpha_matte", in: "video", out: "video" },
];

export const BOARD_TOOLS: BoardToolDef[] = [
  {
    id: BOARD_PROMPT,
    in: null,
    out: "image",
    textLabel: "Prompt",
    textRequired: true,
  },
  {
    id: BOARD_PROMPT_FLUX3,
    in: null,
    out: "image",
    textLabel: "Prompt",
    textRequired: true,
    gate: "edit_flux3",
  },
  {
    id: BOARD_SOURCE,
    in: null,
    out: "image",
    textLabel: null,
    textRequired: false,
  },
  {
    id: BOARD_CLIP,
    in: null,
    out: "video",
    textLabel: null,
    textRequired: false,
  },
  ...CHAIN_TOOLS.flatMap((t) => {
    const spec = getActionTool(t.id);
    if (!spec) return [];
    return [
      {
        ...t,
        textLabel: spec.text?.label ?? null,
        textRequired: !!spec.text?.required,
      },
    ];
  }),
];

export function boardTool(id: string): BoardToolDef | undefined {
  return BOARD_TOOLS.find((t) => t.id === id);
}

export function boardToolTitle(id: string): string {
  if (id === BOARD_PROMPT) return "Text to image";
  if (id === BOARD_PROMPT_FLUX3) return "Key art (FLUX.3)";
  if (id === BOARD_SOURCE) return "Your image";
  if (id === BOARD_CLIP) return "Your clip";
  return getActionTool(id)?.title ?? id;
}

export type BoardStepStatus = "idle" | "running" | "done" | "error";

export interface BoardStep {
  id: string;
  tool: string;
  text: string;
  status: BoardStepStatus;
  error?: string;
  /** The step's own run (the next step's source). */
  runId?: string;
  jobIndex?: number;
  outputUrl?: string;
  /** Source step: label of the picked image or clip. */
  label?: string;
}

export interface BoardLane {
  id: string;
  title: string;
  steps: BoardStep[];
}

export interface Board {
  id: string;
  title: string;
  lanes: BoardLane[];
  updatedAt: number;
  /** Recipe the board was made from (ltxShots.ts), if any. */
  recipe?: string;
  /**
   * Picking the first step's image/clip in one lane fills every lane that
   * starts with the same pick step (a recipe's matched outputs).
   */
  linkedSource?: boolean;
}

export interface BoardsState {
  boards: Board[];
  activeId: string | null;
}

export const BOARD_LIMITS = {
  boards: 24,
  lanes: 8,
  steps: 12,
  title: 60,
  text: 600,
} as const;

export const EMPTY_BOARDS: BoardsState = { boards: [], activeId: null };

export type BoardAction =
  | {
      type: "createBoard";
      id: string;
      laneId: string;
      title?: string;
      now: number;
    }
  /** Add a ready-made board (a recipe); ignored at the board limit. */
  | { type: "addBoard"; board: Board }
  | { type: "renameBoard"; boardId: string; title: string; now: number }
  | { type: "deleteBoard"; boardId: string }
  | { type: "selectBoard"; boardId: string | null }
  | { type: "addLane"; boardId: string; laneId: string; now: number }
  | { type: "removeLane"; boardId: string; laneId: string; now: number }
  | {
      type: "renameLane";
      boardId: string;
      laneId: string;
      title: string;
      now: number;
    }
  | {
      type: "addStep";
      boardId: string;
      laneId: string;
      stepId: string;
      tool: string;
      /** Insert after this index; omitted = append. */
      after?: number;
      now: number;
    }
  | {
      type: "removeStep";
      boardId: string;
      laneId: string;
      stepId: string;
      now: number;
    }
  | {
      type: "moveStep";
      boardId: string;
      laneId: string;
      stepId: string;
      delta: -1 | 1;
      now: number;
    }
  | {
      type: "setStepText";
      boardId: string;
      laneId: string;
      stepId: string;
      text: string;
      now: number;
    }
  | {
      type: "setSource";
      boardId: string;
      laneId: string;
      stepId: string;
      source: {
        runId: string;
        jobIndex: number;
        url: string;
        label: string;
      } | null;
      now: number;
    }
  | {
      type: "patchStep";
      boardId: string;
      laneId: string;
      stepId: string;
      patch: Partial<Omit<BoardStep, "id" | "tool">>;
    }
  | {
      type: "resetFrom";
      boardId: string;
      laneId: string;
      stepId: string;
      now: number;
    }
  | { type: "settle" };

function clip(s: string, max: number): string {
  return s.slice(0, max);
}

function freshStep(id: string, tool: string): BoardStep {
  return { id, tool, text: "", status: "idle" };
}

/** Drop the run/output of a step (it has to run again). */
function cleared(step: BoardStep): BoardStep {
  if (isPickStep(step.tool))
    return { ...step, status: step.runId ? "done" : "idle", error: undefined };
  const { id, tool, text, label } = step;
  return { id, tool, text, status: "idle", ...(label ? { label } : {}) };
}

/** Clear every step from index `from` on (its inputs changed). */
export function invalidateFrom(lane: BoardLane, from: number): BoardLane {
  if (from >= lane.steps.length) return lane;
  return {
    ...lane,
    steps: lane.steps.map((s, i) => (i >= Math.max(0, from) ? cleared(s) : s)),
  };
}

function mapBoard(
  state: BoardsState,
  boardId: string,
  fn: (b: Board) => Board,
): BoardsState {
  let hit = false;
  const boards = state.boards.map((b) => {
    if (b.id !== boardId) return b;
    hit = true;
    return fn(b);
  });
  return hit ? { ...state, boards } : state;
}

function mapLane(
  state: BoardsState,
  boardId: string,
  laneId: string,
  now: number | null,
  fn: (l: BoardLane) => BoardLane,
): BoardsState {
  return mapBoard(state, boardId, (b) => {
    if (!b.lanes.some((l) => l.id === laneId)) return b;
    return {
      ...b,
      lanes: b.lanes.map((l) => (l.id === laneId ? fn(l) : l)),
      updatedAt: now ?? b.updatedAt,
    };
  });
}

export function newLane(id: string, index: number): BoardLane {
  return { id, title: `Lane ${index + 1}`, steps: [] };
}

export function boardReducer(
  state: BoardsState,
  action: BoardAction,
): BoardsState {
  switch (action.type) {
    case "createBoard": {
      if (state.boards.length >= BOARD_LIMITS.boards) return state;
      const board: Board = {
        id: action.id,
        title: clip(
          action.title?.trim() || `Board ${state.boards.length + 1}`,
          BOARD_LIMITS.title,
        ),
        lanes: [newLane(action.laneId, 0)],
        updatedAt: action.now,
      };
      return { boards: [board, ...state.boards], activeId: board.id };
    }
    case "addBoard": {
      if (state.boards.length >= BOARD_LIMITS.boards) return state;
      if (state.boards.some((b) => b.id === action.board.id)) return state;
      return {
        boards: [action.board, ...state.boards],
        activeId: action.board.id,
      };
    }
    case "renameBoard":
      return mapBoard(state, action.boardId, (b) => ({
        ...b,
        title: clip(action.title, BOARD_LIMITS.title),
        updatedAt: action.now,
      }));
    case "deleteBoard": {
      const boards = state.boards.filter((b) => b.id !== action.boardId);
      if (boards.length === state.boards.length) return state;
      return {
        boards,
        activeId:
          state.activeId === action.boardId
            ? (boards[0]?.id ?? null)
            : state.activeId,
      };
    }
    case "selectBoard":
      if (
        action.boardId !== null &&
        !state.boards.some((b) => b.id === action.boardId)
      )
        return state;
      return { ...state, activeId: action.boardId };
    case "addLane":
      return mapBoard(state, action.boardId, (b) =>
        b.lanes.length >= BOARD_LIMITS.lanes
          ? b
          : {
              ...b,
              lanes: [...b.lanes, newLane(action.laneId, b.lanes.length)],
              updatedAt: action.now,
            },
      );
    case "removeLane":
      return mapBoard(state, action.boardId, (b) => {
        const lanes = b.lanes.filter((l) => l.id !== action.laneId);
        return lanes.length === b.lanes.length
          ? b
          : { ...b, lanes, updatedAt: action.now };
      });
    case "renameLane":
      return mapLane(state, action.boardId, action.laneId, action.now, (l) => ({
        ...l,
        title: clip(action.title, BOARD_LIMITS.title),
      }));
    case "addStep": {
      if (!boardTool(action.tool)) return state;
      return mapLane(state, action.boardId, action.laneId, action.now, (l) => {
        if (l.steps.length >= BOARD_LIMITS.steps) return l;
        const at =
          action.after === undefined
            ? l.steps.length
            : Math.min(l.steps.length, Math.max(0, action.after + 1));
        const steps = [...l.steps];
        steps.splice(at, 0, freshStep(action.stepId, action.tool));
        return invalidateFrom({ ...l, steps }, at + 1);
      });
    }
    case "removeStep":
      return mapLane(state, action.boardId, action.laneId, action.now, (l) => {
        const at = l.steps.findIndex((s) => s.id === action.stepId);
        if (at < 0) return l;
        return invalidateFrom(
          { ...l, steps: l.steps.filter((s) => s.id !== action.stepId) },
          at,
        );
      });
    case "moveStep":
      return mapLane(state, action.boardId, action.laneId, action.now, (l) => {
        const at = l.steps.findIndex((s) => s.id === action.stepId);
        const to = at + action.delta;
        if (at < 0 || to < 0 || to >= l.steps.length) return l;
        const steps = [...l.steps];
        [steps[at], steps[to]] = [steps[to], steps[at]];
        return invalidateFrom({ ...l, steps }, Math.min(at, to));
      });
    case "setStepText":
      return mapLane(state, action.boardId, action.laneId, action.now, (l) => {
        const at = l.steps.findIndex((s) => s.id === action.stepId);
        if (at < 0) return l;
        const text = clip(action.text, BOARD_LIMITS.text);
        if (l.steps[at].text === text) return l;
        const steps = l.steps.map((s, i) => (i === at ? { ...s, text } : s));
        return invalidateFrom({ ...l, steps }, at);
      });
    case "setSource":
      return mapBoard(state, action.boardId, (b) => {
        const own = b.lanes.find((l) => l.id === action.laneId);
        const at =
          own?.steps.findIndex(
            (s) => s.id === action.stepId && isPickStep(s.tool),
          ) ?? -1;
        if (!own || at < 0) return b;
        const tool = own.steps[at].tool;
        const src = action.source;
        const fill = (l: BoardLane, i: number): BoardLane => {
          const id = l.steps[i].id;
          const step: BoardStep = src
            ? {
                id,
                tool,
                text: "",
                status: "done",
                runId: src.runId,
                jobIndex: src.jobIndex,
                outputUrl: src.url,
                label: src.label,
              }
            : freshStep(id, tool);
          const steps = l.steps.map((s, j) => (j === i ? step : s));
          return invalidateFrom({ ...l, steps }, i + 1);
        };
        // Linked boards: the same pick fills every lane's first step.
        const linked = !!b.linkedSource && at === 0;
        return {
          ...b,
          lanes: b.lanes.map((l) => {
            if (l.id === action.laneId) return fill(l, at);
            if (linked && l.steps[0]?.tool === tool) return fill(l, 0);
            return l;
          }),
          updatedAt: action.now,
        };
      });
    case "patchStep":
      return mapLane(state, action.boardId, action.laneId, null, (l) => ({
        ...l,
        steps: l.steps.map((s) =>
          s.id === action.stepId ? { ...s, ...action.patch } : s,
        ),
      }));
    case "resetFrom":
      return mapLane(state, action.boardId, action.laneId, action.now, (l) => {
        const at = l.steps.findIndex((s) => s.id === action.stepId);
        return at < 0 ? l : invalidateFrom(l, at);
      });
    case "settle":
      return settleBoards(state);
  }
}

/** Steps left "running" by a closed tab go back to idle (re-runnable). */
export function settleBoards(state: BoardsState): BoardsState {
  let changed = false;
  const boards = state.boards.map((b) => ({
    ...b,
    lanes: b.lanes.map((l) => ({
      ...l,
      steps: l.steps.map((s) => {
        if (s.status !== "running") return s;
        changed = true;
        return { ...s, status: "idle" as const };
      }),
    })),
  }));
  return changed ? { ...state, boards } : state;
}

/** Media the step after index `i` receives (null before the first step). */
export function mediaAfter(lane: BoardLane, i: number): BoardMedia | null {
  if (i < 0) return null;
  return boardTool(lane.steps[i]?.tool ?? "")?.out ?? null;
}

/** Tools that can follow step `i` (i = -1: a lane's first step). */
export function nextTools(lane: BoardLane, i: number): BoardToolDef[] {
  const media = mediaAfter(lane, i);
  return BOARD_TOOLS.filter((t) => t.in === media);
}

/** Why step `i` can't run as placed, or null. */
export function stepIssue(lane: BoardLane, i: number): string | null {
  const step = lane.steps[i];
  const tool = step ? boardTool(step.tool) : undefined;
  if (!step || !tool) return "Unknown tool";
  const media = mediaAfter(lane, i - 1);
  if (tool.in === null && i > 0) return "Only the first step can start a lane";
  if (tool.in !== null && media === null)
    return `Needs ${tool.in === "video" ? "a clip" : "an image"} before it`;
  if (tool.in !== null && tool.in !== media)
    return `Needs ${tool.in === "video" ? "a clip" : "an image"}, gets ${
      media === "video" ? "a clip" : "an image"
    }`;
  if (tool.id === BOARD_SOURCE && !step.runId) return "Pick an image";
  if (tool.id === BOARD_CLIP && !step.runId) return "Pick a clip";
  if (tool.textRequired && !step.text.trim())
    return `Add ${(tool.textLabel ?? "text").toLowerCase()}`;
  return null;
}

export function laneIssues(lane: BoardLane): (string | null)[] {
  return lane.steps.map((_, i) => stepIssue(lane, i));
}

/**
 * Index of the next step to run, or -1 (all done / blocked by an issue / a
 * step already running, so its job is never submitted twice).
 */
export function nextStepIndex(lane: BoardLane): number {
  for (let i = 0; i < lane.steps.length; i++) {
    const s = lane.steps[i];
    if (s.status === "done") continue;
    if (s.status === "running") return -1;
    return stepIssue(lane, i) ? -1 : i;
  }
  return -1;
}

/** True when the lane has work left and nothing blocks the next step. */
export function laneRunnable(lane: BoardLane): boolean {
  return nextStepIndex(lane) >= 0;
}

export function laneProgress(lane: BoardLane): { done: number; total: number } {
  return {
    done: lane.steps.filter((s) => s.status === "done").length,
    total: lane.steps.length,
  };
}

/** Defensive parse of persisted state (unknown shapes are dropped). */
export function sanitizeBoards(raw: unknown): BoardsState {
  if (!raw || typeof raw !== "object") return EMPTY_BOARDS;
  const r = raw as { boards?: unknown; activeId?: unknown };
  const str = (v: unknown, max: number) =>
    typeof v === "string" ? v.slice(0, max) : "";
  const boards: Board[] = (Array.isArray(r.boards) ? r.boards : [])
    .slice(0, BOARD_LIMITS.boards)
    .flatMap((b): Board[] => {
      if (!b || typeof b !== "object" || typeof b.id !== "string") return [];
      const lanes = (Array.isArray(b.lanes) ? b.lanes : [])
        .slice(0, BOARD_LIMITS.lanes)
        .flatMap((l: unknown): BoardLane[] => {
          const lane = l as Partial<BoardLane> | null;
          if (!lane || typeof lane.id !== "string") return [];
          const steps = (Array.isArray(lane.steps) ? lane.steps : [])
            .slice(0, BOARD_LIMITS.steps)
            .flatMap((s: unknown): BoardStep[] => {
              const st = s as Partial<BoardStep> | null;
              if (!st || typeof st.id !== "string" || !boardTool(st.tool ?? ""))
                return [];
              const status: BoardStepStatus =
                st.status === "done" || st.status === "error"
                  ? st.status
                  : "idle";
              return [
                {
                  id: st.id,
                  tool: st.tool as string,
                  text: str(st.text, BOARD_LIMITS.text),
                  status,
                  ...(typeof st.error === "string" ? { error: st.error } : {}),
                  ...(typeof st.runId === "string" ? { runId: st.runId } : {}),
                  ...(typeof st.jobIndex === "number"
                    ? { jobIndex: st.jobIndex }
                    : {}),
                  ...(typeof st.outputUrl === "string"
                    ? { outputUrl: st.outputUrl }
                    : {}),
                  ...(typeof st.label === "string" ? { label: st.label } : {}),
                },
              ];
            });
          return [
            {
              id: lane.id,
              title: str(lane.title, BOARD_LIMITS.title) || "Lane",
              steps,
            },
          ];
        });
      return [
        {
          id: b.id,
          title: str(b.title, BOARD_LIMITS.title) || "Board",
          lanes,
          updatedAt: typeof b.updatedAt === "number" ? b.updatedAt : 0,
          ...(typeof b.recipe === "string" && b.recipe
            ? { recipe: str(b.recipe, 60) }
            : {}),
          ...(b.linkedSource === true ? { linkedSource: true } : {}),
        },
      ];
    });
  const activeId =
    typeof r.activeId === "string" && boards.some((b) => b.id === r.activeId)
      ? r.activeId
      : (boards[0]?.id ?? null);
  return { boards, activeId };
}

let idCounter = 0;
/** Short unique id for boards, lanes and steps. */
export function boardId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}
