/**
 * Editor Store
 * State management for the image editor including layers, tools, brush settings, and canvas state
 */

import { createWithEqualityFn } from "zustand/traditional";
import type { EditorSourceRun, EditorToolRun } from "@/lib/editorTools";

export type EditorTool = "select" | "move" | "paint" | "smartSelect" | "crop";
export type PaintMode = "erase" | "restore";
export type EditorTab = "edit" | "retexture" | "enhance";

export interface EditorLayer {
  id: string;
  name: string;
  type: "image" | "mask" | "controlnet";
  visible: boolean;
  locked: boolean;
  opacity: number;
  imageUrl?: string;
  imageData?: ImageData;
  maskData?: ImageData;
}

export interface CanvasTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

export interface ImageDimensions {
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}

interface EditorState {
  // Mode
  isOpen: boolean;
  activeTab: EditorTab;

  // Source image
  sourceImage: string | null;
  sourceImageId: string | null;
  sourceDimensions: ImageDimensions | null;
  /**
   * Local run behind the canvas once a tool result replaced it (the gallery
   * item it was opened from covers the first version).
   */
  sourceRun: EditorSourceRun | null;

  // Runs started from the editor's Tools panel, waiting for their result.
  toolRuns: EditorToolRun[];

  // Layers
  layers: EditorLayer[];
  activeLayerId: string | null;

  // Tools
  activeTool: EditorTool;
  paintMode: PaintMode;
  brushSize: number;
  brushHardness: number;

  // Canvas state
  canvasTransform: CanvasTransform;
  showMask: boolean;
  maskOpacity: number;

  // Mask data (for inpainting)
  maskCanvas: HTMLCanvasElement | null;

  // Retexture/ControlNet
  controlnetType: string;
  controlnetStrength: number;

  // Outpaint settings
  outpaintDirection: "up" | "down" | "left" | "right" | null;
  outpaintAmount: number;

  // History for undo/redo
  historyIndex: number;
  history: Array<{
    layers: EditorLayer[];
    maskData?: string;
    /** Canvas version at this point (tool results replace it). */
    sourceImage?: string | null;
    sourceImageId?: string | null;
    sourceRun?: EditorSourceRun | null;
  }>;

  // Loading/processing state
  isProcessing: boolean;
  processingMessage: string;
}

interface EditorActions {
  // Open/close editor
  openEditor: (imageUrl?: string, imageId?: string) => void;
  closeEditor: () => void;
  setActiveTab: (tab: EditorTab) => void;

  // Image loading
  setSourceImage: (url: string, id?: string) => void;
  setSourceDimensions: (dims: ImageDimensions) => void;
  clearSourceImage: () => void;

  // Layer management
  addLayer: (layer: Partial<EditorLayer>) => string;
  removeLayer: (id: string) => void;
  updateLayer: (id: string, updates: Partial<EditorLayer>) => void;
  setActiveLayer: (id: string | null) => void;
  reorderLayers: (fromIndex: number, toIndex: number) => void;
  duplicateLayer: (id: string) => void;

  // Tool settings
  setActiveTool: (tool: EditorTool) => void;
  setPaintMode: (mode: PaintMode) => void;
  setBrushSize: (size: number) => void;
  setBrushHardness: (hardness: number) => void;

  // Canvas
  setCanvasTransform: (transform: Partial<CanvasTransform>) => void;
  resetCanvasTransform: () => void;
  setShowMask: (show: boolean) => void;
  setMaskOpacity: (opacity: number) => void;
  setMaskCanvas: (canvas: HTMLCanvasElement | null) => void;

  // ControlNet
  setControlnetType: (type: string) => void;
  setControlnetStrength: (strength: number) => void;

  // Outpaint
  setOutpaintDirection: (dir: "up" | "down" | "left" | "right" | null) => void;
  setOutpaintAmount: (amount: number) => void;

  // History
  /** `maskData` overrides the live mask (a crop saves the cropped one). */
  saveToHistory: (opts?: { maskData?: string | null }) => void;
  undo: () => void;
  redo: () => void;
  clearHistory: () => void;

