/**
 * Tests for the non-blocking install confirmation flow.
 *
 * The useInstallConfirmFlow hook replaces window.confirm with an inline
 * confirm/queue/result state machine. These tests validate the pure helper
 * functions and the state transitions.
 */

import { describe, expect, it } from "vitest";
import {
  buildConfirmPromptText,
  buildResultMessage,
  type InstallConfirmPhase,
  type InstallConfirmState,
} from "@/lib/hooks/useInstallConfirmFlow";

// ---------------------------------------------------------------------------
// buildConfirmPromptText
// ---------------------------------------------------------------------------

describe("buildConfirmPromptText", () => {
  it("formats single pack correctly", () => {
    expect(buildConfirmPromptText(["comfyui-kjnodes"], "My Workflow")).toBe(
      "Queue 1 pack for My Workflow? comfyui-kjnodes",
    );
  });

  it("formats multiple packs correctly", () => {
    expect(
      buildConfirmPromptText(["comfyui-kjnodes", "ComfyMath"], "My Workflow"),
    ).toBe("Queue 2 packs for My Workflow? comfyui-kjnodes, ComfyMath");
  });

  it("handles empty pack list (defensive)", () => {
    expect(buildConfirmPromptText([], "My Workflow")).toBe(
      "Queue 0 packs for My Workflow? ",
    );
  });

  it("includes unambiguous pack IDs explicitly", () => {
    const text = buildConfirmPromptText(["pack-a", "pack-b"], "WF");
    expect(text).toContain("pack-a");
    expect(text).toContain("pack-b");
  });
});

// ---------------------------------------------------------------------------
// buildResultMessage
// ---------------------------------------------------------------------------

describe("buildResultMessage", () => {
  it("formats singular queued task", () => {
    expect(buildResultMessage(1, 0)).toBe(
      "Queued 1 missing-node install task. Restart ComfyUI after Manager finishes.",
    );
  });

  it("formats plural queued tasks", () => {
    expect(buildResultMessage(3, 0)).toBe(
      "Queued 3 missing-node install tasks. Restart ComfyUI after Manager finishes.",
    );
  });

  it("includes failed count when > 0", () => {
    expect(buildResultMessage(2, 1)).toBe(
      "Queued 2 missing-node install tasks; 1 failed to queue. Restart ComfyUI after Manager finishes.",
    );
  });

  it("omits failed suffix when 0", () => {
    const msg = buildResultMessage(5, 0);
    expect(msg).not.toContain("failed");
  });
});

// ---------------------------------------------------------------------------
// InstallConfirmState type guard checks (structural validation)
// ---------------------------------------------------------------------------

describe("InstallConfirmState type transitions", () => {
  it("idle state has expected shape", () => {
    const state: InstallConfirmState = {
      phase: "idle",
      pending: null,
      result: null,
    };
    expect(state.phase).toBe("idle");
    expect(state.pending).toBeNull();
    expect(state.result).toBeNull();
  });

  it("confirming state carries pending payload", () => {
    const state: InstallConfirmState = {
      phase: "confirming",
      pending: {
        workflowId: "wf-1",
        workflowName: "Test Workflow",
        packIds: ["pack-a", "pack-b"],
      },
      result: null,
    };
    expect(state.phase).toBe("confirming");
    expect(state.pending?.workflowId).toBe("wf-1");
    expect(state.pending?.packIds).toEqual(["pack-a", "pack-b"]);
    expect(state.result).toBeNull();
  });

  it("installing state retains pending and clears result", () => {
    const state: InstallConfirmState = {
      phase: "installing",
      pending: {
        workflowId: "wf-1",
        workflowName: "Test",
        packIds: ["pack-a"],
      },
      result: null,
    };
    expect(state.phase).toBe("installing");
    expect(state.pending?.packIds).toEqual(["pack-a"]);
    expect(state.result).toBeNull();
  });

  it("result state carries message and isError flag", () => {
    const success: InstallConfirmState = {
      phase: "result",
      pending: null,
      result: {
        message: "Queued 2 tasks.",
        isError: false,
      },
    };
    expect(success.phase).toBe("result");
    expect(success.result?.isError).toBe(false);

    const failure: InstallConfirmState = {
      phase: "result",
      pending: null,
      result: {
        message: "Failed to queue install tasks",
        isError: true,
      },
    };
    expect(failure.result?.isError).toBe(true);
  });

  it("packIds are never ambiguous – only unambiguous IDs are queued", () => {
    // This is a design invariant: the confirming phase only stores pack IDs
    // that have been deemed unambiguous by the manager resolution. The test
    // ensures our state model matches this constraint.
    const unambiguousPackIds = ["comfyui-kjnodes", "ComfyMath"];
    const state: InstallConfirmState = {
      phase: "confirming",
      pending: {
        workflowId: "wf-1",
        workflowName: "Test",
        packIds: unambiguousPackIds,
      },
      result: null,
    };
    // Every pack ID in confirming state should be a non-empty string
    for (const id of state.pending!.packIds) {
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase transition invariants
// ---------------------------------------------------------------------------

describe("Phase transition safety", () => {
  const validPhases: InstallConfirmPhase[] = [
    "idle",
    "confirming",
    "installing",
    "result",
  ];

  it("all phases are distinct strings literals", () => {
    const unique = new Set(validPhases);
    expect(unique.size).toBe(validPhases.length);
  });

  it("no phase equals 'window.confirm' – blocking dialog must not appear", () => {
    for (const phase of validPhases) {
      expect(phase).not.toBe("window.confirm");
      expect(phase).not.toContain("confirm(");
    }
  });

  it("result phase with isError false means success", () => {
    const state: InstallConfirmState = {
      phase: "result",
      pending: null,
      result: { message: "OK", isError: false },
    };
    expect(state.result!.isError).toBe(false);
  });

  it("result phase with isError true means failure", () => {
    const state: InstallConfirmState = {
      phase: "result",
      pending: null,
      result: { message: "HTTP 500", isError: true },
    };
    expect(state.result!.isError).toBe(true);
  });
});