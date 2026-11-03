/**
 * Judge mode (ADRIFT_JUDGE_MODE=1): token check, per-judge quota, the single
 * GPU slot queue, the route allowlist on server routes, and private routes
 * answering 404/401 in judge mode.
 *
 * Run with: npx vitest run src/__tests__/judgeMode.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { requireAdmin } from "@/lib/auth";
import {
  JUDGE_COOKIE,
  checkJudgeUpload,
  collectBodyRefs,
  isJudgeTokenEdge,
  judgeActionCost,
  judgePageDecision,
  judgeRouteKind,
  judgeTokens,
  judgeToolCost,
  sniffUpload,
} from "@/lib/judge/judgePolicy";
import {
  acquireSlot,
  forbiddenField,
  judgeIdFor,
  judgeOutputs,
  judgeUsage,
  ownsFile,
  queueSnapshot,
  releaseSlot,
  resetJudgeState,
  setJudgeDoneProbe,
  verifyJudgeToken,
  withJudge,
} from "@/lib/judge/judgeServer";
import { queuedDetails } from "@/components/judge/judgeQueue";

const TOKEN_A = "judge-token-aaaaaaaaaaaaaaaa";
const TOKEN_B = "judge-token-bbbbbbbbbbbbbbbb";
const ORIGIN = "http://localhost:3100";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "judge-test-"));
  vi.stubEnv("ADRIFT_JUDGE_MODE", "1");
  vi.stubEnv("ADRIFT_JUDGE_TOKENS", `${TOKEN_A}, ${TOKEN_B}, short`);
  vi.stubEnv("ADRIFT_JUDGE_RUN_QUOTA", "3");
  vi.stubEnv("ADRIFT_JUDGE_STATE_FILE", "off");
  vi.stubEnv("ADRIFT_JUDGE_PAUSE_FILE", path.join(tmpDir, "paused"));
  vi.stubEnv("ADMIN_API_KEY", "admin-key-for-tests-0123456789");
  resetJudgeState();
  setJudgeDoneProbe(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetJudgeState();
  setJudgeDoneProbe(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function req(
  pathname: string,
  init: {
    method?: string;
    token?: string | null;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): NextRequest {
  const headers: Record<string, string> = {
    host: "localhost:3100",
    origin: ORIGIN,
    ...(init.headers ?? {}),
  };
  if (init.token) headers.cookie = `${JUDGE_COOKIE}=${init.token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`${ORIGIN}${pathname}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** A handler that reports success with a run + prompt, like /api/jobs/*. */
function okRunHandler(runId: string, promptId: string) {
  return vi.fn(async () =>
    Response.json({
      ok: true,
      run: { run_id: runId, jobs: [{ prompt_id: promptId }] },
    }),
  );
}

describe("judge tokens", () => {
  it("ignores too-short tokens from the env list", () => {
    expect(judgeTokens()).toEqual([TOKEN_A, TOKEN_B]);
  });

  it("node check: valid tokens map to stable distinct ids", () => {
    expect(verifyJudgeToken(TOKEN_A)).toBe(judgeIdFor(TOKEN_A));
    expect(verifyJudgeToken(TOKEN_B)).toBe(judgeIdFor(TOKEN_B));
    expect(judgeIdFor(TOKEN_A)).not.toBe(judgeIdFor(TOKEN_B));
    expect(judgeIdFor(TOKEN_A)).not.toContain(TOKEN_A);
  });

  it("node check: rejects wrong, empty, short and prefix tokens", () => {
    expect(verifyJudgeToken("")).toBeNull();
    expect(verifyJudgeToken("short")).toBeNull();
    expect(verifyJudgeToken(TOKEN_A.slice(0, -1))).toBeNull();
    expect(verifyJudgeToken(`${TOKEN_A}x`)).toBeNull();
    expect(verifyJudgeToken("x".repeat(300))).toBeNull();
  });

  it("edge check agrees with the node check", async () => {
    expect(await isJudgeTokenEdge(TOKEN_A)).toBe(true);
    expect(await isJudgeTokenEdge(TOKEN_B)).toBe(true);
    expect(await isJudgeTokenEdge("short")).toBe(false);
    expect(await isJudgeTokenEdge(`${TOKEN_A}x`)).toBe(false);
  });

  it("no tokens configured -> nobody gets in", async () => {
    vi.stubEnv("ADRIFT_JUDGE_TOKENS", "");
    expect(verifyJudgeToken(TOKEN_A)).toBeNull();
    expect(await isJudgeTokenEdge(TOKEN_A)).toBe(false);
  });
});