  // Processing
  setProcessing: (processing: boolean, message?: string) => void;

  // Tools panel
  trackToolRun: (run: EditorToolRun) => void;
  untrackToolRun: (runId: string) => void;
  /**
   * A tool's image result(s): each becomes a layer, the first one the new
   * canvas. Undo returns to the previous canvas.
   */
  applyToolResult: (result: {
    images: string[];
    title: string;
    run: EditorSourceRun;
    galleryId?: string | null;
  }) => void;
  /** A crop of the canvas becomes the new base image. Undo restores it. */
  applyCrop: (imageUrl: string, maskData: string | null) => void;

  // Reset
  resetEditor: () => void;
}

const defaultTransform: CanvasTransform = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
};

const initialState: EditorState = {
  isOpen: false,
  activeTab: "edit",
  sourceImage: null,
  sourceImageId: null,
  sourceDimensions: null,
  sourceRun: null,
  toolRuns: [],
  layers: [],
  activeLayerId: null,
  activeTool: "paint",
  paintMode: "erase",
  brushSize: 100,
  brushHardness: 100,
  canvasTransform: defaultTransform,
  showMask: true,
  maskOpacity: 0.5,
  maskCanvas: null,
  controlnetType: "canny",
  controlnetStrength: 1.0,
  outpaintDirection: null,
  outpaintAmount: 256,
  historyIndex: -1,
  history: [],
  isProcessing: false,
  processingMessage: "",
};

/** Canvas fields to restore from a history entry (older entries have none). */
function restoreCanvasVersion(
  entry: EditorState["history"][number],
  current: string | null,
): Partial<EditorState> {
  if (entry.sourceImage === undefined || entry.sourceImage === current)
    return {};
  return {
    sourceImage: entry.sourceImage,
    sourceImageId: entry.sourceImageId ?? null,
    sourceRun: entry.sourceRun ?? null,
  };
}

function deserializeHistoryLayers(layers: EditorLayer[]): EditorLayer[] {
  return structuredClone(layers);
}

