/**
 * Live latent previews from ComfyUI's binary WebSocket frames.
 *
 * Wire format (ComfyUI server.py / protocol.py, 0.42):
 *   every binary frame:  >I event_type, then payload
 *   1 PREVIEW_IMAGE:               >I image_type (1=JPEG, 2=PNG), image bytes
 *   4 PREVIEW_IMAGE_WITH_METADATA: >I metadata_len, metadata JSON (utf-8,
 *                                  { node_id, prompt_id, display_node_id,
 *                                    parent_node_id, real_node_id,
 *                                    image_type: "image/jpeg"|"image/png" }),
 *                                  image bytes
 *   3 TEXT (progress text) and anything else → ignored here.
 *
 * Type 4 is only sent to sockets that open with
 *   {"type":"feature_flags","data":{"supports_preview_metadata":true}}
 * as their FIRST text message (server.py websocket_handler); others get type 1,
 * which carries no prompt id. Previews exist at all only when ComfyUI runs
 * with --preview-method (auto | latent2rgb | taesd).
 *
 * Client-safe: no Node imports.
 */

import { useSyncExternalStore } from "react";

export const BinaryEventType = {
  PREVIEW_IMAGE: 1,
  UNENCODED_PREVIEW_IMAGE: 2,
  TEXT: 3,
  PREVIEW_IMAGE_WITH_METADATA: 4,
} as const;

/** First message a client sends to opt into PREVIEW_IMAGE_WITH_METADATA. */
export const CLIENT_FEATURE_FLAGS_MESSAGE = JSON.stringify({
  type: "feature_flags",
  data: { supports_preview_metadata: true },
});

export interface DecodedPreview {
  event: 1 | 4;
  mime: "image/jpeg" | "image/png";
  promptId?: string;
  nodeId?: string;
  displayNodeId?: string;
  image: Uint8Array;
}

/**
 * Decode one ComfyUI binary WS frame into a preview image, or null when the
 * frame is not a preview / is malformed. Never throws.
 */
export function decodeComfyBinaryFrame(
  buffer: ArrayBuffer | ArrayBufferView,
): DecodedPreview | null {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (bytes.byteLength < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const event = view.getUint32(0, false);

  if (event === BinaryEventType.PREVIEW_IMAGE) {
    const imageType = view.getUint32(4, false);
    const image = bytes.subarray(8);
    if (image.byteLength === 0) return null;
    return {
      event: 1,
      mime: imageType === 2 ? "image/png" : "image/jpeg",
      image,
    };
  }

  if (event === BinaryEventType.PREVIEW_IMAGE_WITH_METADATA) {
    const metaLen = view.getUint32(4, false);
    if (8 + metaLen > bytes.byteLength) return null;
    let meta: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(
        new TextDecoder().decode(bytes.subarray(8, 8 + metaLen)),
      );
      if (typeof parsed !== "object" || parsed === null) return null;
      meta = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
    const image = bytes.subarray(8 + metaLen);
    if (image.byteLength === 0) return null;
    const str = (v: unknown) =>
      typeof v === "string" && v
        ? v
        : typeof v === "number"
          ? String(v)
          : undefined;
    return {
      event: 4,
      mime: meta.image_type === "image/png" ? "image/png" : "image/jpeg",
      promptId: str(meta.prompt_id),
      nodeId: str(meta.node_id),
      displayNodeId: str(meta.display_node_id),
      image,
    };
  }

  return null;
}

// Preview registry: one object URL per prompt, throttled, old URLs revoked.
// Kept outside the zustand store so 10+ fps previews only re-render the tile
// that shows them.

export interface LivePreview {
  url: string;
  nodeId?: string;
  updatedAt: number;
}

export interface LivePreviewStoreOptions {
  /** Minimum gap between committed previews per prompt (trailing throttle). */
  minIntervalMs?: number;
  /** Most prompts kept at once; oldest are revoked beyond this. */
  maxEntries?: number;
  now?: () => number;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
}

interface Pending {
  preview: DecodedPreview;
  timer: ReturnType<typeof setTimeout>;
}

export class LivePreviewStore {
  private entries = new Map<string, LivePreview>();
  private pending = new Map<string, Pending>();
  private listeners = new Set<() => void>();
  private readonly minIntervalMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly createUrl: (blob: Blob) => string;
  private readonly revokeUrl: (url: string) => void;

  constructor(opts: LivePreviewStoreOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 200;
    this.maxEntries = opts.maxEntries ?? 16;
    this.now = opts.now ?? (() => Date.now());
    this.createUrl = opts.createUrl ?? ((b) => URL.createObjectURL(b));
    this.revokeUrl = opts.revokeUrl ?? ((u) => URL.revokeObjectURL(u));
  }

  get(promptId: string | undefined | null): LivePreview | undefined {
    return promptId ? this.entries.get(promptId) : undefined;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  /** Offer a decoded preview; commits now or at the end of the throttle window. */
  push(promptId: string, preview: DecodedPreview): void {
    const last = this.entries.get(promptId);
    const pending = this.pending.get(promptId);
    const wait = last ? last.updatedAt + this.minIntervalMs - this.now() : 0;
    if (wait <= 0 && !pending) {
      this.commit(promptId, preview);
      return;
    }
    if (pending) {
      pending.preview = preview; // keep only the newest frame
      return;
    }
    const timer = setTimeout(
      () => {
        const p = this.pending.get(promptId);
        this.pending.delete(promptId);
        if (p) this.commit(promptId, p.preview);
      },
      Math.max(0, wait),
    );
    this.pending.set(promptId, { preview, timer });
  }

  /** Drop a prompt's preview (and any throttled frame), revoking its URL. */
  clear(promptId: string): void {
    const pending = this.pending.get(promptId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(promptId);
    }
    const entry = this.entries.get(promptId);
    if (!entry) return;
    this.entries.delete(promptId);
    this.revokeUrl(entry.url);
    this.emit();
  }

  clearAll(): void {
    for (const id of [...this.pending.keys(), ...this.entries.keys()]) {
      this.clear(id);
    }
  }

  private commit(promptId: string, preview: DecodedPreview): void {
    let url: string;
    try {
      url = this.createUrl(
        new Blob([preview.image as BlobPart], { type: preview.mime }),
      );
    } catch {
      return;
    }
    const prev = this.entries.get(promptId);
    this.entries.delete(promptId);
    this.entries.set(promptId, {
      url,
      nodeId: preview.nodeId,
      updatedAt: this.now(),
    });
    if (prev) this.revokeUrl(prev.url);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.clear(oldest);
    }
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

/** App-wide registry fed by useComfyWS. */
export const livePreviews = new LivePreviewStore();

/** Current live preview object URL for a prompt (undefined when none). */
export function useLivePreview(
  promptId: string | undefined | null,
): string | undefined {
  return useSyncExternalStore(
    livePreviews.subscribe,
    () => livePreviews.get(promptId)?.url,
    () => undefined,
  );
}
