/**
 * LTX VFX shots (src/lib/tools/ltxShots.ts): recipe Boards that chain the
 * LTX-2.5 tools. Step typing, hub cards + ltx25 gating, the linked first
 * step and a full Night Rain run through the board runner.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BOARD_CLIP,
  BOARD_SOURCE,
  EMPTY_BOARDS,
  boardReducer,
  boardTool,
  isPickStep,
  sanitizeBoards,
  stepIssue,
  type BoardsState,
} from "@/lib/tools/board";
import { runBoardLane, seedBoardClip } from "@/lib/tools/boardRunner";
import { buildHubCards } from "@/lib/tools/hub";
import { weightsClass } from "@/lib/tools/openWeights";
import { getActionTool } from "@/lib/tools/toolsPage";
import { LTX_VFX_SPECS } from "@/lib/oj/ltxVfx";
import {
  LTX_SHOT_RECIPES,
  boardFromRecipe,
  ltxShotCards,
  ltxShotForKey,
  ltxShotKey,
  recipeLaneIssues,
  reusableRecipeBoard,
  type LtxShotRecipe,
} from "@/lib/tools/ltxShots";

const LTX_TOOLS = new Set(["ltx25_animate", ...Object.keys(LTX_VFX_SPECS)]);

function recipe(id: string): LtxShotRecipe {
  const r = LTX_SHOT_RECIPES.find((x) => x.id === id);
  if (!r) throw new Error(`no recipe ${id}`);
  return r;
}

function ids() {
  let n = 0;
  return (prefix: string) => `${prefix}${++n}`;
}

describe("LTX shot recipes", () => {
  it("has the three shots, each step LTX and media-typed", () => {
    expect(LTX_SHOT_RECIPES.map((r) => r.id)).toEqual([
      "night_rain",
      "plate_matte",
      "living_photo",
    ]);
    for (const r of LTX_SHOT_RECIPES) {
      for (const lane of r.lanes) {
        const [first, ...rest] = lane.steps;
        expect(isPickStep(first.tool), r.id).toBe(true);
        expect(rest.length, r.id).toBeGreaterThan(0);
        for (const s of rest) {
          expect(LTX_TOOLS.has(s.tool), `${r.id}: ${s.tool}`).toBe(true);
          expect(getActionTool(s.tool)?.modelCheck?.pack, s.tool).toBe("ltx25");
        }
        // No placement issue ("Needs a clip, gets an image" and so on).
        for (const issue of recipeLaneIssues(lane))
          expect(issue ?? "", `${r.id}/${lane.title}`).not.toMatch(
            /Needs|Only the first|Unknown/,
          );
      }
    }
  });

  it("starts video-in steps from a clip and image-in steps from a photo", () => {
    for (const r of LTX_SHOT_RECIPES)
      for (const lane of r.lanes) {
        const want = boardTool(lane.steps[1].tool)?.in;
        expect(lane.steps[0].tool).toBe(
          want === "video" ? BOARD_CLIP : BOARD_SOURCE,
        );
      }
    expect(recipe("night_rain").lanes[0].steps.map((s) => s.tool)).toEqual([
      BOARD_CLIP,
      "ltx_day_to_night",
      "ltx_add_water",
    ]);
  });

  it("night rain is runnable once the clip is picked (water text prefilled)", () => {
    expect(recipeLaneIssues(recipe("night_rain").lanes[0])).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("rejects a mistyped chain", () => {
    expect(
      recipeLaneIssues({
        title: "bad",
        steps: [{ tool: BOARD_SOURCE }, { tool: "ltx_day_to_night" }],
      })[1],
    ).toBe("Needs a clip, gets an image");
  });
});

describe("LTX shot hub cards", () => {
  const keys = LTX_SHOT_RECIPES.map((r) => ltxShotKey(r.id));

  it("sit in the LTX VFX section with a revenue-cap badge", () => {
    const cards = buildHubCards({
      toolCards: [],
      ctx: { catalog: null, packIds: new Set(["ltx25"]), editLoras: null },
    });
    for (const key of keys) {
      const card = cards.find((c) => c.key === key);
      expect(card, key).toMatchObject({
        kind: "special",
        hubCategory: "VFX",
        available: true,
        nc: false,
      });
      expect(card!.model).toMatch(/^LTX-2\.5 22B/);
      expect(card!.aliases).toContain("ltx");
      expect(weightsClass(card!)).toBe("cap");
      expect(ltxShotForKey(key)?.title).toBe(card!.title);
    }
    expect(ltxShotForKey("special:board")).toBeUndefined();
    expect(ltxShotForKey("special:ltx_shot_nope")).toBeUndefined();
  });

  it("are gated on the ltx25 pack", () => {
    const checking = ltxShotCards({
      catalog: null,
      packIds: null,
      editLoras: null,
    });
    expect(checking.every((c) => c.checking && !c.available)).toBe(true);
    expect(checking.every((c) => c.unavailableReason === null)).toBe(true);

    const missing = ltxShotCards({
      catalog: null,
      packIds: new Set(["wan22"]),
      editLoras: null,
    });
    for (const c of missing) {
      expect(c.available).toBe(false);
      expect(c.checking).toBe(false);
      expect(c.unavailableReason).toMatch(/LTX-2\.5 pack/);
    }

    const ready = ltxShotCards({
      catalog: null,
      packIds: new Set(["ltx25"]),
      editLoras: null,
    });
    expect(ready.every((c) => c.available && !c.unavailableReason)).toBe(true);
  });
});

describe("recipe boards", () => {
  it("builds idle lanes with prefilled text", () => {
    const b = boardFromRecipe(recipe("night_rain"), ids(), 5);
    expect(b).toMatchObject({ title: "Night Rain Shot", recipe: "night_rain" });
    expect(b.linkedSource).toBeUndefined();
    expect(b.lanes[0].steps.map((s) => s.status)).toEqual([
      "idle",
      "idle",
      "idle",
    ]);
    expect(b.lanes[0].steps[2].text).toMatch(/rain/);
    expect(stepIssue(b.lanes[0], 0)).toBe("Pick a clip");
  });

  it("one pick fills both lanes of a linked recipe", () => {
    const board = boardFromRecipe(recipe("plate_matte"), ids(), 1);
    expect(board.linkedSource).toBe(true);
    let s: BoardsState = boardReducer(EMPTY_BOARDS, {
      type: "addBoard",
      board,
    });
    expect(s.activeId).toBe(board.id);
    const [a, b] = board.lanes;
    s = boardReducer(s, {
      type: "setSource",
      boardId: board.id,
      laneId: a.id,
      stepId: a.steps[0].id,
      source: { runId: "r9", jobIndex: 0, url: "/v.mp4", label: "shot.mp4" },
      now: 2,
    });
    for (const lane of s.boards[0].lanes) {
      expect(lane.steps[0]).toMatchObject({
        tool: BOARD_CLIP,
        status: "done",
        runId: "r9",
        label: "shot.mp4",
      });
      expect(stepIssue(lane, 1)).toBeNull();
    }
    // Clearing it clears both.
    s = boardReducer(s, {
      type: "setSource",
      boardId: board.id,
      laneId: b.id,
      stepId: b.steps[0].id,
      source: null,
      now: 3,
    });
    for (const lane of s.boards[0].lanes)
      expect(lane.steps[0].status).toBe("idle");
  });

  it("an unlinked board fills only its own lane", () => {
    let s = boardReducer(EMPTY_BOARDS, {
      type: "createBoard",
      id: "b",
      laneId: "l1",
      now: 1,
    });
    s = boardReducer(s, {
      type: "addLane",
      boardId: "b",
      laneId: "l2",
      now: 1,
    });
    for (const laneId of ["l1", "l2"])
      s = boardReducer(s, {
        type: "addStep",
        boardId: "b",
        laneId,
        stepId: `${laneId}c`,
        tool: BOARD_CLIP,
        now: 1,
      });
    s = boardReducer(s, {
      type: "setSource",
      boardId: "b",
      laneId: "l1",
      stepId: "l1c",
      source: { runId: "r1", jobIndex: 0, url: "/a.mp4", label: "a" },
      now: 2,
    });
    expect(s.boards[0].lanes.map((l) => l.steps[0].status)).toEqual([
      "done",
      "idle",
    ]);
  });

  it("reopens the untouched board instead of piling up new ones", () => {
    const make = ids();
    const first = boardFromRecipe(recipe("night_rain"), make, 1);
    let s = boardReducer(EMPTY_BOARDS, { type: "addBoard", board: first });
    expect(reusableRecipeBoard(s, "night_rain")).toBe(first.id);
    expect(reusableRecipeBoard(s, "plate_matte")).toBeNull();
    // Once a step ran, the card makes a fresh board.
    const lane = first.lanes[0];
    s = boardReducer(s, {
      type: "patchStep",
      boardId: first.id,
      laneId: lane.id,
      stepId: lane.steps[1].id,
      patch: { status: "done", runId: "r2" },
    });
    expect(reusableRecipeBoard(s, "night_rain")).toBeNull();
    // Duplicate ids are ignored.
    expect(boardReducer(s, { type: "addBoard", board: first })).toBe(s);
  });

  it("keeps recipe and link flags through persistence", () => {
    const board = boardFromRecipe(recipe("living_photo"), ids(), 1);
    const back = sanitizeBoards({ boards: [board], activeId: board.id });
    expect(back.boards[0]).toMatchObject({
      recipe: "living_photo",
      linkedSource: true,
    });
    expect(back.boards[0].lanes[0].steps[0].tool).toBe(BOARD_SOURCE);
  });
});

function json(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

describe("running a shot", () => {
  it("chains day to night then add water on the previous run", async () => {
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    let n = 0;
    const kinds = new Map<string, string>();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push({ url, body });
        n += 1;
        kinds.set(`p${n}`, String(body.action));
        return json({
          run: { run_id: `r${n}`, jobs: [{ index: 0, prompt_id: `p${n}` }] },
        });
      }
      const m = /history\/(.+)$/.exec(url);
      const kind = m ? kinds.get(decodeURIComponent(m[1])) : undefined;
      if (!kind) return json({}, 404);
      return json({
        videos: [
          {
            filename: `${kind}.mp4`,
            subfolder: "",
            type: "output",
            url: `/f/${kind}.mp4`,
          },
        ],
      });
    });
    const board = boardFromRecipe(recipe("night_rain"), ids(), 1);
    let s = boardReducer(EMPTY_BOARDS, { type: "addBoard", board });
    const l = board.lanes[0];
    s = boardReducer(s, {
      type: "setSource",
      boardId: board.id,
      laneId: l.id,
      stepId: l.steps[0].id,
      source: { runId: "r0", jobIndex: 0, url: "/day.mp4", label: "day" },
      now: 2,
    });
    const end = await runBoardLane(
      s.boards[0].lanes[0],
      { fetchImpl, clientId: "c1", pollMs: 0 },
      () => {},
    );
    expect(end.steps.map((x) => [x.status, x.runId])).toEqual([
      ["done", "r0"],
      ["done", "r1"],
      ["done", "r2"],
    ]);
    expect(posts.map((p) => p.url)).toEqual([
      "/api/jobs/action",
      "/api/jobs/action",
    ]);
    expect(posts[0].body).toMatchObject({
      run_id: "r0",
      action: "ltx_day_to_night",
      tool_page_id: "ltx_day_to_night",
    });
    expect(posts[1].body).toMatchObject({
      run_id: "r1",
      action: "ltx_add_water",
    });
    expect(String((posts[1].body.params as { prompt: string }).prompt)).toMatch(
      /rain/,
    );
    expect(end.steps[2].outputUrl).toBe("/f/ltx_add_water.mp4");
  });

  it("seeds a picked clip as a video run", async () => {
    const posts: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body;
      posts.push({
        url,
        body: typeof body === "string" ? JSON.parse(body) : body,
      });
      if (url === "/api/comfy/upload")
        return json({ ref: "cj_clip_1.mp4 [input]" });
      if (url === "/api/jobs/seed-run")
        return json({
          run: {
            run_id: "seed1",
            jobs: [{ index: 0, videos: ["/view/cj_clip_1.mp4"] }],
          },
        });
      return json({ error: "nope" }, 404);
    });
    const out = await seedBoardClip(fetchImpl, {
      id: "v",
      previewUrl: "blob:x",
      dataUrl: "data:video/mp4;base64,AAAA",
      label: "street.mp4",
      duration: 4.2,
      width: 1920,
      height: 1080,
    });
    expect(out).toEqual({
      runId: "seed1",
      jobIndex: 0,
      url: "/view/cj_clip_1.mp4",
      label: "street.mp4",
    });
    const seed = posts.find((p) => p.url === "/api/jobs/seed-run");
    expect(seed?.body).toMatchObject({
      width: 1920,
      height: 1080,
      duration: 4.2,
    });
    expect(seed?.body).toMatchObject({ ref: "cj_clip_1.mp4 [input]" });
    const upload = posts.find((p) => p.url === "/api/comfy/upload");
    expect(String((upload?.body as { filename: string }).filename)).toMatch(
      /\.mp4$/,
    );
  });
});
