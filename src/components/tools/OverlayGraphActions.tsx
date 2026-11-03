"use client";

import { useEffect, useRef, useState } from "react";
import { ImageIcon, Loader2, Send } from "lucide-react";
import { isOverlayMode } from "@/lib/overlay";
import {
  insertApiWorkflow,
  loadGraphToolImage,
  requestGraphImage,
} from "@/lib/overlay/toolsBridge";
import { useOverlayToolsStore } from "@/store/overlayToolsStore";
import type { GraphImagePayload } from "@/lib/overlay/protocol";
import type { ApiWorkflowJson, ToolImage } from "@/lib/tools/runTool";

/** True when running embedded in the ComfyUI overlay (client-only). */
export function useIsOverlay(): boolean {
  const [overlay, setOverlay] = useState(false);
  useEffect(() => setOverlay(isOverlayMode()), []);
  return overlay;
}

export interface GraphImageHandoffState {
  /** Launcher asked to feed the graph image into the opened tool. */
  wanted: boolean;
  /** Overlay detection has run and reported "embedded in ComfyUI". */
  overlayReady: boolean;
  /** The opened tool takes an image input the graph image can fill. */
  accepts: boolean;
  graphImage: GraphImagePayload | null;
}

export interface GraphImageHandoffDeps {
  consume: () => boolean;
  load: (payload: GraphImagePayload) => Promise<ToolImage>;
  onImage: (img: ToolImage) => void;
  onError: (message: string) => void;
  /** False once the owning component unmounted. */
  alive: () => boolean;
}

/**
 * One commit of the launcher hand-off. Overlay detection runs in an effect,
 * so the first commit after mount sees overlayReady=false: the request is
 * left pending (not consumed) until detection settles. Once ready the flag
 * is consumed exactly once; the image load is only abandoned on unmount,
 * not when the consumed flag re-renders the component.
 * Returns the load promise, or null when nothing was loaded.
 */
export function runGraphImageHandoff(
  state: GraphImageHandoffState,
  deps: GraphImageHandoffDeps,
): Promise<void> | null {
  if (!state.wanted || !state.overlayReady) return null;
  if (!deps.consume()) return null;
  const graphImage = state.graphImage;
  if (!state.accepts || !graphImage || graphImage.images.length === 0) {
    return null;
  }
  return deps
    .load(graphImage)
    .then((img) => {
      if (deps.alive()) deps.onImage(img);
    })
    .catch((e) => {
      if (deps.alive()) deps.onError(errorText(e));
    });
}

/**
 * Launcher hand-off: when the overlay Tools launcher opened this tool with
 * the graph image, load it into the first input once.
 */
export function useGraphImageHandoff(
  overlayReady: boolean,
  accepts: boolean,
  onImage: (img: ToolImage) => void,
  onError: (message: string) => void,
): void {
  const wanted = useOverlayToolsStore((s) => s.pendingUseGraphImage);
  const graphImage = useOverlayToolsStore((s) => s.graphImage);
  const alive = useRef(true);
  const callbacks = useRef({ onImage, onError });
  callbacks.current = { onImage, onError };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    void runGraphImageHandoff(
      { wanted, overlayReady, accepts, graphImage },
      {
        consume: useOverlayToolsStore.getState().consumeGraphImageRequest,
        load: (payload) => loadGraphToolImage(payload),
        onImage: (img) => callbacks.current.onImage(img),
        onError: (message) => callbacks.current.onError(message),
        alive: () => alive.current,
      },
    );
  }, [wanted, overlayReady, accepts, graphImage]);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const SECONDARY_BUTTON =
  "w-full flex items-center justify-center gap-1.5 rounded-xl border border-light-100 dark:border-dark-750 bg-light-input dark:bg-dark-input px-3 py-2 text-xs font-medium text-light-primary dark:text-dark-primary hover:opacity-85 disabled:opacity-50 transition-opacity";

/** "Use ComfyUI selection": load the graph's picked image into an input. */
export function UseGraphImageButton({
  onImage,
  onError,
  disabled,
}: {
  onImage: (img: ToolImage) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}) {
  const graphImage = useOverlayToolsStore((s) => s.graphImage);
  const [loading, setLoading] = useState(false);
  const has = !!graphImage && graphImage.images.length > 0;

  const use = async () => {
    if (!graphImage || !has) {
      requestGraphImage();
      onError("Select an image node in ComfyUI, then try again.");
      return;
    }
    setLoading(true);
    try {
      onImage(await loadGraphToolImage(graphImage));
    } catch (e) {
      onError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={use}
      disabled={disabled || loading}
      className={SECONDARY_BUTTON}
      title={
        has
          ? `${graphImage.nodeTitle || graphImage.nodeType}: ${graphImage.images[0].filename}`
          : "Select a Load Image, Save Image or Preview Image node in ComfyUI"
      }
    >
      {loading ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : (
        <ImageIcon className="w-3.5 h-3.5" />
      )}
      {has
        ? `Use ComfyUI selection (${graphImage.nodeTitle || graphImage.nodeType})`
        : "Use ComfyUI selection"}
    </button>
  );
}

/**
 * "Send to graph": build the tool's API workflow (no queueing) and insert
 * it into the ComfyUI graph as nodes.
 */
export function SendToGraphButton({
  title,
  build,
  disabled,
}: {
  title: string;
  build: () => Promise<ApiWorkflowJson>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const status = useOverlayToolsStore((s) =>
    requestId ? s.inserts[requestId] : undefined,
  );

  const send = async () => {
    setBusy(true);
    setError(null);
    setRequestId(null);
    try {
      const workflow = await build();
      const id = insertApiWorkflow({ workflow, mode: "insert", title });
      useOverlayToolsStore.getState().markInsertPending(id, title);
      setRequestId(id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const waiting = status?.state === "pending";
  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={send}
        disabled={disabled || busy || waiting}
        className={SECONDARY_BUTTON}
        title="Add this tool's nodes to the ComfyUI graph without running it"
      >
        {busy || waiting ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Send className="w-3.5 h-3.5" />
        )}
        Send to graph
      </button>
      {error && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}
      {status?.state === "done" && status.ok && (
        <p className="text-[11px] text-light-500 dark:text-dark-400">
          Added {status.nodeIds.length} node
          {status.nodeIds.length === 1 ? "" : "s"} to the graph.
          {status.warnings.length > 0 &&
            ` ${status.warnings.length} warning${status.warnings.length === 1 ? "" : "s"}: ${status.warnings[0]}`}
        </p>
      )}
      {status?.state === "done" && !status.ok && (
        <p role="alert" className="text-xs text-red-500">
          {status.error ?? "ComfyUI could not add the nodes."}
        </p>
      )}
    </div>
  );
}