describe("route allowlist", () => {
  it.each([
    ["/api/jobs/action", "POST", "action"],
    ["/api/jobs/tool", "POST", "tool"],
    ["/api/comfy/upload", "POST", "upload"],
    ["/api/comfy/history/abc-123", "GET", "history"],
    ["/api/comfy/image", "HEAD", "image"],
    ["/api/judge/status", "GET", "status"],
    ["/api/tools", "GET", "open"],
  ])("%s %s -> %s", (p, m, kind) => {
    expect(judgeRouteKind(p, m)).toBe(kind);
  });

  it.each([
    ["/api/comfy/prompt", "POST"],
    ["/api/comfy/view", "GET"],
    ["/api/comfy/models", "GET"],
    ["/api/comfy/manager/install", "POST"],
    ["/api/comfy/workflows", "GET"],
    ["/api/comfy/input-specs", "GET"],
    ["/api/comfy/history/a/b", "GET"],
    ["/api/comfy/history/", "GET"],
    ["/api/jobs/recent", "GET"],
    ["/api/jobs/imagine", "POST"],
    ["/api/jobs/import-history", "POST"],
    ["/api/jobs/workflow", "POST"],
    ["/api/settings", "GET"],
    ["/api/settings/dirs", "POST"],
    ["/api/admin/anything", "GET"],
    ["/api/hf/download", "POST"],
    ["/api/civitai/download", "POST"],
    ["/api/user-tools", "POST"],
    ["/api/vault", "GET"],
    ["/api/jobs/action", "GET"],
    ["/api/comfy/image", "POST"],
    ["/api/comfy/%2e%2e/image", "GET"],
    ["/api/comfy/../settings", "GET"],
  ])("%s %s is not allowed", (p, m) => {
    expect(judgeRouteKind(p, m)).toBeNull();
  });

  it("pages: only the studio and shipped assets", () => {
    expect(judgePageDecision("/")).toBe("studio");
    expect(judgePageDecision("/judge")).toBe("studio");
    expect(judgePageDecision("/_next/static/chunks/a.js")).toBe("asset");
    expect(judgePageDecision("/manifest.webmanifest")).toBe("asset");
    for (const p of [
      "/gallery",
      "/settings",
      "/explore",
      "/organize",
      "/sw.js",
      "/previews/x.png",
      "/workflows/packs/a.json",
      "/_next/../settings",
    ]) {
      expect(judgePageDecision(p)).toBe("deny");
    }
  });

  it("tool allowlist and costs", () => {
    expect(judgeActionCost("ltx_alpha_matte")).toBe(1);
    expect(judgeActionCost("pipeline_script")).toBe(0);
    expect(judgeActionCost("imagine")).toBeNull();
    expect(judgeActionCost("train_lora")).toBeNull();
    expect(judgeActionCost(undefined)).toBeNull();
    expect(judgeToolCost("krea2-general-edit")).toBe(1);
    expect(judgeToolCost("some-other-tool")).toBeNull();
  });

  it("forbids workflow files, overrides, dry runs and odd pack ids", () => {
    expect(forbiddenField({ action: "upscale" })).toBeNull();
    expect(forbiddenField({ params: { pack_id: "ltx-vfx" } })).toBeNull();
    expect(forbiddenField({ workflow_path: "x.json" })).toBe("workflow_path");
    expect(forbiddenField({ params: { workflow_control_overrides: {} } })).toBe(
      "workflow_control_overrides",
    );
    expect(forbiddenField({ dry_run: true })).toBe("dry_run");
    expect(forbiddenField({ dry_run: false })).toBeNull();
    expect(forbiddenField({ pack_id: "../../etc" })).toBe("pack_id");
    expect(forbiddenField({ params: { packId: "/abs/path" } })).toBe("packId");
  });

  it("collects file, run and prompt refs from nested bodies", () => {
    const refs = collectBodyRefs({
      run_id: "r1",
      images: ["a.png [input]", "/api/comfy/image?filename=b.png&type=output"],
      params: { prompt: "a cat.png on a table", nested: { promptId: "p1" } },
      mask: "data:image/png;base64,AAAA",
    });
    expect(refs.runIds).toEqual(["r1"]);
    expect(refs.promptIds).toEqual(["p1"]);
    expect(refs.files).toEqual(
      expect.arrayContaining(["input/a.png", "output/b.png"]),
    );
    expect(refs.files.some((f) => f.includes("cat.png"))).toBe(false);
  });
});