export const useEditorStore = createWithEqualityFn<EditorState & EditorActions>()(
  (set, get) => ({
    ...initialState,

    // Open/close
    openEditor: (imageUrl, imageId) => {
      set({
        isOpen: true,
        sourceImage: imageUrl ?? null,
        sourceImageId: imageId ?? null,
        sourceRun: null,
        layers: imageUrl
          ? [
              {
                id: crypto.randomUUID(),
                name: "Layer 1",
                type: "image",
                visible: true,
                locked: false,
                opacity: 1,
                imageUrl,
              },
            ]
          : [],
        activeLayerId: null,
      });

      // Set active layer if image was provided
      if (imageUrl) {
        const layers = get().layers;
        if (layers.length > 0) {
          set({ activeLayerId: layers[0].id });
        }
      }
    },

    closeEditor: () => {
      set({
        isOpen: false,
        layers: [],
        activeLayerId: null,
        sourceImage: null,
        sourceImageId: null,
        sourceDimensions: null,
        sourceRun: null,
        toolRuns: [],
        maskCanvas: null,
        history: [],
        historyIndex: -1,
        isProcessing: false,
        processingMessage: "",
      });
    },

    setActiveTab: (tab) => set({ activeTab: tab }),

    // Image loading
    setSourceImage: (url, id) => {
      const layerId = crypto.randomUUID();
      set({
        sourceImage: url,
        sourceImageId: id ?? null,
        sourceRun: null,
        layers: [
          {
            id: layerId,
            name: "Layer 1",
            type: "image",
            visible: true,
            locked: false,
            opacity: 1,
            imageUrl: url,
          },
        ],
        activeLayerId: layerId,
      });
    },

    setSourceDimensions: (dims) => set({ sourceDimensions: dims }),

    clearSourceImage: () =>
      set({
        sourceImage: null,
        sourceImageId: null,
        sourceDimensions: null,
        sourceRun: null,
        layers: [],
        activeLayerId: null,
        maskCanvas: null,
      }),

    // Layers
    addLayer: (layer) => {
      const id = crypto.randomUUID();
      const newLayer: EditorLayer = {
        id,
        name: layer.name ?? `Layer ${get().layers.length + 1}`,
        type: layer.type ?? "image",
        visible: layer.visible ?? true,
        locked: layer.locked ?? false,
        opacity: layer.opacity ?? 1,
        imageUrl: layer.imageUrl,
      };
      set((state) => ({
        layers: [...state.layers, newLayer],
        activeLayerId: id,
      }));
      return id;
    },

    removeLayer: (id) =>
      set((state) => {
        const newLayers = state.layers.filter((l) => l.id !== id);
        return {
          layers: newLayers,
          activeLayerId:
            state.activeLayerId === id
              ? (newLayers[newLayers.length - 1]?.id ?? null)
              : state.activeLayerId,
        };
      }),

    updateLayer: (id, updates) =>
      set((state) => ({
        layers: state.layers.map((l) =>
          l.id === id ? { ...l, ...updates } : l,
        ),
      })),

    setActiveLayer: (id) => set({ activeLayerId: id }),

    reorderLayers: (fromIndex, toIndex) =>
      set((state) => {
        if (
          !Number.isInteger(fromIndex) ||
          !Number.isInteger(toIndex) ||
          fromIndex < 0 ||
          fromIndex >= state.layers.length ||
          toIndex < 0 ||
          toIndex >= state.layers.length ||
          fromIndex === toIndex
        ) {
          return state;
        }
        const newLayers = [...state.layers];
        const [removed] = newLayers.splice(fromIndex, 1);
        if (!removed) return state;
        newLayers.splice(toIndex, 0, removed);
        return { layers: newLayers };
      }),

    duplicateLayer: (id) => {
      const layer = get().layers.find((l) => l.id === id);
      if (layer) {
        get().addLayer({
          ...layer,
          name: `${layer.name} copy`,
        });
      }
    },

    // Tools
    setActiveTool: (tool) => set({ activeTool: tool }),
    setPaintMode: (mode) => set({ paintMode: mode }),
    setBrushSize: (size) =>
      set({ brushSize: Math.max(1, Math.min(500, size)) }),
    setBrushHardness: (hardness) =>
      set({ brushHardness: Math.max(0, Math.min(100, hardness)) }),

    // Canvas
    setCanvasTransform: (transform) =>
      set((state) => ({
        canvasTransform: { ...state.canvasTransform, ...transform },
      })),

    resetCanvasTransform: () => set({ canvasTransform: defaultTransform }),

    setShowMask: (show) => set({ showMask: show }),
    setMaskOpacity: (opacity) => set({ maskOpacity: opacity }),
    setMaskCanvas: (canvas) => set({ maskCanvas: canvas }),

    // ControlNet
    setControlnetType: (type) => set({ controlnetType: type }),
    setControlnetStrength: (strength) => set({ controlnetStrength: strength }),

    // Outpaint
    setOutpaintDirection: (dir) => set({ outpaintDirection: dir }),
    setOutpaintAmount: (amount) => set({ outpaintAmount: amount }),

    // History
    saveToHistory: (opts) => {
      const {
        layers,
        history,
        historyIndex,
        maskCanvas,
        sourceImage,
        sourceImageId,
        sourceRun,
      } = get();
      const maskData =
        opts && "maskData" in opts
          ? (opts.maskData ?? undefined)
          : maskCanvas?.toDataURL();

      // Serialize layers, converting ImageData fields to data URLs
      // since ImageData is not JSON-serializable
      const serializedLayers = layers.map((layer) => {
        const serialized = { ...layer } as EditorLayer & {
          imageDataUrl?: string;
          maskDataUrl?: string;
        };
        if (layer.imageData) {
          const canvas = document.createElement("canvas");
          canvas.width = layer.imageData.width;
          canvas.height = layer.imageData.height;
          canvas.getContext("2d")!.putImageData(layer.imageData, 0, 0);
          serialized.imageDataUrl = canvas.toDataURL();
          delete serialized.imageData;
        }
        if (layer.maskData) {
          const canvas = document.createElement("canvas");
          canvas.width = layer.maskData.width;
          canvas.height = layer.maskData.height;
          canvas.getContext("2d")!.putImageData(layer.maskData, 0, 0);
          serialized.maskDataUrl = canvas.toDataURL();
          delete serialized.maskData;
        }
        return serialized;
      });

      // Truncate any redo history
      const newHistory = history.slice(0, historyIndex + 1);
      newHistory.push({
        layers: structuredClone(serializedLayers),
        maskData,
        sourceImage,
        sourceImageId,
        sourceRun,
      });

      if (newHistory.length > 50) {
        newHistory.shift();
      }

      set({
        history: newHistory,
        historyIndex: newHistory.length - 1,
      });
    },

    undo: () => {
      const { historyIndex, history } = get();
      if (historyIndex > 0) {
        const prev = history[historyIndex - 1];
        set({
          layers: deserializeHistoryLayers(prev.layers),
          ...restoreCanvasVersion(prev, get().sourceImage),
          historyIndex: historyIndex - 1,
        });
      }
    },

    redo: () => {
      const { historyIndex, history } = get();
      if (historyIndex < history.length - 1) {
        const next = history[historyIndex + 1];
        set({
          layers: deserializeHistoryLayers(next.layers),
          ...restoreCanvasVersion(next, get().sourceImage),
          historyIndex: historyIndex + 1,
        });
      }
    },

    clearHistory: () => set({ history: [], historyIndex: -1 }),

    // Processing
    setProcessing: (processing, message = "") =>
      set({ isProcessing: processing, processingMessage: message }),

    // Tools panel
    trackToolRun: (run) =>
      set((state) => ({
        toolRuns: [
          ...state.toolRuns.filter((r) => r.runId !== run.runId),
          run,
        ],
      })),

    untrackToolRun: (runId) =>
      set((state) => ({
        toolRuns: state.toolRuns.filter((r) => r.runId !== runId),
      })),

    applyToolResult: ({ images, title, run, galleryId }) => {
      const urls = images.filter(Boolean);
      if (urls.length === 0) return;
      // Undo needs the version before the result; the first edit may not
      // have saved one yet.
      if (get().history.length === 0) get().saveToHistory();
      const firstId = crypto.randomUUID();
      const added: EditorLayer[] = urls.map((imageUrl, i) => ({
        id: i === 0 ? firstId : crypto.randomUUID(),
        name: urls.length > 1 ? `${title} ${i + 1}` : title,
        type: "image",
        visible: true,
        locked: false,
        opacity: 1,
        imageUrl,
      }));
      set((state) => ({
        sourceImage: urls[0],
        sourceImageId: galleryId ?? null,
        sourceRun: run,
        layers: [...state.layers, ...added],
        activeLayerId: firstId,
      }));
      get().saveToHistory();
    },

    applyCrop: (imageUrl, maskData) => {
      if (get().history.length === 0) get().saveToHistory();
      const id = crypto.randomUUID();
      set((state) => ({
        sourceImage: imageUrl,
        sourceImageId: null,
        sourceRun: null,
        layers: [
          ...state.layers,
          {
            id,
            name: "Crop",
            type: "image",
            visible: true,
            locked: false,
            opacity: 1,
            imageUrl,
          },
        ],
        activeLayerId: id,
      }));
      get().saveToHistory({ maskData });
    },

    // Reset
    resetEditor: () => set(initialState),
  }),
);

// Selectors
export const selectActiveLayer = (state: EditorState) =>
  state.layers.find((l) => l.id === state.activeLayerId);

export const selectVisibleLayers = (state: EditorState) =>
  state.layers.filter((l) => l.visible);

export const selectCanUndo = (state: EditorState) => state.historyIndex > 0;
export const selectCanRedo = (state: EditorState) =>
  state.historyIndex < state.history.length - 1;

export default useEditorStore;
