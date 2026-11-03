import { describe, expect, it, vi } from "vitest";
import {
  BOARD_CLIP,
  BOARD_LIMITS,
  BOARD_PROMPT,
  BOARD_PROMPT_FLUX3,
  BOARD_SOURCE,
  BOARD_TOOLS,
  EMPTY_BOARDS,
  boardReducer,
  nextStepIndex,
  nextTools,
  sanitizeBoards,
  settleBoards,
  stepIssue,
  type BoardAction,
  type BoardLane,
  type BoardsState,
} from "@/lib/tools/board";
import { laneBlocker, runBoardLane } from "@/lib/tools/boardRunner";
import { useBoardRunStore } from "@/store/boardStore";
import {
  audioActive,
  buildActionRequest,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";
import { buildHubCards } from "@/lib/tools/hub";
import { BOARD_KEY } from "@/lib/tools/pipelineCards";

const B = "b1";
const L = "l1";

function reduce(actions: BoardAction[], start: BoardsState = EMPTY_BOARDS) {
  return actions.reduce(boardReducer, start);
}

function lane(s: BoardsState, laneId = L): BoardLane {
  const l = s.boards
    .find((b) => b.id === B)
    ?.lanes.find((x) => x.id === laneId);
  if (!l) throw new Error("lane missing");
  return l;
}

const base = { boardId: B, laneId: L, now: 2 };
const created: BoardAction = { type: "createBoard", id: B, laneId: L, now: 1 };

/** prompt -> upscale -> animate -> interpolate, all done. */
function doneChain(): BoardsState {
  let s = reduce([
    created,
    { type: "addStep", ...base, stepId: "s1", tool: BOARD_PROMPT },
    { type: "addStep", ...base, stepId: "s2", tool: "upscale" },
    { type: "addStep", ...base, stepId: "s3", tool: "animate" },
    { type: "addStep", ...base, stepId: "s4", tool: "interpolate" },
    { type: "setStepText", ...base, stepId: "s1", text: "a red fox" },
  ]);
  for (const id of ["s1", "s2", "s3", "s4"])
    s = boardReducer(s, {
      type: "patchStep",
      boardId: B,
      laneId: L,
      stepId: id,
      patch: { status: "done", runId: `r-${id}`, outputUrl: `/o/${id}` },
    });
  return s;
}

describe("boardReducer", () => {
  it("creates, selects, renames and deletes boards", () => {
    let s = reduce([created]);
    expect(s.activeId).toBe(B);
    expect(s.boards[0].title).toBe("Board 1");
    expect(s.boards[0].lanes).toEqual([{ id: L, title: "Lane 1", steps: [] }]);
    s = reduce(
      [
        { type: "createBoard", id: "b2", laneId: "l2", title: "Ads", now: 3 },
        { type: "renameBoard", boardId: B, title: "x".repeat(99), now: 4 },
      ],
      s,
    );
    expect(s.activeId).toBe("b2");
    expect(s.boards.map((b) => b.id)).toEqual(["b2", B]);
    expect(s.boards[1].title).toHaveLength(BOARD_LIMITS.title);
    expect(reduce([{ type: "selectBoard", boardId: "nope" }], s)).toBe(s);
    s = reduce([{ type: "deleteBoard", boardId: "b2" }], s);
    expect(s.activeId).toBe(B);
    s = reduce([{ type: "deleteBoard", boardId: B }], s);
    expect(s).toEqual(EMPTY_BOARDS);
  });

  it("caps boards, lanes and steps", () => {
    let s = EMPTY_BOARDS;
    for (let i = 0; i < BOARD_LIMITS.boards + 3; i++)
      s = boardReducer(s, {
        type: "createBoard",
        id: `b${i}`,
        laneId: `l${i}`,
        now: i,
      });
    expect(s.boards).toHaveLength(BOARD_LIMITS.boards);

    s = reduce([created]);
    for (let i = 0; i < BOARD_LIMITS.lanes + 2; i++)
      s = boardReducer(s, {
        type: "addLane",
        boardId: B,
        laneId: `x${i}`,
        now: 1,
      });
    expect(s.boards[0].lanes).toHaveLength(BOARD_LIMITS.lanes);
    expect(s.boards[0].lanes[1].title).toBe("Lane 2");

    s = reduce([
      created,
      { type: "addStep", ...base, stepId: "p", tool: BOARD_PROMPT },
    ]);
    for (let i = 0; i < BOARD_LIMITS.steps + 2; i++)
      s = boardReducer(s, {
        type: "addStep",
        ...base,
        stepId: `u${i}`,
        tool: "upscale",
      });
    expect(lane(s).steps).toHaveLength(BOARD_LIMITS.steps);
  });

  it("ignores unknown tools and unknown ids", () => {
    const s = reduce([created]);
    expect(
      boardReducer(s, { type: "addStep", ...base, stepId: "z", tool: "rm_rf" }),
    ).toBe(s);
    expect(
      boardReducer(s, {
        type: "removeLane",
        boardId: B,
        laneId: "nope",
        now: 9,
      }),
    ).toEqual(s);
    expect(
      boardReducer(s, {
        type: "addLane",
        boardId: "nope",
        laneId: "q",
        now: 9,
      }),
    ).toBe(s);
  });

  it("inserts after an index and resets the steps downstream", () => {
    let s = doneChain();
    s = boardReducer(s, {
      type: "addStep",
      ...base,
      stepId: "s1b",
      tool: "relight",
      after: 0,
    });
    const steps = lane(s).steps;
    expect(steps.map((x) => x.id)).toEqual(["s1", "s1b", "s2", "s3", "s4"]);
    expect(steps.map((x) => x.status)).toEqual([
      "done",
      "idle",
      "idle",
      "idle",
      "idle",
    ]);
    // Cleared steps lose their run and output but keep their text.
    expect(steps[2]).toEqual({
      id: "s2",
      tool: "upscale",
      text: "",
      status: "idle",
    });
    expect(steps[0].runId).toBe("r-s1");
  });

  it("remove resets from the gap, move from the earlier slot", () => {
    let s = boardReducer(doneChain(), {
      type: "removeStep",
      ...base,
      stepId: "s2",
    });
    expect(lane(s).steps.map((x) => [x.id, x.status])).toEqual([
      ["s1", "done"],
      ["s3", "idle"],
      ["s4", "idle"],
    ]);
    s = boardReducer(doneChain(), {
      type: "moveStep",
      ...base,
      stepId: "s4",
      delta: -1,
    });
    expect(lane(s).steps.map((x) => [x.id, x.status])).toEqual([
      ["s1", "done"],
      ["s2", "done"],
      ["s4", "idle"],
      ["s3", "idle"],
    ]);
    // Out-of-range moves are no-ops.
    const d = doneChain();
    expect(
      lane(
        boardReducer(d, { type: "moveStep", ...base, stepId: "s1", delta: -1 }),
      ),
    ).toEqual(lane(d));
  });

  it("text edits reset that step on; same text is a no-op", () => {
    const d = doneChain();
    expect(
      lane(
        boardReducer(d, {
          type: "setStepText",
          ...base,
          stepId: "s1",
          text: "a red fox",
        }),
      ),
    ).toBe(lane(d));
    const s = boardReducer(d, {
      type: "setStepText",
      ...base,
      stepId: "s1",
      text: "a blue fox",
    });
    expect(lane(s).steps.every((x) => x.status === "idle")).toBe(true);
    expect(lane(s).steps[0].text).toBe("a blue fox");
  });

  it("source picks mark the step done and keep it through resets", () => {
    let s = reduce([
      created,
      { type: "addStep", ...base, stepId: "src", tool: BOARD_SOURCE },
      { type: "addStep", ...base, stepId: "up", tool: "upscale" },
    ]);
    expect(stepIssue(lane(s), 0)).toBe("Pick an image");
    s = boardReducer(s, {
      type: "setSource",
      ...base,
      stepId: "src",
      source: { runId: "seed1", jobIndex: 0, url: "/v/a.png", label: "a.png" },
    });
    expect(lane(s).steps[0]).toMatchObject({
      status: "done",
      runId: "seed1",
      outputUrl: "/v/a.png",
      label: "a.png",
    });
    s = boardReducer(s, { type: "resetFrom", ...base, stepId: "src" });
    expect(lane(s).steps[0].status).toBe("done");
    expect(nextStepIndex(lane(s))).toBe(1);
    // setSource only targets source steps.
    expect(
      boardReducer(s, {
        type: "setSource",
        ...base,
        stepId: "up",
        source: null,
      }),
    ).toEqual(s);
    s = boardReducer(s, {
      type: "setSource",
      ...base,
      stepId: "src",
      source: null,
    });
    expect(lane(s).steps[0]).toEqual({
      id: "src",
      tool: BOARD_SOURCE,
      text: "",
      status: "idle",
    });
  });

  it("settle turns running steps idle", () => {
    const s = boardReducer(doneChain(), {
      type: "patchStep",
      boardId: B,
      laneId: L,
      stepId: "s3",
      patch: { status: "running" },
    });
    const settled = boardReducer(s, { type: "settle" });
    expect(lane(settled).steps[2].status).toBe("idle");
    expect(settleBoards(settled)).toBe(settled);
  });
});

describe("lane validation", () => {
  it("offers starters first, then tools matching the media", () => {
    let s = reduce([created]);
    expect(nextTools(lane(s), -1).map((t) => t.id)).toEqual([
      BOARD_PROMPT,
      BOARD_PROMPT_FLUX3,
      BOARD_SOURCE,
      BOARD_CLIP,
    ]);
    s = doneChain();
    const afterImage = nextTools(lane(s), 1).map((t) => t.id);
    expect(afterImage).toContain("animate");
    expect(afterImage).not.toContain("interpolate");
    const afterVideo = nextTools(lane(s), 2).map((t) => t.id);
    expect(afterVideo).toContain("interpolate");
    expect(afterVideo).not.toContain("upscale");
  });

  it("flags misplaced steps and missing text", () => {
    const s = reduce([
      created,
      { type: "addStep", ...base, stepId: "a", tool: "animate" },
      { type: "addStep", ...base, stepId: "p", tool: BOARD_PROMPT },
      { type: "addStep", ...base, stepId: "u", tool: "upscale" },
    ]);
    const l = lane(s);
    expect(stepIssue(l, 0)).toBe("Needs an image before it");
    expect(stepIssue(l, 1)).toBe("Only the first step can start a lane");
    expect(stepIssue(l, 2)).toBeNull();
    expect(nextStepIndex(l)).toBe(-1);
    expect(laneBlocker(l)).toBe("Step 1: Needs an image before it.");

    const moved = boardReducer(s, {
      type: "moveStep",
      ...base,
      stepId: "p",
      delta: -1,
    });
    expect(stepIssue(lane(moved), 0)).toBe("Add prompt");
    expect(stepIssue(lane(moved), 2)).toBe("Needs an image, gets a clip");
    expect(laneBlocker(reduce([created]).boards[0].lanes[0])).toBe(
      "Add a first step.",
    );
    expect(laneBlocker(lane(doneChain()))).toBe("Every step is done.");
  });

  it("every chain tool builds a valid request from defaults", () => {
    const chain = BOARD_TOOLS.filter((t) => t.in !== null);
    expect(chain.length).toBeGreaterThanOrEqual(20);
    for (const t of chain) {
      const spec = getActionTool(t.id)!;
      expect(spec, t.id).toBeTruthy();
      const settings = { ...defaultSettings(spec), text: "x" };
      expect(audioActive(spec, settings), t.id).toBe(false);
      if (spec.usesEditLora) continue;
      expect(
        () => buildActionRequest(spec, settings, null),
        t.id,
      ).not.toThrow();
    }
  });

  it("is listed on the tools hub", () => {
    const cards = buildHubCards({
      toolCards: [],
      ctx: { catalog: null, packIds: null, editLoras: null },
    });
    const card = cards.find((c) => c.key === BOARD_KEY);
    expect(card).toMatchObject({ kind: "special", available: true, nc: false });
    expect(card!.aliases).toContain("canvas");
  });
});

describe("sanitizeBoards", () => {
  it("drops junk, settles running and falls back on activeId", () => {
    const raw = {
      activeId: "gone",
      boards: [
        null,
        { id: 5 },
        {
          id: "b",
          title: 7,
          lanes: [
            {
              id: "l",
              title: "Mine",
              steps: [
                {
                  id: "s",
                  tool: BOARD_PROMPT,
                  text: "hi",
                  status: "running",
                  runId: "r",
                },
                { id: "t", tool: "evil" },
                {
                  id: "u",
                  tool: "upscale",
                  status: "done",
                  jobIndex: 2,
                  outputUrl: "/o",
                },
              ],
            },
            { title: "no id" },
          ],
        },
      ],
    };
    const s = sanitizeBoards(raw);
    expect(s.activeId).toBe("b");
    expect(s.boards).toHaveLength(1);
    expect(s.boards[0].title).toBe("Board");
    expect(s.boards[0].lanes).toEqual([
      {
        id: "l",
        title: "Mine",
        steps: [
          {
            id: "s",
            tool: BOARD_PROMPT,
            text: "hi",
            status: "idle",
            runId: "r",
          },
          {
            id: "u",
            tool: "upscale",
            text: "",
            status: "done",
            jobIndex: 2,
            outputUrl: "/o",
          },
        ],
      },
    ]);
    expect(sanitizeBoards("nope")).toEqual(EMPTY_BOARDS);
    expect(sanitizeBoards(doneChain())).toEqual(doneChain());
  });
});

function json(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

/** Fake Adrift server for the board runner. */
function server(opts: { failOn?: string } = {}) {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const kindOf = new Map<string, string>();
  let n = 0;
  const run = (kind: string) => {
    n += 1;
    const pid = `p${n}`;
    kindOf.set(pid, kind);
    return { run_id: `r${n}`, jobs: [{ index: 0, prompt_id: pid }] };
  };
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ url, body });
      if (url === "/api/jobs/imagine") return json({ runs: [run("imagine")] });
      if (url === "/api/jobs/action")
        return json({ run: run(String(body.action)) });
      return json({ error: "nope" }, 404);
    }
    const m = /history\/(.+)$/.exec(url);
    const kind = m ? kindOf.get(decodeURIComponent(m[1])) : undefined;
    if (!kind) return json({}, 404);
    if (opts.failOn && kind.startsWith(opts.failOn))
      return json({
        status: {
          status_str: "error",
          messages: [
            [
              "execution_error",
              { exception_message: "OOM", node_type: "KSampler" },
            ],
          ],
        },
      });
    const f = (ext: string) => [
      {
        filename: `${kind}.${ext}`,
        subfolder: "",
        type: "output",
        url: `/f/${kind}.${ext}`,
      },
    ];
    return json(
      /animate|interpolate/.test(kind)
        ? { videos: f("mp4") }
        : { images: f("png") },
    );
  });
  return { fetchImpl, posts };
}