describe("uploads", () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32),
  ]);

  it("sniffs magic bytes", () => {
    expect(sniffUpload(new Uint8Array(png))).toBe("image");
    expect(sniffUpload(new Uint8Array(Buffer.from("<svg xmlns>......")))).toBe(
      null,
    );
  });

  it("accepts a real PNG and rejects mismatches, types and size", () => {
    const ok = `data:image/png;base64,${png.toString("base64")}`;
    expect(checkJudgeUpload(ok, 1024).ok).toBe(true);
    const svg = `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`;
    expect(checkJudgeUpload(svg, 1024)).toMatchObject({
      ok: false,
      status: 415,
    });
    const lie = `data:video/mp4;base64,${png.toString("base64")}`;
    expect(checkJudgeUpload(lie, 1024).ok).toBe(false);
    const html = `data:image/png;base64,${Buffer.from("<html><script>....").toString("base64")}`;
    expect(checkJudgeUpload(html, 1024).ok).toBe(false);
    expect(checkJudgeUpload(ok, 8)).toMatchObject({ ok: false, status: 413 });
    expect(checkJudgeUpload("/etc/passwd", 1024).ok).toBe(false);
  });

  it("upload route: bad type never reaches the handler; good ones are owned", async () => {
    const handler = vi.fn(async () =>
      Response.json({ ok: true, ref: "up_abc.png [input]" }),
    );
    const wrapped = withJudge("upload", handler);
    const bad = await wrapped(
      req("/api/comfy/upload", {
        method: "POST",
        token: TOKEN_A,
        body: { image: "data:text/html;base64,PGh0bWw+" },
      }),
    );
    expect(bad.status).toBe(415);
    const sub = await wrapped(
      req("/api/comfy/upload", {
        method: "POST",
        token: TOKEN_A,
        body: {
          image: `data:image/png;base64,${png.toString("base64")}`,
          subfolder: "../private",
        },
      }),
    );
    expect(sub.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();

    const good = await wrapped(
      req("/api/comfy/upload", {
        method: "POST",
        token: TOKEN_A,
        body: { image: `data:image/png;base64,${png.toString("base64")}` },
      }),
    );
    expect(good.status).toBe(200);
    expect(ownsFile(judgeIdFor(TOKEN_A), "input/up_abc.png")).toBe(true);
    expect(ownsFile(judgeIdFor(TOKEN_B), "input/up_abc.png")).toBe(false);
  });
});

