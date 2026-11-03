/** Global job queue drawer: snapshot selectors, cancel + retry wiring. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ImagineJob, ImagineRun } from "@/types";
import {
  buildQueueSnapshot,
  editRunIdSet,
  hasQueueActivity,
  queueSourceOf,
} from "@/lib/queue/queueEntries";
import { requestJobCancel } from "@/lib/queue/cancelJob";
import { retryPromptRun, type RetryWorkflowState } from "@/lib/queue/retryRun";
import { useQueueDrawerStore } from "@/store/queueDrawerStore";
import { queueStatusText } from "@/components/QueueDrawer";

function job(over: Partial<ImagineJob> = {}): ImagineJob {
  return {
    seed: 1,
    index: 0,
    status: "queued",
    progress: 0,
    images: [],
    ...over,
  };
}

function run(id: string, over: Partial<ImagineRun> = {}): ImagineRun {
  return {
    run_id: id,
    prompt: `prompt ${id}`,
    parsedPrompt: `prompt ${id}`,
    width: 1024,
    height: 1024,
    jobs: [job({ prompt_id: `p-${id}` })],
    createdAt: "2026-10-29T10:00:00.000Z",
    status: "queued",
    params: {},
    ...over,
  };
}

const TOOL_PARAMS = {
  action_provenance: {
    kind: "tool",
    id: "object_remover",
    label: "Object Remover",
  },
};

describe("buildQueueSnapshot", () => {
  it("lists running first, then queued oldest-first", () => {
    const runs = [
      run("new", { createdAt: "2026-10-29T10:05:00.000Z" }),
      run("old", { createdAt: "2026-10-29T10:01:00.000Z" }),
      run("live", {
        createdAt: "2026-10-29T10:09:00.000Z",
        status: "running",
        jobs: [
          job({
            prompt_id: "p-live",
            status: "running",
            progress: 41.6,
            currentNodeLabel: "KSampler",
          }),
        ],
      }),
    ];
    const { active, recent } = buildQueueSnapshot(runs);
    expect(active.map((e) => e.runId)).toEqual(["live", "old", "new"]);
    expect(active[0].progress).toBe(42);
    expect(queueStatusText(active[0])).toBe("42% · KSampler");
    expect(queueStatusText(active[1])).toBe("Queued");
    expect(recent).toEqual([]);
  });

  it("keeps recent finished/failed newest first, capped, skipping server history", () => {
    const runs = [
      run("a", {
        status: "done",
        jobs: [job({ status: "done", images: ["/a.png"], completedAt: 100 })],
      }),
      run("b", {
        status: "error",
        jobs: [job({ status: "error", error: "OOM", completedAt: 300 })],
      }),
      run("c", {
        status: "cancelled",
        jobs: [job({ status: "cancelled", completedAt: 200 })],
      }),
      run("hist", {
        historySource: "server",
        status: "done",
        jobs: [job({ status: "done", completedAt: 999 })],
      }),
    ];
    const { recent } = buildQueueSnapshot(runs, new Set(), 2);
    expect(recent.map((e) => e.runId)).toEqual(["b", "c"]);
    expect(queueStatusText(recent[0])).toBe("Failed: OOM");
    const all = buildQueueSnapshot(runs).recent;
    expect(all.map((e) => e.runId)).toEqual(["b", "c", "a"]);
    expect(all[2].thumb).toBe("/a.png");
  });

  it("classifies Create, Tools and Edit runs", () => {
    const edit = new Set(["e1"]);
    expect(queueSourceOf(run("x"), edit)).toBe("create");
    expect(queueSourceOf(run("t", { params: TOOL_PARAMS }), edit)).toBe(
      "tools",
    );
    expect(queueSourceOf(run("e1", { params: TOOL_PARAMS }), edit)).toBe(
      "edit",
    );

    const { active } = buildQueueSnapshot(
      [
        run("t", { params: TOOL_PARAMS }),
        run("e1", { params: TOOL_PARAMS }),
        run("x"),
      ],
      edit,
    );
    const byId = Object.fromEntries(active.map((e) => [e.runId, e]));
    expect(byId.t.label).toBe("Object Remover");
    expect(byId.t.jumpable).toBe(true);
    expect(byId.t.retryable).toBe(false);
    expect(byId.e1.jumpable).toBe(false);
    expect(byId.x.label).toBe("Prompt");
    expect(byId.x.retryable).toBe(true);
  });

  it("uses the source image as a thumbnail until outputs exist", () => {
    const { active } = buildQueueSnapshot([
      run("s", {
        sourceImages: [
          { id: "1", url: "/src.png", mode: "image", weight: 1 } as never,
        ],
      }),
    ]);
    expect(active[0].thumb).toBe("/src.png");
  });

  it("flags video outputs so the row shows a media icon", () => {
    const { recent } = buildQueueSnapshot([
      run("v", {
        status: "done",
        jobs: [job({ status: "done", videos: ["/v.mp4"], completedAt: 1 })],
      }),
    ]);
    expect(recent[0].mediaKind).toBe("video");
    expect(recent[0].thumb).toBeUndefined();
  });
});

describe("editRunIdSet / hasQueueActivity", () => {
  it("counts inline editor and video tool runs, not Tools-page handoffs", () => {
    const ids = editRunIdSet(
      [
        { runId: "inline", origin: "inline" },
        { runId: "fromTools", origin: "tool" },
      ],
      [{ runId: "video" }],
    );
    expect([...ids].sort()).toEqual(["inline", "video"]);
  });

  it("is false for an idle session and history-only runs", () => {
    expect(hasQueueActivity([])).toBe(false);
    expect(
      hasQueueActivity([run("h", { historySource: "server", status: "done" })]),
    ).toBe(false);
    expect(hasQueueActivity([run("q")])).toBe(true);
  });
});

describe("queue drawer store", () => {
  it("opens, toggles and closes", () => {
    const s = useQueueDrawerStore.getState();
    s.setOpen(false);
    s.toggle();
    expect(useQueueDrawerStore.getState().open).toBe(true);
    useQueueDrawerStore.getState().toggle();
    expect(useQueueDrawerStore.getState().open).toBe(false);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("requestJobCancel", () => {
  it("posts the prompt id to /api/jobs/cancel and reports a queue delete", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, action: "queue-delete" }),
    );
    const confirm = vi.fn();
    const outcome = await requestJobCancel("p-1", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      confirmGlobalInterrupt: confirm,
    });
    expect(outcome).toBe("cancelled");
    expect(confirm).not.toHaveBeenCalled();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/jobs/cancel");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ prompt_id: "p-1" });
  });

  it("asks before a global interrupt and resends with confirm_global", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          action: "confirm-global-interrupt",
          comfyui_version: "0.3.40",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true, action: "interrupt" }));
    const confirm = vi.fn(async () => true);
    const outcome = await requestJobCancel("p-2", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      confirmGlobalInterrupt: confirm,
    });
    expect(confirm).toHaveBeenCalledWith("0.3.40");
    expect(outcome).toBe("cancelled");
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
      prompt_id: "p-2",
      confirm_global: true,
    });
  });

  it("does nothing when the global interrupt is declined", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, action: "confirm-global-interrupt" }),
    );
    const outcome = await requestJobCancel("p-3", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      confirmGlobalInterrupt: async () => false,
    });
    expect(outcome).toBe("declined");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports not-found and throws the route's error", async () => {
    await expect(
      requestJobCancel("p-4", {
        fetchImpl: (async () =>
          jsonResponse({
            ok: true,
            action: "not-found",
          })) as unknown as typeof fetch,
        confirmGlobalInterrupt: async () => true,
      }),
    ).resolves.toBe("not-found");
    await expect(
      requestJobCancel("p-5", {
        fetchImpl: (async () =>
          jsonResponse(
            { ok: false, error: "ComfyUI unreachable" },
            503,
          )) as unknown as typeof fetch,
        confirmGlobalInterrupt: async () => true,
      }),
    ).rejects.toThrow("ComfyUI unreachable");
  });
});

describe("retryPromptRun", () => {
  const ui: RetryWorkflowState = {
    actionWorkflowMap: {},
    selectedWorkflowPath: "flux/t2i.json",
    selectedWorkflowName: "Flux",
    defaultWorkflowPath: null,
    defaultWorkflowName: null,
    workflowControlOverrides: {},
  };

  it("re-posts the prompt to /api/jobs/imagine without attachments", async () => {
    const newRun = run("again");
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, runs: [newRun] }),
    );
    const runs = await retryPromptRun(" a cat --ar 3:2 ", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clientId: "tab-1",
      ui,
    });
    expect(runs).toEqual([newRun]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/jobs/imagine");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      prompt: "a cat --ar 3:2",
      client_id: "tab-1",
      batch_size: 1,
      workflow_path: "flux/t2i.json",
    });
  });

  it("lets the server route dedicated flags and surfaces errors", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error: "Bad prompt" }, 400),
    );
    await expect(
      retryPromptRun("a clip --video", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        clientId: "tab-1",
        ui,
      }),
    ).rejects.toThrow("Bad prompt");
    const body = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(body.workflow_path).toBeUndefined();
    await expect(
      retryPromptRun("   ", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        clientId: "x",
        ui,
      }),
    ).rejects.toThrow(/no prompt/);
  });
});

describe("queue drawer wiring", () => {
  const src = (p: string) =>
    readFileSync(path.join(__dirname, "..", p), "utf8");

  it("traps focus and closes on Escape", () => {
    const drawer = src("components/QueueDrawer.tsx");
    expect(drawer).toMatch(
      /useDialogFocus\(panelRef, true, \{ onEscape: close \}\)/,
    );
    expect(drawer).toContain('aria-modal="true"');
    // Cancel goes through the shared helper, then marks the job cancelled.
    expect(drawer).toMatch(/outcome === "cancelled"\) cancelJob\(promptId\)/);
  });

  it("opens from the sidebar badge and the mobile menu", () => {
    expect(src("components/Sidebar.tsx")).toContain(
      "onClick={toggleQueueDrawer}",
    );
    expect(src("components/Sidebar.tsx")).toContain("<QueueDrawer />");
    expect(src("components/MobileBottomNav.tsx")).toContain(
      "openQueueDrawer(true)",
    );
  });
});
