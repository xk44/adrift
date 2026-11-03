/**
 * Editor store undo/redo and cleanup tests
 * Covers: undo/redo, history cap at 50, closeEditor cleanup
 *
 * Run with: npx vitest run src/__tests__/editorStoreUndoRedo.test.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  useEditorStore,
  selectCanUndo,
  selectCanRedo,
} from "@/store/editorStore";

// Reset store before each test
beforeEach(() => {
  useEditorStore.getState().resetEditor();
});

describe("editorStore undo/redo", () => {
  it("undo does nothing when history is empty", () => {
    const store = useEditorStore.getState();
    store.undo();
    expect(store.historyIndex).toBe(-1);
  });

  it("redo does nothing when at end of history", () => {
    const store = useEditorStore.getState();
    store.redo();
    expect(store.historyIndex).toBe(-1);
  });

  it("saveToHistory creates a history entry", () => {
    const store = useEditorStore.getState();
    store.openEditor("http://example.com/img.png");
    useEditorStore.getState().saveToHistory();
    const state = useEditorStore.getState();
    expect(state.history.length).toBe(1);
    expect(state.historyIndex).toBe(0);
  });

  it("undo restores previous layer state", () => {
    const store = useEditorStore.getState();
    store.openEditor("http://example.com/img.png");

    // Save initial state
    useEditorStore.getState().saveToHistory();

    // Modify layers
    useEditorStore.getState().addLayer({ name: "Layer 2", type: "mask" });

    // Save modified state
    useEditorStore.getState().saveToHistory();

    const beforeUndo = useEditorStore.getState();
    expect(beforeUndo.layers.length).toBe(2);
    expect(beforeUndo.historyIndex).toBe(1);

    // Undo
    useEditorStore.getState().undo();

    const afterUndo = useEditorStore.getState();
    expect(afterUndo.layers.length).toBe(1);
    expect(afterUndo.historyIndex).toBe(0);
  });

  it("redo restores next layer state", () => {
    const store = useEditorStore.getState();
    store.openEditor("http://example.com/img.png");
    useEditorStore.getState().saveToHistory();

    useEditorStore.getState().addLayer({ name: "Layer 2" });
    useEditorStore.getState().saveToHistory();

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().layers.length).toBe(1);

    useEditorStore.getState().redo();
    expect(useEditorStore.getState().layers.length).toBe(2);
    expect(useEditorStore.getState().historyIndex).toBe(1);
  });

  it("new save after undo truncates redo history", () => {
    const store = useEditorStore.getState();
    store.openEditor("http://example.com/img.png");

    useEditorStore.getState().saveToHistory(); // index 0
    useEditorStore.getState().addLayer({ name: "L2" });
    useEditorStore.getState().saveToHistory(); // index 1
    useEditorStore.getState().addLayer({ name: "L3" });
    useEditorStore.getState().saveToHistory(); // index 2

    // Undo twice
    useEditorStore.getState().undo(); // index 1
    useEditorStore.getState().undo(); // index 0

    // New save should truncate indices 1 and 2
    useEditorStore.getState().addLayer({ name: "L-new" });
    useEditorStore.getState().saveToHistory();

    const state = useEditorStore.getState();
    expect(state.history.length).toBe(2); // original + new
    expect(state.historyIndex).toBe(1);
  });

  it("selectCanUndo and selectCanRedo reflect state correctly", () => {
    const store = useEditorStore.getState();
    store.openEditor("http://example.com/img.png");

    expect(selectCanUndo(useEditorStore.getState())).toBe(false);
    expect(selectCanRedo(useEditorStore.getState())).toBe(false);

    useEditorStore.getState().saveToHistory();
    useEditorStore.getState().addLayer({ name: "L2" });
    useEditorStore.getState().saveToHistory();

    expect(selectCanUndo(useEditorStore.getState())).toBe(true);
    expect(selectCanRedo(useEditorStore.getState())).toBe(false);

    useEditorStore.getState().undo();
    expect(selectCanUndo(useEditorStore.getState())).toBe(false);
    expect(selectCanRedo(useEditorStore.getState())).toBe(true);
  });
});

describe("editorStore history cap", () => {
  it("caps history at 50 entries", () => {
    const store = useEditorStore.getState();
    store.openEditor("http://example.com/img.png");

    // Save 60 history entries
    for (let i = 0; i < 60; i++) {
      useEditorStore.getState().addLayer({ name: `Layer ${i}` });
      useEditorStore.getState().saveToHistory();
    }

    const state = useEditorStore.getState();
    expect(state.history.length).toBeLessThanOrEqual(50);
  });
});

describe("editorStore closeEditor cleanup", () => {
  it("resets all state on close", () => {
    const store = useEditorStore.getState();
    store.openEditor("http://example.com/img.png", "img-123");

    // Add some state
    useEditorStore.getState().addLayer({ name: "Mask layer", type: "mask" });
    useEditorStore.getState().saveToHistory();
    useEditorStore.getState().setProcessing(true, "Processing...");
    useEditorStore.getState().setBrushSize(200);

    // Close
    useEditorStore.getState().closeEditor();

    const state = useEditorStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.layers).toEqual([]);
    expect(state.activeLayerId).toBeNull();
    expect(state.sourceImage).toBeNull();
    expect(state.sourceImageId).toBeNull();
    expect(state.sourceDimensions).toBeNull();
    expect(state.maskCanvas).toBeNull();
    expect(state.history).toEqual([]);
    expect(state.historyIndex).toBe(-1);
    expect(state.isProcessing).toBe(false);
    expect(state.processingMessage).toBe("");
  });

  it("clearHistory resets history without closing editor", () => {
    const store = useEditorStore.getState();
    store.openEditor("http://example.com/img.png");
    useEditorStore.getState().saveToHistory();
    useEditorStore.getState().saveToHistory();

    useEditorStore.getState().clearHistory();

    const state = useEditorStore.getState();
    expect(state.isOpen).toBe(true); // still open
    expect(state.history).toEqual([]);
    expect(state.historyIndex).toBe(-1);
  });
});

describe("editorStore openEditor", () => {
  it("opens with image and creates initial layer", () => {
    useEditorStore.getState().openEditor("http://example.com/test.png", "id-1");

    const state = useEditorStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.sourceImage).toBe("http://example.com/test.png");
    expect(state.sourceImageId).toBe("id-1");
    expect(state.layers.length).toBe(1);
    expect(state.layers[0].type).toBe("image");
    expect(state.layers[0].imageUrl).toBe("http://example.com/test.png");
    expect(state.activeLayerId).toBe(state.layers[0].id);
  });

  it("opens without image and creates no layers", () => {
    useEditorStore.getState().openEditor();

    const state = useEditorStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.layers).toEqual([]);
    expect(state.activeLayerId).toBeNull();
  });
});
