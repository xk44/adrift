/**
 * useComfyWS lifecycle contract regression checks.
 *
 * The vitest harness runs in a node environment without jsdom or a WebSocket
 * mock, so these are intentionally source-level checks (same idiom as the
 * other *Contracts tests) guarding two confirmed lifecycle bugs:
 *
 * Bug A (StrictMode kill): connect() must cancel any pending deferred close
 * (closeTimeout; a mid-handshake release is handled by the shared socket
 * pool) and reset isIntentionalClose BEFORE the
 * "socket already OPEN/CONNECTING" early return. Otherwise, under StrictMode
 * mount → cleanup → mount, the second mount's connect() early-returns while
 * the first cleanup's deferred closeNow is still armed and the live socket is
 * reaped 100ms after opening with no reconnect scheduled.
 *
 * Bug B (infinite fast reconnect): onopen must NOT reset the reconnect
 * attempt counter directly. A server that accepts the handshake then drops
 * immediately (e.g. origin validation) would loop forever at minimum backoff.
 * The counter may only reset after the connection survives a stability
 * window, and the stability timer must be cleared on close and on disconnect.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(process.cwd(), "src/hooks/useComfyWS.ts"),
  "utf8",
);

/** Extract the text between two markers (throws via expect if missing). */
function between(start: string, end: string): string {
  const startIdx = source.indexOf(start);
  const endIdx = source.indexOf(end, startIdx);
  expect(startIdx, `marker not found: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIdx, `marker not found: ${end}`).toBeGreaterThan(startIdx);
  return source.slice(startIdx, endIdx);
}

describe("useComfyWS connect() vs stale deferred close (Bug A)", () => {
  const connectBody = between(
    "const connect = useCallback(",
    "const closeNow = useCallback(",
  );

  it("keeps the OPEN/CONNECTING early-return guard in connect()", () => {
    expect(connectBody).toContain("WebSocket.OPEN");
    expect(connectBody).toContain("WebSocket.CONNECTING");
    expect(connectBody).toContain("return;");
  });

  it("cancels the pending deferred close BEFORE the early-return guard", () => {
    const guardIdx = connectBody.indexOf("WebSocket.OPEN");
    const clearCloseTimeoutIdx = connectBody.indexOf(
      "clearTimeout(closeTimeout.current)",
    );
    const resetIntentionalIdx = connectBody.indexOf(
      "isIntentionalClose.current = false",
    );

    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(clearCloseTimeoutIdx).toBeGreaterThanOrEqual(0);
    expect(resetIntentionalIdx).toBeGreaterThanOrEqual(0);

    // Both resets must happen before the guard can early-return,
    // so a live socket is never reaped by a stale deferred close.
    expect(clearCloseTimeoutIdx).toBeLessThan(guardIdx);
    expect(resetIntentionalIdx).toBeLessThan(guardIdx);
  });
});

describe("useComfyWS reconnect backoff stability window (Bug B)", () => {
  const onOpenBody = between("ws.onopen", "ws.onclose");
  const onCloseBody = between("ws.onclose", "ws.onerror");
  const disconnectBody = between(
    "const disconnect = useCallback(",
    "const reconnect = useCallback(",
  );

  it("defines a stability window of roughly 10 seconds", () => {
    const match = source.match(/const STABLE_CONNECTION_MS = (\d+)/);
    expect(match).not.toBeNull();
    const ms = Number(match![1]);
    expect(ms).toBeGreaterThanOrEqual(5000);
    expect(ms).toBeLessThanOrEqual(30000);
  });

  it("only resets the attempt counter via the stability timer in onopen", () => {
    const resets = onOpenBody.match(/reconnectAttempts\.current = 0/g) ?? [];
    expect(resets).toHaveLength(1);

    const timerIdx = onOpenBody.indexOf(
      "stabilityTimeout.current = setTimeout",
    );
    const resetIdx = onOpenBody.indexOf("reconnectAttempts.current = 0");
    expect(timerIdx).toBeGreaterThanOrEqual(0);
    // The reset lives inside the stability timer callback, not in the
    // synchronous onopen path.
    expect(resetIdx).toBeGreaterThan(timerIdx);
    expect(onOpenBody).toContain("STABLE_CONNECTION_MS");
  });

  it("clears the stability timer when the socket closes", () => {
    expect(onCloseBody).toContain("clearTimeout(stabilityTimeout.current)");
    expect(onCloseBody).toContain("stabilityTimeout.current = null");
    // And the counter is never reset on close — backoff must keep growing
    // across rapid open/close cycles.
    expect(onCloseBody).not.toContain("reconnectAttempts.current = 0");
  });

  it("clears the stability timer on intentional disconnect", () => {
    expect(disconnectBody).toContain("clearTimeout(stabilityTimeout.current)");
    expect(disconnectBody).toContain("stabilityTimeout.current = null");
  });
});

type SimJobStatus = "queued" | "running" | "done" | "error";

interface SimJob {
  status: SimJobStatus;
  progress: number;
  currentNode?: string;
  completedNodes: number;
}

interface SimState {
  job: SimJob;
  cachedNodes: Set<string>;
  totalNodes: number;
}

function calculateProgress(state: SimState, currentNodeFraction = 0): number {
  const completedNodeUnits = Math.min(
    state.totalNodes,
    state.cachedNodes.size + state.job.completedNodes + currentNodeFraction,
  );

  return Math.round((completedNodeUnits / state.totalNodes) * 100);
}

function setSimJobStatus(
  state: SimState,
  status: SimJobStatus,
  progress?: number,
  currentNode?: string | null,
) {
  const prevNode = state.job.currentNode;
  const nextNode =
    currentNode === null ? undefined : (currentNode ?? state.job.currentNode);
  const completedNodes =
    currentNode === null
      ? state.job.completedNodes
      : currentNode !== undefined &&
          currentNode !== prevNode &&
          prevNode !== undefined
        ? state.job.completedNodes + 1
        : state.job.completedNodes;

  state.job = {
    ...state.job,
    status,
    progress: progress ?? state.job.progress,
    currentNode: nextNode,
    completedNodes,
  };
}

function simulateMessage(
  state: SimState,
  msg:
    | { type: "execution_start" }
    | { type: "execution_cached"; nodes: string[] }
    | { type: "executing"; node: string | null }
    | { type: "progress"; value: number; max: number }
    | { type: "execution_success" }
    | { type: "execution_error" },
) {
  switch (msg.type) {
    case "execution_start":
      state.cachedNodes.clear();
      setSimJobStatus(state, "running", 0);
      break;
    case "execution_cached":
      for (const node of msg.nodes) state.cachedNodes.add(node);
      setSimJobStatus(state, "running", calculateProgress(state));
      break;
    case "executing":
      setSimJobStatus(
        state,
        msg.node === null ? "done" : "running",
        msg.node === null ? 100 : calculateProgress(state),
        msg.node,
      );
      if (msg.node === null) state.cachedNodes.clear();
      break;
    case "progress":
      setSimJobStatus(
        state,
        "running",
        calculateProgress(state, msg.max > 0 ? msg.value / msg.max : 0),
      );
      break;
    case "execution_success":
      state.cachedNodes.clear();
      setSimJobStatus(state, "done", 100, null);
      break;
    case "execution_error":
      state.cachedNodes.clear();
      setSimJobStatus(state, "error");
      break;
  }
}

describe("useComfyWS execution_cached lifecycle contract", () => {
  const cachedBlock = between(
    'case "execution_cached":',
    'case "execution_error":',
  );
  const successBlock = between(
    'case "execution_success":',
    "default:",
  );

  it("does not treat execution_cached as a terminal event in source", () => {
    expect(cachedBlock).toContain('"running"');
    expect(cachedBlock).toContain("calculateNodeProgress");
    expect(cachedBlock).not.toContain('"done"');
    expect(cachedBlock).not.toContain("fetchCompletedImages");
  });

  it("marks execution_success as terminal in source", () => {
    expect(successBlock).toContain('"done"');
    expect(successBlock).toContain("fetchCompletedImages");
    expect(successBlock).toContain("setCurrentPromptId(null)");
  });

  it("keeps a cached-plus-uncached prompt running until execution_success", () => {
    const state: SimState = {
      job: { status: "queued", progress: 0, completedNodes: 0 },
      cachedNodes: new Set(),
      totalNodes: 4,
    };

    simulateMessage(state, { type: "execution_start" });
    simulateMessage(state, { type: "execution_cached", nodes: ["1", "2"] });
    expect(state.job.status).toBe("running");
    expect(state.job.progress).toBe(50);

    simulateMessage(state, { type: "executing", node: "3" });
    expect(state.job.status).toBe("running");
    expect(state.job.progress).toBe(50);

    simulateMessage(state, { type: "progress", value: 5, max: 10 });
    expect(state.job.status).toBe("running");
    expect(state.job.progress).toBe(63);

    simulateMessage(state, { type: "executing", node: "4" });
    simulateMessage(state, { type: "progress", value: 0, max: 10 });
    expect(state.job.status).toBe("running");
    expect(state.job.progress).toBe(75);

    simulateMessage(state, { type: "execution_success" });
    expect(state.job.status).toBe("done");
    expect(state.job.progress).toBe(100);
  });

  it("keeps a cached prompt running until execution_error and then errors", () => {
    const state: SimState = {
      job: { status: "queued", progress: 0, completedNodes: 0 },
      cachedNodes: new Set(),
      totalNodes: 4,
    };

    simulateMessage(state, { type: "execution_start" });
    simulateMessage(state, { type: "execution_cached", nodes: ["1", "2"] });
    simulateMessage(state, { type: "executing", node: "3" });
    expect(state.job.status).toBe("running");
    expect(state.job.progress).toBe(50);

    simulateMessage(state, { type: "execution_error" });
    expect(state.job.status).toBe("error");
    expect(state.job.progress).toBe(50);
  });
});

describe("useComfyWS HTTP fallback polling contract", () => {
  const pollBody = between(
    "const pollJobStatus = useCallback(async (",
    "  /**\n   * Handle incoming WebSocket message",
  );

  it("terminalizes completed history records even when no output files are present", () => {
    expect(pollBody).toContain("status?.completed === true");
    expect(pollBody).toContain('setJobStatus(job.prompt_id, "done", 100');
  });

  it("terminalizes errored history records instead of polling forever", () => {
    expect(pollBody).toContain("status?.status_str");
    expect(pollBody).toContain('statusStr === "error"');
    expect(pollBody).toContain("setJobError(job.prompt_id, error)");
  });
});
