import { describe, expect, it } from "vitest";
import {
  LOST_JOB_MESSAGE,
  MISSING_CONFIRM_CHECKS,
  MISSING_CONFIRM_MS,
  classifyHistory,
  classifyPrompt,
  deriveRunStatus,
  reconcileAction,
} from "@/lib/comfy/promptReconcile";
import type { JobStatus } from "@/types";

const graph = { "7": { class_type: "KSampler", _meta: { title: "Sampler" } } };

describe("classifyHistory", () => {
  it("success → done", () => {
    expect(
      classifyHistory({ status: { status_str: "success", completed: true } }),
    ).toEqual({ state: "done" });
  });
  it("execution_error → error with node title and exception", () => {
    const r = classifyHistory({
      prompt: [1, "p", graph, {}],
      status: {
        status_str: "error",
        completed: false,
        messages: [
          ["execution_start", {}],
          [
            "execution_error",
            {
              node_id: "7",
              node_type: "KSampler",
              exception_message: "Allocation on device",
              exception_type: "torch.OutOfMemoryError",
            },
          ],
        ],
      },
    });
    expect(r.state).toBe("error");
    expect(r.error).toContain("Sampler");
    expect(r.error).toContain("Allocation on device");
  });
  it("execution_interrupted → cancelled", () => {
    expect(
      classifyHistory({
        status: {
          status_str: "error",
          messages: [["execution_interrupted", { node_id: "7" }]],
        },
      }).state,
    ).toBe("cancelled");
  });
  it("error status without messages still fails", () => {
    expect(classifyHistory({ status: { status_str: "error" } }).state).toBe(
      "error",
    );
  });
});

describe("classifyPrompt", () => {
  const queue = { running: new Set(["r"]), pending: new Set(["q"]) };
  it("queue wins over history", () => {
    expect(classifyPrompt("r", queue, null).state).toBe("running");
    expect(classifyPrompt("q", queue, null).state).toBe("queued");
  });
  it("missing only when every queue was readable", () => {
    expect(classifyPrompt("x", queue, null).state).toBe("missing");
    expect(classifyPrompt("x", null, null).state).toBe("unknown");
    expect(classifyPrompt("x", null, { status: { completed: true } }).state).toBe(
      "done",
    );
  });
});

describe("deriveRunStatus", () => {
  const s = (...st: JobStatus[]) => st.map((status) => ({ status }));
  it("active jobs keep the run active", () => {
    expect(deriveRunStatus(s("done", "running"), "queued")).toBe("running");
    expect(deriveRunStatus(s("error", "queued"), "queued")).toBe("queued");
  });
  it("a finished mix always resolves (never stays running)", () => {
    expect(deriveRunStatus(s("done", "cancelled"), "running")).toBe("done");
    expect(deriveRunStatus(s("done", "error"), "running")).toBe("error");
    expect(deriveRunStatus(s("cancelled", "cancelled"), "running")).toBe(
      "cancelled",
    );
    expect(deriveRunStatus(s("done"), "running")).toBe("done");
  });
});

describe("reconcileAction", () => {
  const queued = { status: "queued" as const };
  const running = { status: "running" as const };
  it("ignores finished jobs", () => {
    expect(
      reconcileAction({ status: "done" }, { state: "error" }, undefined, 0).kind,
    ).toBe("none");
  });
  it("maps states to actions", () => {
    expect(reconcileAction(queued, { state: "running" }, undefined, 0)).toEqual({
      kind: "running",
    });
    expect(reconcileAction(running, { state: "running" }, undefined, 0).kind).toBe(
      "none",
    );
    expect(reconcileAction(running, { state: "done" }, undefined, 0).kind).toBe(
      "fetch",
    );
    expect(
      reconcileAction(running, { state: "error", error: "boom" }, undefined, 0),
    ).toEqual({ kind: "error", message: "boom" });
    expect(reconcileAction(queued, { state: "cancelled" }, undefined, 0).kind).toBe(
      "cancel",
    );
    expect(reconcileAction(queued, { state: "unknown" }, undefined, 0).kind).toBe(
      "none",
    );
  });
  it("drops a missing prompt only after enough checks and time", () => {
    const since = 1_000;
    const late = since + MISSING_CONFIRM_MS;
    expect(
      reconcileAction(queued, { state: "missing" }, { since, count: 1 }, late).kind,
    ).toBe("none");
    expect(
      reconcileAction(
        queued,
        { state: "missing" },
        { since, count: MISSING_CONFIRM_CHECKS },
        late - 1,
      ).kind,
    ).toBe("none");
    expect(
      reconcileAction(
        queued,
        { state: "missing" },
        { since, count: MISSING_CONFIRM_CHECKS },
        late,
      ),
    ).toEqual({ kind: "error", message: LOST_JOB_MESSAGE });
  });
});
