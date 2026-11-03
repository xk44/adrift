/**
 * FLUX.3 -> LTX shots (src/lib/tools/flux3Shots.ts): recipe Boards where
 * FLUX.3 Klein makes or restyles the still and LTX-2.5 animates it. Step
 * typing, hub cards + flux3/ltx25 gating, the FLUX.3 key-art step and full
 * runs of both shots through the board runner.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BOARD_PROMPT_FLUX3,
  BOARD_SOURCE,
  BOARD_TOOLS,
  EMPTY_BOARDS,
  boardReducer,
  boardTool,
  boardToolTitle,
  sanitizeBoards,
  stepIssue,
} from "@/lib/tools/board";
import { flux3KeyArtPrompt, runBoardLane } from "@/lib/tools/boardRunner";
import { buildHubCards } from "@/lib/tools/hub";
import { weightsClass } from "@/lib/tools/openWeights";
import { getActionTool } from "@/lib/tools/toolsPage";
import { FEATURED_KEYS } from "@/lib/tools/hubVisuals";
import {
  LTX_SHOT_RECIPES,
  boardFromRecipe,
  ltxShotForKey,
  recipeLaneIssues,
  reusableRecipeBoard,
  type LtxShotRecipe,
} from "@/lib/tools/ltxShots";
import {
  FLUX3_SHOT_RECIPES,
  flux3ShotCards,
  flux3ShotForKey,
  flux3ShotKey,
} from "@/lib/tools/flux3Shots";

function recipe(id: string): LtxShotRecipe {
  const r = FLUX3_SHOT_RECIPES.find((x) => x.id === id);
  if (!r) throw new Error(`no recipe ${id}`);
  return r;
}

function ids() {
  let n = 0;
  return (prefix: string) => `${prefix}${++n}`;
}

describe("FLUX.3 -> LTX shot recipes", () => {
  it("has the two shots: FLUX.3 still in, LTX-2.5 animate last", () => {
    expect(FLUX3_SHOT_RECIPES.map((r) => r.id)).toEqual([
      "key_art",
      "restyle_animate",
    ]);
    expect(recipe("key_art").lanes[0].steps.map((s) => s.tool)).toEqual([
      BOARD_PROMPT_FLUX3,
      "ltx25_animate",
    ]);
    expect(recipe("restyle_animate").lanes[0].steps.map((s) => s.tool)).toEqual(
      [BOARD_SOURCE, "edit_flux3", "ltx25_animate"],
    );
    const packOf = (id: string) => {
      const t = getActionTool(id);
      return t?.requiredPack ?? t?.modelCheck?.pack;
    };
    expect(packOf("edit_flux3")).toBe("flux3");
    expect(packOf("ltx25_animate")).toBe("ltx25");
  });

  it("is runnable as shipped (every text prefilled, typing ok)", () => {
    for (const r of FLUX3_SHOT_RECIPES)
      for (const lane of r.lanes) {
        expect(recipeLaneIssues(lane), r.id).toEqual(
          lane.steps.map(() => null),
        );
        for (const s of lane.steps.slice(1))
          expect(s.text ?? "", `${r.id}: ${s.tool}`).not.toBe("");
      }
  });

  it("asks LTX for sound in the animate prompt", () => {
    for (const r of FLUX3_SHOT_RECIPES) {
      const last = r.lanes[0].steps.at(-1)!;
      expect(last.tool).toBe("ltx25_animate");
      expect(last.text, r.id).toMatch(/Sound:/);
    }
  });

  it("does not duplicate an LTX VFX shot", () => {
    const vfx = new Set(LTX_SHOT_RECIPES.map((r) => r.id));
    for (const r of FLUX3_SHOT_RECIPES) {
      expect(vfx.has(r.id)).toBe(false);
      expect(ltxShotForKey(flux3ShotKey(r.id))).toBeUndefined();
      // Every FLUX shot has a FLUX.3 step; the VFX shots have none.
      expect(
        r.lanes[0].steps.some(
          (s) => s.tool === BOARD_PROMPT_FLUX3 || s.tool === "edit_flux3",
        ),
      ).toBe(true);
    }
    for (const r of LTX_SHOT_RECIPES)
      for (const l of r.lanes)
        expect(l.steps.some((s) => /flux3/.test(s.tool))).toBe(false);
  });
});

describe("FLUX.3 key-art board step", () => {
  it("starts a lane with an image, gated on the FLUX.3 edit tool", () => {
    expect(boardTool(BOARD_PROMPT_FLUX3)).toMatchObject({
      in: null,
      out: "image",
      textLabel: "Prompt",
      textRequired: true,
      gate: "edit_flux3",
    });
    expect(boardToolTitle(BOARD_PROMPT_FLUX3)).toBe("Key art (FLUX.3)");
    // Only gates that are real action tools.
    for (const t of BOARD_TOOLS)
      if (t.gate) expect(getActionTool(t.gate), t.id).toBeTruthy();
  });

  it("needs its prompt", () => {
    const lane = {
      id: "l",
      title: "t",
      steps: [
        {
          id: "a",
          tool: BOARD_PROMPT_FLUX3,
          text: " ",
          status: "idle" as const,
        },
      ],
    };
    expect(stepIssue(lane, 0)).toMatch(/Prompt/i);
  });

  it("pins the FLUX.3 pack at 16:9 and strips user flags", () => {
    expect(flux3KeyArtPrompt("  a fox in snow ")).toBe(
      "a fox in snow --pack flux3 --ar 16:9",
    );
    expect(flux3KeyArtPrompt("a fox --ar 1:1 --pack qwen21")).toBe(
      "a fox ar 1:1 pack qwen21 --pack flux3 --ar 16:9",
    );
  });
});

describe("FLUX.3 -> LTX hub cards", () => {
  const keys = FLUX3_SHOT_RECIPES.map((r) => flux3ShotKey(r.id));
  const both = new Set(["flux3", "ltx25"]);

  it("sit in Video with a revenue-cap badge and both licenses", () => {
    const cards = buildHubCards({
      toolCards: [],
      ctx: { catalog: null, packIds: both, editLoras: null },
    });
    for (const key of keys) {
      const card = cards.find((c) => c.key === key);
      expect(card, key).toMatchObject({
        kind: "special",
        hubCategory: "Video",
        available: true,
        nc: false,
      });
      expect(card!.model).toBe("FLUX.3 Klein + LTX-2.5 22B");
      expect(card!.aliases).toEqual(
        expect.arrayContaining(["flux", "ltx", "pipeline"]),
      );
      expect(weightsClass(card!)).toBe("cap");
      const licenses = (card!.weightSources ?? []).map((s) => s.license);
      expect(licenses.join(" | ")).toMatch(/FLUX/);
      expect(licenses.join(" | ")).toMatch(/LTX/);
      expect(flux3ShotForKey(key)?.title).toBe(card!.title);
    }
    expect(flux3ShotForKey("special:board")).toBeUndefined();
    expect(flux3ShotForKey("special:flux3_shot_nope")).toBeUndefined();
  });

  it("leave the featured row alone", () => {
    for (const key of keys)
      expect(FEATURED_KEYS).not.toContain(key);
  });

  it("are gated on both the flux3 and the ltx25 pack", () => {
    const ctx = (packIds: Set<string> | null) => ({
      catalog: null,
      packIds,
      editLoras: null,
    });
    const checking = flux3ShotCards(ctx(null));
    expect(checking.every((c) => c.checking && !c.available)).toBe(true);
    expect(checking.every((c) => c.unavailableReason === null)).toBe(true);

    const cases: [string[], RegExp][] = [
      [["ltx25"], /^The FLUX\.3 pack/],
      [["flux3"], /^The LTX-2\.5 pack/],
      [["wan22"], /FLUX\.3 and LTX-2\.5 packs/],
    ];
    for (const [packs, reason] of cases)
      for (const c of flux3ShotCards(ctx(new Set(packs)))) {
        expect(c.available, packs.join()).toBe(false);
        expect(c.checking).toBe(false);
        expect(c.unavailableReason).toMatch(reason);
      }

    const ready = flux3ShotCards(ctx(both));
    expect(ready.every((c) => c.available && !c.unavailableReason)).toBe(true);
  });
});

describe("FLUX.3 -> LTX boards", () => {
  it("builds idle single-lane boards", () => {
    const b = boardFromRecipe(recipe("key_art"), ids(), 5);
    expect(b).toMatchObject({ title: "Key Art to Shot", recipe: "key_art" });
    expect(b.linkedSource).toBeUndefined();
    expect(b.lanes[0].steps.map((s) => s.status)).toEqual(["idle", "idle"]);
    expect(stepIssue(b.lanes[0], 0)).toBeNull();
    const r = boardFromRecipe(recipe("restyle_animate"), ids(), 5);
    expect(stepIssue(r.lanes[0], 0)).toBe("Pick an image");
  });

  it("makes a fresh board once the key art has run", () => {
    const first = boardFromRecipe(recipe("key_art"), ids(), 1);
    let s = boardReducer(EMPTY_BOARDS, { type: "addBoard", board: first });
    expect(reusableRecipeBoard(s, "key_art")).toBe(first.id);
    const lane = first.lanes[0];
    s = boardReducer(s, {
      type: "patchStep",
      boardId: first.id,
      laneId: lane.id,
      stepId: lane.steps[0].id,
      patch: { status: "done", runId: "r1" },
    });
    expect(reusableRecipeBoard(s, "key_art")).toBeNull();
  });

  it("keeps the FLUX.3 step through persistence", () => {
    const board = boardFromRecipe(recipe("key_art"), ids(), 1);
    const back = sanitizeBoards({ boards: [board], activeId: board.id });
    expect(back.boards[0].recipe).toBe("key_art");
    expect(back.boards[0].lanes[0].steps[0]).toMatchObject({
      tool: BOARD_PROMPT_FLUX3,
      text: expect.stringMatching(/lighthouse/),
    });
  });
});

function json(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

/** Fake server: imagine -> image run, action -> run, history by kind. */
function fakeServer() {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const kinds = new Map<string, string>();
  let n = 0;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ url, body });
      n += 1;
      const kind =
        url === "/api/jobs/imagine" ? "imagine" : String(body.action);
      kinds.set(`p${n}`, kind);
      const run = { run_id: `r${n}`, jobs: [{ index: 0, prompt_id: `p${n}` }] };
      return json(url === "/api/jobs/imagine" ? { runs: [run] } : { run });
    }
    const m = /history\/(.+)$/.exec(url);
    const kind = m ? kinds.get(decodeURIComponent(m[1])) : undefined;
    if (!kind) return json({}, 404);
    const file = { subfolder: "", type: "output" };
    return json(
      kind === "ltx25_animate"
        ? {
            videos: [
              { ...file, filename: `${kind}.mp4`, url: `/f/${kind}.mp4` },
            ],
          }
        : {
            images: [
              { ...file, filename: `${kind}.png`, url: `/f/${kind}.png` },
            ],
          },
    );
  });
  return { fetchImpl, posts };
}

