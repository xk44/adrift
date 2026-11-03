/**
 * Overlay side of the Tools bridge (see protocol.ts "Tools bridge payloads").
 *
 *   overlay -> host  cj:request-graph-image   which image is picked in the graph?
 *   host -> overlay  cj:graph-image           node + image refs (also pushed on select)
 *   overlay -> host  cj:insert-api-workflow   add a tool's API graph as nodes
 *   host -> overlay  cj:graph-inserted        created node ids / warnings / error
 *
 * Everything here is plain functions over injectable globals so it can be
 * unit-tested without an iframe.
 */

import {
  HOST_MSG,
  OVERLAY_MSG,
  buildCjMessage,
  formatGraphImageRef,
  graphImageProxyUrl,
  parseCjMessage,
  type GraphImagePayload,
  type GraphInsertedPayload,
  type InsertApiWorkflowInput,
} from "./protocol";
import type { ToolImage } from "@/lib/tools/runTool";

interface PostTarget {
  postMessage: (message: unknown, targetOrigin: string) => void;
}

let requestCounter = 0;

/** Short unique id used to correlate a request with the host's reply. */
export function newRequestId(prefix = "cj"): string {
  requestCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${requestCounter}-${rand}`;
}

/** Parent window + its origin when readable (same-origin proxy setups). */
function parentTarget(): { target: PostTarget; origin: string } | null {
  if (typeof window === "undefined" || window.parent === window) return null;
  let origin = "*";
  try {
    origin = window.parent.location.origin || "*";
  } catch {
    /* cross-origin parent: same "*" the rest of the bridge uses */
  }
  return { target: window.parent, origin };
}

/** Ask the host for the image of a node (default: selection, then latest). */
export function requestGraphImage(
  nodeId?: number,
  to: { target: PostTarget; origin: string } | null = parentTarget(),
): string | null {
  if (!to) return null;
  const requestId = newRequestId("img");
  const msg = buildCjMessage(OVERLAY_MSG.REQUEST_GRAPH_IMAGE, {
    requestId,
    ...(nodeId !== undefined && nodeId >= 0 ? { nodeId } : {}),
  });
  to.target.postMessage(msg, to.origin);
  return requestId;
}

/**
 * Send an API workflow to the host for insertion. Validates first
 * (buildCjMessage throws on a bad workflow) and returns the requestId.
 */
export function insertApiWorkflow(
  input: Omit<InsertApiWorkflowInput, "requestId">,
  to: { target: PostTarget; origin: string } | null = parentTarget(),
): string {
  if (!to) throw new Error("Not running inside the ComfyUI overlay");
  const requestId = newRequestId("ins");
  const msg = buildCjMessage(OVERLAY_MSG.INSERT_API_WORKFLOW, {
    ...input,
    requestId,
  });
  to.target.postMessage(msg, to.origin);
  return requestId;
}

/**
 * Message listener for the Tools bridge replies. Only accepts messages from
 * the parent window (the ComfyUI host) that pass schema validation.
 */
export function createToolsBridgeListener(opts: {
  parent: unknown;
  onGraphImage: (payload: GraphImagePayload) => void;
  onInserted: (payload: GraphInsertedPayload) => void;
}): (event: MessageEvent) => void {
  return (event: MessageEvent) => {
    if (!opts.parent || event.source !== opts.parent) return;
    const data = event.data as { type?: unknown } | null;
    if (!data || typeof data !== "object") return;
    if (
      data.type !== HOST_MSG.GRAPH_IMAGE &&
      data.type !== HOST_MSG.GRAPH_INSERTED
    ) {
      return;
    }
    const parsed = parseCjMessage(data);
    if (!parsed.ok) return;
    if (parsed.type === HOST_MSG.GRAPH_IMAGE) {
      opts.onGraphImage(parsed.payload as GraphImagePayload);
    } else {
      opts.onInserted(parsed.payload as GraphInsertedPayload);
    }
  };
}

export interface GraphImageLoaders {
  fetchImpl: (url: string) => Promise<Pick<Response, "ok" | "blob">>;
  toDataUrl: (blob: Blob) => Promise<string>;
  measure: (src: string) => Promise<{ width: number; height: number }>;
}

function browserLoaders(): GraphImageLoaders {
  return {
    fetchImpl: (url) => fetch(url),
    toDataUrl: (blob) =>
      new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error ?? new Error("read failed"));
        r.readAsDataURL(blob);
      }),
    measure: (src) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () =>
          resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(new Error("image failed to load"));
        img.src = src;
      }),
  };
}

/**
 * Turn the graph's picked image into a runner input. The pixels come
 * through the same-origin /api/comfy/image proxy; `comfyRef` lets catalog
 * tools reference the file on the ComfyUI server without re-uploading it.
 */
export async function loadGraphToolImage(
  payload: GraphImagePayload,
  index = 0,
  loaders: GraphImageLoaders = browserLoaders(),
): Promise<ToolImage> {
  const ref = payload.images[index];
  if (!ref) throw new Error("No image on the selected node");
  const url = graphImageProxyUrl(ref);
  const res = await loaders.fetchImpl(url);
  if (!res.ok) throw new Error("Could not load the graph image");
  const dataUrl = await loaders.toDataUrl(await res.blob());
  const { width, height } = await loaders.measure(dataUrl);
  const title = payload.nodeTitle || payload.nodeType || "ComfyUI";
  return {
    id: `graph-${payload.nodeId}-${ref.filename}`,
    source: "upload",
    previewUrl: url,
    label: `${title}: ${ref.filename}`,
    width,
    height,
    dataUrl,
    comfyRef: formatGraphImageRef(ref),
  };
}
