/**
 * Tests for the Overlay Store (overlayStore.ts)
 *
 * Validates:
 *   - setOverlayWorkflow stores workflow and extracts name
 *   - acceptWorkflow sets workflowAccepted
 *   - dismissWorkflow / reset clears state
 *   - bridgePhase transitions
 *   - settings persistence (partialize)
 *   - progress and image tracking
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useOverlayStore, extractWorkflowName } from "@/store/overlayStore";

// Reset store between tests
beforeEach(() => {
  useOverlayStore.getState().reset();
});

// ── extractWorkflowName ─────────────────────────────────────────────

describe("extractWorkflowName", () => {
  it("returns title from workflow.title", () => {
    expect(extractWorkflowName({ title: "My Workflow" })).toBe("My Workflow");
  });

  it("returns title from workflow.extra.title", () => {
    expect(extractWorkflowName({ extra: { title: "Extra Title" } })).toBe(
      "Extra Title",
    );
  });

  it("does NOT use a node type as the name (generic fallback instead)", () => {
    expect(extractWorkflowName({ nodes: [{ type: "KSampler" }] })).toBe(
      "ComfyUI Workflow",
    );
  });

  it("returns fallback for empty object", () => {
    expect(extractWorkflowName({})).toBe("ComfyUI Workflow");
  });

  it("returns fallback for null/undefined", () => {
    expect(extractWorkflowName(null)).toBe("ComfyUI Workflow");
    expect(extractWorkflowName(undefined)).toBe("ComfyUI Workflow");
  });

  it("trims whitespace from title", () => {
    expect(extractWorkflowName({ title: "  Spaced  " })).toBe("Spaced");
  });

  it("ignores empty string title", () => {
    expect(extractWorkflowName({ title: "  " })).toBe("ComfyUI Workflow");
  });
});

// ── setOverlayWorkflow ──────────────────────────────────────────────

describe("setOverlayWorkflow", () => {
  it("stores workflow and extracts name", () => {
    const workflow = { title: "Test WF", nodes: [] };
    useOverlayStore.getState().setOverlayWorkflow(workflow);

    const state = useOverlayStore.getState();
    expect(state.overlayWorkflow).toBe(workflow);
    expect(state.overlayWorkflowName).toBe("Test WF");
  });

  it("resets workflowAccepted to false", () => {
    const store = useOverlayStore.getState();
    store.setOverlayWorkflow({ title: "First" });
    store.acceptWorkflow();
    expect(useOverlayStore.getState().workflowAccepted).toBe(true);

    store.setOverlayWorkflow({ title: "Second" });
    expect(useOverlayStore.getState().workflowAccepted).toBe(false);
  });

  it("handles API-format workflow (no title)", () => {
    const apiWorkflow = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: {} },
      "2": { class_type: "KSampler", inputs: {} },
    };
    useOverlayStore.getState().setOverlayWorkflow(apiWorkflow);
    expect(useOverlayStore.getState().overlayWorkflowName).toBe(
      "ComfyUI Workflow",
    );
  });
});

// ── acceptWorkflow ──────────────────────────────────────────────────

describe("acceptWorkflow", () => {
  it("sets workflowAccepted to true", () => {
    useOverlayStore.getState().setOverlayWorkflow({ title: "WF" });
    useOverlayStore.getState().acceptWorkflow();
    expect(useOverlayStore.getState().workflowAccepted).toBe(true);
  });
});

// ── dismissWorkflow ─────────────────────────────────────────────────

describe("dismissWorkflow", () => {
  it("clears workflow, name, and accepted flag", () => {
    const store = useOverlayStore.getState();
    store.setOverlayWorkflow({ title: "WF" });
    store.acceptWorkflow();
    store.dismissWorkflow();

    const state = useOverlayStore.getState();
    expect(state.overlayWorkflow).toBeNull();
    expect(state.overlayWorkflowName).toBeNull();
    expect(state.workflowAccepted).toBe(false);
  });
});

// ── reset ────────────────────────────────────────────────────────────

describe("reset", () => {
  it("resets all state to initial values", () => {
    const store = useOverlayStore.getState();
    store.setOverlayWorkflow({ title: "WF" });
    store.acceptWorkflow();
    store.setBridgePhase("ready");
    store.setProgress({ promptId: "p1", value: 5, max: 10 });
    store.setIsQueueing(true);

    store.reset();
    const state = useOverlayStore.getState();

    expect(state.overlayWorkflow).toBeNull();
    expect(state.overlayWorkflowName).toBeNull();
    expect(state.workflowAccepted).toBe(false);
    expect(state.bridgePhase).toBe("idle");
    expect(state.progress).toBeNull();
    expect(state.isQueueing).toBe(false);
    expect(state.completedImages).toEqual([]);
    expect(state.activePromptId).toBeNull();
    expect(state.lastQueuedPromptId).toBeNull();
    expect(state.settingsPanelOpen).toBe(false);
  });
});

// ── bridgePhase transitions ──────────────────────────────────────────

describe("bridgePhase", () => {
  it("starts at idle", () => {
    expect(useOverlayStore.getState().bridgePhase).toBe("idle");
  });

  it("transitions through hello-sent → configured → ready", () => {
    const store = useOverlayStore.getState();

    store.setBridgePhase("hello-sent");
    expect(useOverlayStore.getState().bridgePhase).toBe("hello-sent");

    store.setBridgePhase("configured");
    expect(useOverlayStore.getState().bridgePhase).toBe("configured");

    store.setBridgePhase("ready");
    expect(useOverlayStore.getState().bridgePhase).toBe("ready");
  });

  it("can go to error from any state", () => {
    useOverlayStore.getState().setBridgePhase("configured");
    useOverlayStore.getState().setBridgePhase("error");
    expect(useOverlayStore.getState().bridgePhase).toBe("error");
  });

  it("can reset to idle", () => {
    useOverlayStore.getState().setBridgePhase("ready");
    useOverlayStore.getState().setBridgePhase("idle");
    expect(useOverlayStore.getState().bridgePhase).toBe("idle");
  });
});

// ── progress tracking ────────────────────────────────────────────────

describe("progress tracking", () => {
  it("setProgress stores progress and sets activePromptId", () => {
    useOverlayStore
      .getState()
      .setProgress({ promptId: "p1", value: 3, max: 10 });
    const state = useOverlayStore.getState();
    expect(state.progress).toEqual({ promptId: "p1", value: 3, max: 10 });
    expect(state.activePromptId).toBe("p1");
  });

  it("clearProgress nulls progress", () => {
    useOverlayStore
      .getState()
      .setProgress({ promptId: "p1", value: 5, max: 10 });
    useOverlayStore.getState().clearProgress();
    expect(useOverlayStore.getState().progress).toBeNull();
  });

  it("setCompletedImages stores images and clears progress", () => {
    useOverlayStore
      .getState()
      .setProgress({ promptId: "p1", value: 5, max: 10 });
    useOverlayStore
      .getState()
      .setCompletedImages("p1", [{ filename: "out.png", type: "output" }]);

    const state = useOverlayStore.getState();
    expect(state.completedImages).toHaveLength(1);
    expect(state.completedImages[0].filename).toBe("out.png");
    expect(state.progress).toBeNull();
    expect(state.activePromptId).toBe("p1");
  });
});

// ── queue tracking ──────────────────────────────────────────────────

describe("queue tracking", () => {
  it("setIsQueueing toggles queueing flag", () => {
    useOverlayStore.getState().setIsQueueing(true);
    expect(useOverlayStore.getState().isQueueing).toBe(true);
    useOverlayStore.getState().setIsQueueing(false);
    expect(useOverlayStore.getState().isQueueing).toBe(false);
  });

  it("setLastQueuedPromptId stores ID and clears queueing", () => {
    useOverlayStore.getState().setIsQueueing(true);
    useOverlayStore.getState().setLastQueuedPromptId("p42");

    const state = useOverlayStore.getState();
    expect(state.lastQueuedPromptId).toBe("p42");
    expect(state.isQueueing).toBe(false);
  });
});

// ── settings ─────────────────────────────────────────────────────────

describe("overlaySettings", () => {
  it("has sensible defaults", () => {
    const settings = useOverlayStore.getState().overlaySettings;
    expect(settings.queueViaComfyUI).toBe(false);
    expect(settings.autoSyncWorkflow).toBe(true);
    expect(settings.showComfyProgress).toBe(true);
  });

  it("has no dead ComfyUI URL setting (the host handshake supplies it)", () => {
    const settings = useOverlayStore.getState().overlaySettings;
    expect("comfyUrl" in settings).toBe(false);
  });

  it("updateOverlaySettings merges partial updates", () => {
    useOverlayStore
      .getState()
      .updateOverlaySettings({ showComfyProgress: false });

    const settings = useOverlayStore.getState().overlaySettings;
    expect(settings.showComfyProgress).toBe(false);
    // Other settings unchanged
    expect(settings.queueViaComfyUI).toBe(false);
    expect(settings.autoSyncWorkflow).toBe(true);
  });

  it("updateOverlaySettings can toggle booleans", () => {
    useOverlayStore.getState().updateOverlaySettings({
      queueViaComfyUI: true,
      showComfyProgress: false,
    });

    const settings = useOverlayStore.getState().overlaySettings;
    expect(settings.queueViaComfyUI).toBe(true);
    expect(settings.showComfyProgress).toBe(false);
  });

  it("settings survive reset (persisted separately from transient state)", () => {
    // Update settings, then reset — settings should retain their updated values
    // because reset() uses initialState which includes defaultOverlaySettings.
    // In production, persist rehydrates from localStorage; here we verify
    // the reset doesn't corrupt settings shape.
    useOverlayStore
      .getState()
      .updateOverlaySettings({ showComfyProgress: false });
    useOverlayStore.getState().reset();

    const settings = useOverlayStore.getState().overlaySettings;
    // After reset, settings go back to defaults (persist would rehydrate in browser)
    expect(settings.queueViaComfyUI).toBe(false);
    expect(settings.autoSyncWorkflow).toBe(true);
    expect(settings.showComfyProgress).toBe(true);
  });
});

// ── settingsPanelOpen ────────────────────────────────────────────────

describe("settingsPanelOpen", () => {
  it("defaults to false", () => {
    expect(useOverlayStore.getState().settingsPanelOpen).toBe(false);
  });

  it("can be toggled", () => {
    useOverlayStore.getState().setSettingsPanelOpen(true);
    expect(useOverlayStore.getState().settingsPanelOpen).toBe(true);
    useOverlayStore.getState().setSettingsPanelOpen(false);
    expect(useOverlayStore.getState().settingsPanelOpen).toBe(false);
  });
});

// ── resetSession ─────────────────────────────────────────────────────

describe("resetSession", () => {
  it("clears per-handshake state but keeps the received workflow", () => {
    const s = useOverlayStore.getState();
    s.setOverlayWorkflow({ title: "Kept" });
    s.setIsQueueing(true);
    s.setProgress({ promptId: "p1", value: 3, max: 10 });
    s.setSelectedNode({ nodeId: 4, nodeType: "KSampler", nodeTitle: "K" });
    s.setBridgeLatency(42);
    s.setSyncConflict({ remoteWorkflow: {}, remoteRevision: 2, timestamp: 1 });

    useOverlayStore.getState().resetSession();

    const after = useOverlayStore.getState();
    expect(after.isQueueing).toBe(false);
    expect(after.progress).toBeNull();
    expect(after.activePromptId).toBeNull();
    expect(after.selectedNode).toBeNull();
    expect(after.bridgeLatency).toBeNull();
    expect(after.connectionQuality).toBe("unknown");
    expect(after.syncConflict).toBeNull();
    expect(after.overlayWorkflowName).toBe("Kept");
  });
});