describe("running a FLUX.3 -> LTX shot", () => {
  it("key art: FLUX.3 16:9 imagine, then LTX animate on that run", async () => {
    const { fetchImpl, posts } = fakeServer();
    const board = boardFromRecipe(recipe("key_art"), ids(), 1);
    const end = await runBoardLane(
      board.lanes[0],
      { fetchImpl, clientId: "c1", pollMs: 0 },
      () => {},
    );
    expect(end.steps.map((x) => [x.status, x.runId])).toEqual([
      ["done", "r1"],
      ["done", "r2"],
    ]);
    expect(posts.map((p) => p.url)).toEqual([
      "/api/jobs/imagine",
      "/api/jobs/action",
    ]);
    expect(String(posts[0].body.prompt)).toMatch(
      /lighthouse keeper.* --pack flux3 --ar 16:9$/,
    );
    expect(posts[0].body).toMatchObject({ client_id: "c1", batch_size: 1 });
    expect(posts[1].body).toMatchObject({
      run_id: "r1",
      action: "ltx25_animate",
    });
    expect(String((posts[1].body.params as { prompt: string }).prompt)).toMatch(
      /Sound:/,
    );
    expect(end.steps[0].outputUrl).toBe("/f/imagine.png");
    expect(end.steps[1].outputUrl).toBe("/f/ltx25_animate.mp4");
  });

  it("restyle: FLUX.3 edit of the photo, then LTX animate on the edit", async () => {
    const { fetchImpl, posts } = fakeServer();
    const board = boardFromRecipe(recipe("restyle_animate"), ids(), 1);
    let s = boardReducer(EMPTY_BOARDS, { type: "addBoard", board });
    const l = board.lanes[0];
    s = boardReducer(s, {
      type: "setSource",
      boardId: board.id,
      laneId: l.id,
      stepId: l.steps[0].id,
      source: { runId: "r0", jobIndex: 0, url: "/photo.png", label: "photo" },
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
    expect(posts.map((p) => [p.url, p.body.run_id, p.body.action])).toEqual([
      ["/api/jobs/action", "r0", "edit_flux3"],
      ["/api/jobs/action", "r1", "ltx25_animate"],
    ]);
    expect(end.steps[2].outputUrl).toBe("/f/ltx25_animate.mp4");
  });
});