describe("quota and GPU slot", () => {
  it("one slot, FIFO queue with positions", async () => {
    const a = judgeIdFor(TOKEN_A);
    const b = judgeIdFor(TOKEN_B);
    expect(await acquireSlot(a, 1000)).toEqual({ ok: true });
    expect(await acquireSlot(b, 1001)).toMatchObject({
      ok: false,
      position: 1,
    });
    expect(queueSnapshot(b)).toEqual({ busy: true, mine: false, position: 1 });
    // A can't jump the queue with a second run while B waits.
    expect(await acquireSlot(a, 1002)).toMatchObject({
      ok: false,
      position: 2,
    });
    releaseSlot(a);
    expect(await acquireSlot(b, 1003)).toEqual({ ok: true });
  });

  it("an expired lease frees the slot", async () => {
    vi.stubEnv("ADRIFT_JUDGE_LEASE_MS", "60000");
    const a = judgeIdFor(TOKEN_A);
    const b = judgeIdFor(TOKEN_B);
    expect((await acquireSlot(a, 0)).ok).toBe(true);
    expect((await acquireSlot(b, 1000)).ok).toBe(false);
    expect((await acquireSlot(b, 120_000)).ok).toBe(true);
  });

  it("action route: counts runs, queues the second judge, stops at quota", async () => {
    const wrapped = withJudge("action", okRunHandler("run-1", "p-1"));
    const body = { action: "ltx_alpha_matte", params: {} };
    const r1 = await wrapped(
      req("/api/jobs/action", { method: "POST", token: TOKEN_A, body }),
    );
    expect(r1.status).toBe(200);
    expect(judgeUsage(judgeIdFor(TOKEN_A))).toEqual({ used: 1, quota: 3 });

    // Judge B is queued while A's prompt is on the GPU.
    const rb = await wrapped(
      req("/api/jobs/action", { method: "POST", token: TOKEN_B, body }),
    );
    expect(rb.status).toBe(429);
    expect(rb.headers.get("Retry-After")).toBe("5");
    expect(await queuedDetails(rb)).toEqual({ position: 1, retryAfterS: 5 });
    expect(judgeUsage(judgeIdFor(TOKEN_B)).used).toBe(0);

    // A's history arrives -> slot freed (history handler records outputs).
    const hist = withJudge("history", async () =>
      Response.json({
        ok: true,
        images: [
          {
            filename: "out_1.png",
            subfolder: "",
            type: "output",
            url: "/api/comfy/image?filename=out_1.png&subfolder=&type=output",
          },
        ],
      }),
    );
    const h = await hist(req("/api/comfy/history/p-1", { token: TOKEN_A }));
    expect(h.status).toBe(200);
    expect(judgeOutputs(judgeIdFor(TOKEN_A))).toHaveLength(1);
    expect(judgeOutputs(judgeIdFor(TOKEN_B))).toHaveLength(0);
    expect(ownsFile(judgeIdFor(TOKEN_A), "output/out_1.png")).toBe(true);

    // Use up A's quota (3) with B out of the way.
    resetJudgeState();
    const run = async () => {
      const res = await wrapped(
        req("/api/jobs/action", { method: "POST", token: TOKEN_A, body }),
      );
      releaseSlot(judgeIdFor(TOKEN_A));
      return res;
    };
    expect((await run()).status).toBe(200);
    expect((await run()).status).toBe(200);
    expect((await run()).status).toBe(200);
    const over = await run();
    expect(over.status).toBe(429);
    expect((await over.json()).details.code).toBe("judge_quota");
  });

  it("a failed submit releases the slot and costs nothing", async () => {
    const failing = withJudge("action", async () =>
      Response.json({ ok: false, error: "boom" }, { status: 500 }),
    );
    const body = { action: "upscale", params: {} };
    const r = await failing(
      req("/api/jobs/action", { method: "POST", token: TOKEN_A, body }),
    );
    expect(r.status).toBe(500);
    expect(judgeUsage(judgeIdFor(TOKEN_A)).used).toBe(0);
    expect(queueSnapshot(judgeIdFor(TOKEN_A)).busy).toBe(false);
  });

  it("pause file -> 503 without touching the GPU", async () => {
    fs.writeFileSync(path.join(tmpDir, "paused"), "");
    const handler = okRunHandler("r", "p");
    const r = await withJudge(
      "action",
      handler,
    )(
      req("/api/jobs/action", {
        method: "POST",
        token: TOKEN_A,
        body: { action: "upscale" },
      }),
    );
    expect(r.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("server route enforcement", () => {
  it("no cookie -> 401; wrong route kind -> 404", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const wrapped = withJudge("action", handler);
    const noCookie = await wrapped(
      req("/api/jobs/action", { method: "POST", body: { action: "upscale" } }),
    );
    expect(noCookie.status).toBe(401);
    const wrongKind = await withJudge(
      "action",
      handler,
    )(
      req("/api/jobs/tool", {
        method: "POST",
        token: TOKEN_A,
        body: { action: "upscale" },
      }),
    );
    expect(wrongKind.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it("non-allowlisted actions/tools and forbidden fields -> 403", async () => {
    const handler = okRunHandler("r", "p");
    const action = withJudge("action", handler);
    const tool = withJudge("tool", handler);
    const post = (p: string, body: unknown) =>
      req(p, { method: "POST", token: TOKEN_A, body });
    expect(
      (await action(post("/api/jobs/action", { action: "imagine" }))).status,
    ).toBe(403);
    expect(
      (await tool(post("/api/jobs/tool", { toolId: "lora-trainer" }))).status,
    ).toBe(403);
    expect(
      (
        await action(
          post("/api/jobs/action", {
            action: "upscale",
            workflow_path: "/abs/private.json",
          }),
        )
      ).status,
    ).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refs to files, runs or prompts the judge doesn't own -> 403/404", async () => {
    const handler = okRunHandler("r", "p");
    const action = withJudge("action", handler);
    const foreignFile = await action(
      req("/api/jobs/action", {
        method: "POST",
        token: TOKEN_A,
        body: { action: "upscale", params: { image: "private.png [output]" } },
      }),
    );
    expect(foreignFile.status).toBe(403);
    const foreignRun = await action(
      req("/api/jobs/action", {
        method: "POST",
        token: TOKEN_A,
        body: { action: "upscale", run_id: "someone-elses-run" },
      }),
    );
    expect(foreignRun.status).toBe(403);
    const seed = await withJudge(
      "seed",
      handler,
    )(
      req("/api/jobs/seed-run", {
        method: "POST",
        token: TOKEN_A,
        body: { image: "/api/comfy/image?filename=x.png&type=output" },
      }),
    );
    expect(seed.status).toBe(403);
    const cancel = await withJudge(
      "cancel",
      handler,
    )(
      req("/api/jobs/cancel", {
        method: "POST",
        token: TOKEN_A,
        body: { prompt_id: "not-mine" },
      }),
    );
    expect(cancel.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it("image/history of other content -> 404 (real image route)", async () => {
    const { GET } = await import("@/app/api/comfy/image/route");
    const res = await GET(
      req("/api/comfy/image?filename=private.png&subfolder=&type=output", {
        token: TOKEN_A,
      }),
    );
    expect(res.status).toBe(404);
    const hist = vi.fn(async () => Response.json({ ok: true }));
    const h = await withJudge(
      "history",
      hist,
    )(req("/api/comfy/history/someone-else", { token: TOKEN_B }));
    expect(h.status).toBe(404);
    expect(hist).not.toHaveBeenCalled();
  });

  it("real action route rejects a non-allowlisted action before any work", async () => {
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req("/api/jobs/action", {
        method: "POST",
        token: TOKEN_A,
        body: { action: "imagine", run_id: "x", job_index: 0 },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("requireAdmin: admin key not accepted, private routes 404", () => {
    const admin = { authorization: "Bearer admin-key-for-tests-0123456789" };
    const r1 = requireAdmin(req("/api/settings", { headers: admin }));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.response.status).toBe(401);
    const r2 = requireAdmin(req("/api/comfy/prompt", { token: TOKEN_A }));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.response.status).toBe(404);
    const r3 = requireAdmin(
      req("/api/jobs/action", { method: "POST", token: TOKEN_A }),
    );
    expect(r3.ok).toBe(true);
  });

  it("outside judge mode the wrapper is a pass-through", async () => {
    vi.stubEnv("ADRIFT_JUDGE_MODE", "");
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const res = await withJudge(
      "action",
      handler,
    )(req("/api/jobs/action", { method: "POST", body: { action: "imagine" } }));
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("middleware in judge mode", () => {
  it("?judge=<token> sets an httpOnly SameSite=Strict cookie", async () => {
    const res = await middleware(req(`/?judge=${TOKEN_A}`));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${JUDGE_COOKIE}=${TOKEN_A}`);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=strict");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("a bad ?judge= token sets nothing", async () => {
    const res = await middleware(req("/?judge=nope-nope-nope-nope-nope"));
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("no cookie -> 401 for pages and API", async () => {
    expect((await middleware(req("/"))).status).toBe(401);
    expect((await middleware(req("/api/tools"))).status).toBe(401);
    expect(
      (await middleware(req("/api/jobs/action", { method: "POST" }))).status,
    ).toBe(401);
  });

  it.each([
    "/api/settings",
    "/api/comfy/prompt",
    "/api/comfy/view",
    "/api/comfy/models",
    "/api/jobs/recent",
    "/api/vault",
    "/api/hf/files",
    "/api/admin/users",
  ])("private API %s -> 404 even with a judge cookie", async (p) => {
    const res = await middleware(req(p, { token: TOKEN_A }));
    expect(res.status).toBe(404);
  });

  it.each(["/gallery", "/settings", "/explore", "/previews/a.png", "/sw.js"])(
    "private page %s -> 404",
    async (p) => {
      const res = await middleware(req(p, { token: TOKEN_A }));
      expect(res.status).toBe(404);
    },
  );

  it("studio pages rewrite to /judge; allowlisted API continues", async () => {
    const page = await middleware(req("/", { token: TOKEN_A }));
    expect(page.headers.get("x-middleware-rewrite")).toContain("/judge");
    const api = await middleware(req("/api/tools", { token: TOKEN_A }));
    expect(api.status).toBe(200);
    expect(api.headers.get("x-middleware-next")).toBe("1");
  });

  it("judge mode off: pages pass through untouched", async () => {
    vi.stubEnv("ADRIFT_JUDGE_MODE", "");
    const res = await middleware(req("/gallery"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});