function chainLane(): BoardLane {
  return lane(
    reduce([
      created,
      { type: "addStep", ...base, stepId: "s1", tool: BOARD_PROMPT },
      { type: "addStep", ...base, stepId: "s2", tool: "upscale" },
      { type: "addStep", ...base, stepId: "s3", tool: "animate" },
      { type: "setStepText", ...base, stepId: "s1", text: "a red fox" },
    ]),
  );
}

describe("runBoardLane", () => {
  it("runs each step on the previous step's run", async () => {
    const { fetchImpl, posts } = server();
    const onRun = vi.fn();
    const patches: [string, string | undefined][] = [];
    const end = await runBoardLane(
      chainLane(),
      { fetchImpl, clientId: "c1", onRun, pollMs: 0 },
      (id, p) => patches.push([id, p.status]),
    );
    expect(end.steps.map((s) => [s.status, s.runId, s.outputUrl])).toEqual([
      ["done", "r1", "/f/imagine.png"],
      ["done", "r2", "/f/upscale_subtle.png"],
      ["done", "r3", "/f/animate_low.mp4"],
    ]);
    expect(posts[0]).toEqual({
      url: "/api/jobs/imagine",
      body: { prompt: "a red fox", client_id: "c1", batch_size: 1 },
    });
    expect(posts[1].body).toMatchObject({
      run_id: "r1",
      job_index: 0,
      action: "upscale_subtle",
    });
    expect(posts[2].body).toMatchObject({ run_id: "r2", job_index: 0 });
    expect(onRun).toHaveBeenCalledTimes(3);
    expect(patches).toEqual([
      ["s1", "running"],
      ["s1", "done"],
      ["s2", "running"],
      ["s2", "done"],
      ["s3", "running"],
      ["s3", "done"],
    ]);
  });

  it("stops at a failed step and resumes from it", async () => {
    const bad = server({ failOn: "upscale" });
    const end = await runBoardLane(
      chainLane(),
      { fetchImpl: bad.fetchImpl, clientId: "c1", pollMs: 0 },
      () => {},
    );
    expect(end.steps.map((s) => s.status)).toEqual(["done", "error", "idle"]);
    expect(end.steps[1].error).toBe("KSampler: OOM");
    expect(bad.posts).toHaveLength(2);

    const good = server();
    const again = await runBoardLane(
      end,
      { fetchImpl: good.fetchImpl, clientId: "c1", pollMs: 0 },
      () => {},
    );
    expect(again.steps.map((s) => s.status)).toEqual(["done", "done", "done"]);
    // Step 1 is not re-queued; the retry chains on its run.
    expect(good.posts[0].url).toBe("/api/jobs/action");
    expect(good.posts[0].body).toMatchObject({ run_id: "r1" });
  });

  it("does not start when cancelled and skips blocked lanes", async () => {
    const { fetchImpl, posts } = server();
    const end = await runBoardLane(
      chainLane(),
      { fetchImpl, clientId: "c1", pollMs: 0, isCancelled: () => true },
      () => {},
    );
    expect(end.steps.every((s) => s.status === "idle")).toBe(true);
    const blocked = { ...chainLane(), steps: chainLane().steps.slice(1) };
    await runBoardLane(
      blocked,
      { fetchImpl, clientId: "c1", pollMs: 0 },
      () => {},
    );
    expect(posts).toHaveLength(0);
  });

  it("never re-submits a step already running", async () => {
    const { fetchImpl, posts } = server();
    const base = chainLane();
    const live = {
      ...base,
      steps: base.steps.map((st, i) =>
        i === 0 ? { ...st, status: "running" as const } : st,
      ),
    };
    expect(nextStepIndex(live)).toBe(-1);
    expect(laneBlocker(live)).toBe("A step is running.");
    const end = await runBoardLane(
      live,
      { fetchImpl, clientId: "c1", pollMs: 0 },
      () => {},
    );
    expect(end).toBe(live);
    expect(posts).toHaveLength(0);
  });
});

describe("useBoardRunStore", () => {
  it("holds one run at a time and survives without a component", () => {
    const run = useBoardRunStore.getState();
    run.finish();
    expect(run.begin("b1")).toBe(true);
    expect(useBoardRunStore.getState().begin("b2")).toBe(false);
    expect(useBoardRunStore.getState().boardId).toBe("b1");
    useBoardRunStore.getState().setLane("l1");
    useBoardRunStore.getState().requestCancel();
    expect(useBoardRunStore.getState()).toMatchObject({
      boardId: "b1",
      laneId: "l1",
      cancelRequested: true,
    });
    useBoardRunStore.getState().finish();
    expect(useBoardRunStore.getState()).toMatchObject({
      boardId: null,
      laneId: null,
      cancelRequested: false,
    });
    // Stop with nothing running is a no-op, so the next run isn't pre-cancelled.
    useBoardRunStore.getState().requestCancel();
    expect(useBoardRunStore.getState().cancelRequested).toBe(false);
    expect(useBoardRunStore.getState().begin("b2")).toBe(true);
    useBoardRunStore.getState().finish();
  });
});
