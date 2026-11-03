/**
 * Adrift Overlay Bridge Protocol — explicit, testable, inert
 *
 * Shared protocol definitions for the postMessage bridge between the
 * ComfyUI host frame and the Adrift overlay iframe/panel.
 *
 * This module is the SINGLE SOURCE OF TRUTH for:
 *   - Message type constants
 *   - Message shape schemas (Zod)
 *   - Origin allowlist validation
 *   - Message builder / parser helpers
 *   - Nonce / session replay protection
 *   - Protocol version negotiation
 *   - Host bridge state surface
 *   - Structured event logging (audit trail)
 *
 * CRITICAL: This module performs NO side effects. It does not:
 *   - Create iframes or panels
 *   - Mutate any ComfyUI graph
 *   - Send or receive postMessage
 *   - Trust any origin by default
 *   - Generate random values (nonce factory is injected)
 *
 * Consumers (the bridge JS and the overlay app) import this module
 * for type-safe message construction and validation.
 */

import { z } from "zod";

// Protocol version
export const CJ_PROTOCOL_VERSION = 1;

/** Minimum protocol version the host will accept from an overlay hello. */
export const CJ_MIN_SUPPORTED_VERSION = 1;

/** Maximum protocol version the host supports. */
export const CJ_MAX_SUPPORTED_VERSION = 1;

// Message type constants
// Host → Overlay
export const HOST_MSG = {
  CONFIG: "cj:config",
  PROGRESS: "cj:progress",
  STATUS: "cj:status",
  IMAGES: "cj:images",
  ERROR: "cj:error",
  VISIBILITY: "cj:visibility",
  WORKFLOW: "cj:workflow",
  /** Sync relevant KSampler/model node values when changed in ComfyUI */
  SETTINGS_SYNC: "cj:settings-sync",
  /** Notify overlay when a node is selected in ComfyUI */
  NODE_SELECTED: "cj:node-selected",
  /** Pong response for latency measurement */
  PONG: "cj:pong",
  /** Image(s) of a graph node (selection or request) for running a tool on */
  GRAPH_IMAGE: "cj:graph-image",
  /** Result of an insert-api-workflow request */
  GRAPH_INSERTED: "cj:graph-inserted",
  /** ComfyUI's current palette mode (light/dark), on open and on change */
  THEME: "cj:theme",
  /** Current overlay layout (full viewport or docked right panel) */
  LAYOUT: "cj:layout",
} as const;

// Overlay → Host
export const OVERLAY_MSG = {
  HELLO: "cj:hello",
  READY: "cj:ready",
  RUN: "cj:run",
  INTERRUPT: "cj:interrupt",
  ACK: "cj:ack",
  QUEUE: "cj:queue",
  /** Send a workflow from CJ to ComfyUI for loading into the graph editor */
  LOAD_WORKFLOW: "cj:load-workflow",
  /** Send an image filename from CJ to ComfyUI (e.g. drag-and-drop) */
  DRAG_IMAGE: "cj:drag-image",
  /** Ping request for latency measurement */
  PING: "cj:ping",
  /** Ask the host for the image of the selected (or given) graph node */
  REQUEST_GRAPH_IMAGE: "cj:request-graph-image",
  /** Add a tool's API-format workflow to the ComfyUI graph as nodes */
  INSERT_API_WORKFLOW: "cj:insert-api-workflow",
  /** Hide the overlay and show ComfyUI's graph editor */
  SHOW_GRAPH: "cj:show-graph",
  /** Ask the host to switch the overlay between full and docked panel */
  SET_LAYOUT: "cj:set-layout",
} as const;

export type CjMessageType =
  | (typeof HOST_MSG)[keyof typeof HOST_MSG]
  | (typeof OVERLAY_MSG)[keyof typeof OVERLAY_MSG];

/** Set of all known message type strings, useful for exhaustive validation. */
export const ALL_KNOWN_MESSAGE_TYPES: Set<string> = new Set([
  ...Object.values(HOST_MSG),
  ...Object.values(OVERLAY_MSG),
]);

// Direction helpers
const HOST_MSG_VALUES = new Set<string>(Object.values(HOST_MSG));
const OVERLAY_MSG_VALUES = new Set<string>(Object.values(OVERLAY_MSG));

/** Returns "host→overlay" | "overlay→host" | "unknown" */
export function messageDirection(
  type: string,
): "host→overlay" | "overlay→host" | "unknown" {
  if (HOST_MSG_VALUES.has(type)) return "host→overlay";
  if (OVERLAY_MSG_VALUES.has(type)) return "overlay→host";
  return "unknown";
}

/**
 * Determine the role that should send a given message type.
 * Returns "host" for host→overlay types, "overlay" for overlay→host types,
 * or "unknown" for unrecognized types.
 *
 * Useful for direction-check guards in message handlers.
 */
export function messageRole(type: string): "host" | "overlay" | "unknown" {
  if (HOST_MSG_VALUES.has(type)) return "host";
  if (OVERLAY_MSG_VALUES.has(type)) return "overlay";
  return "unknown";
}

// Payload schemas

/** Config payload sent from host to overlay during handshake */
export const ConfigPayloadSchema = z.object({
  /** Full URL to ComfyUI HTTP API, e.g. "http://localhost:8188" */
  comfyUrl: z.string().url(),
  /** WebSocket URL for ComfyUI, e.g. "ws://localhost:8188" */
  wsUrl: z.string().min(1),
  /** Client ID for WebSocket multiplexing */
  clientId: z.string().min(1),
  mode: z.literal("overlay"),
  version: z.number().int().positive().optional(),
  /** Session nonce for this bridge instance (replay protection) */
  nonce: z.string().min(1).optional(),
});
export type ConfigPayload = z.infer<typeof ConfigPayloadSchema>;

/** Hello payload: overlay introduces itself to host */
export const HelloPayloadSchema = z.object({
  /** Overlay app identifier ("adrift"; the pre-rename id is still accepted) */
  name: z.enum(["adrift", "comfyjourney"]), // legacy-name
  /** Protocol version the overlay speaks */
  version: z.number().int().positive(),
  /** Session nonce echoed back for replay protection */
  nonce: z.string().min(1).optional(),
});
export type HelloPayload = z.infer<typeof HelloPayloadSchema>;

/** Ready payload: overlay is mounted and accepting commands */
export const ReadyPayloadSchema = z.object({
  timestamp: z.number().int().positive(),
});
export type ReadyPayload = z.infer<typeof ReadyPayloadSchema>;

/** Run payload: overlay requests workflow execution */
export const RunPayloadSchema = z.object({
  /** Workflow JSON or workflow path identifier */
  workflow: z.unknown(),
  /** Client ID for the prompt */
  clientId: z.string().min(1),
  /** Optional prompt text for logging */
  promptText: z.string().optional(),
});
export type RunPayload = z.infer<typeof RunPayloadSchema>;

/** Interrupt payload: overlay requests execution interrupt */
export const InterruptPayloadSchema = z.object({});
export type InterruptPayload = z.infer<typeof InterruptPayloadSchema>;

/** Ack payload: overlay acknowledges a host message */
export const AckPayloadSchema = z.object({
  /** The message type being acknowledged */
  ackType: z.string().min(1),
  /** Whether the acknowledged message was accepted */
  accepted: z.boolean(),
  /** Optional error detail if not accepted */
  error: z.string().optional(),
  /** Optional nonce of the message being acknowledged (replay protection) */
  nonce: z.string().min(1).optional(),
  /**
   * ComfyUI prompt_id for an accepted cj:queue. Must be declared: z.object
   * strips unknown keys, so an undeclared promptId never reached the app.
   */
  promptId: z.string().min(1).optional(),
});
export type AckPayload = z.infer<typeof AckPayloadSchema>;

/** Progress payload: host reports execution progress */
export const ProgressPayloadSchema = z.object({
  promptId: z.string().min(1),
  value: z.number().int().min(0),
  max: z.number().int().min(1),
  nodeId: z.number().int().optional(),
});
export type ProgressPayload = z.infer<typeof ProgressPayloadSchema>;

/** Status payload: host reports queue status */
export const StatusPayloadSchema = z.object({
  queueRemaining: z.number().int().min(0),
});
export type StatusPayload = z.infer<typeof StatusPayloadSchema>;

/** Images payload: host reports completed images */
export const ImagesPayloadSchema = z.object({
  promptId: z.string().min(1),
  images: z.array(
    z.object({
      filename: z.string().min(1),
      subfolder: z.string().optional(),
      type: z.enum(["output", "input", "temp"]),
    }),
  ),
});
export type ImagesPayload = z.infer<typeof ImagesPayloadSchema>;

/** Error payload: host reports an error */
export const ErrorPayloadSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  detail: z.unknown().optional(),
});
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

/** Visibility payload: host notifies overlay of show/hide */
export const VisibilityPayloadSchema = z.object({
  visible: z.boolean(),
});
export type VisibilityPayload = z.infer<typeof VisibilityPayloadSchema>;

/** Workflow payload: host sends current ComfyUI workflow to overlay */
export const WorkflowPayloadSchema = z.object({
  workflow: z.unknown(),
  /** Revision counter for change detection (optional for backward compat) */
  revision: z.number().int().min(0).optional(),
  /** Human-readable workflow name from the host (e.g. saved filename) */
  name: z.string().optional(),
});
export type WorkflowPayload = z.infer<typeof WorkflowPayloadSchema>;

/** Queue payload: overlay requests queueing a prompt via ComfyUI */
export const QueuePayloadSchema = z.object({
  prompt: z.unknown(),
  clientId: z.string().min(1).optional(),
});
export type QueuePayload = z.infer<typeof QueuePayloadSchema>;

/** Load-workflow payload: overlay sends a workflow to ComfyUI for loading */
export const LoadWorkflowPayloadSchema = z.object({
  workflow: z.unknown(),
  /** Saved user-workflow path (relative to ComfyUI's workflows dir), e.g. "sub/foo.json" */
  name: z.string().min(1).max(256).optional(),
});
export type LoadWorkflowPayload = z.infer<typeof LoadWorkflowPayloadSchema>;

/** Show-graph payload: overlay asks the host to switch to the graph view */
export const ShowGraphPayloadSchema = z.object({});
export type ShowGraphPayload = z.infer<typeof ShowGraphPayloadSchema>;

/** Drag-image payload: overlay sends an image reference to ComfyUI */
export const DragImagePayloadSchema = z.object({
  filename: z.string().min(1),
  subfolder: z.string().optional(),
  type: z.enum(["output", "input", "temp"]).optional(),
});
export type DragImagePayload = z.infer<typeof DragImagePayloadSchema>;

/** Settings-sync payload: host sends KSampler/model node values to overlay */
export const SettingsSyncPayloadSchema = z.object({
  /** Revision counter so overlay can detect stale updates */
  revision: z.number().int().min(0),
  /** Sampler name (e.g. "euler", "dpmpp_2m") */
  sampler: z.string().optional(),
  scheduler: z.string().optional(),
  steps: z.number().int().positive().optional(),
  cfg: z.number().positive().optional(),
  seed: z.number().optional(),
  denoise: z.number().min(0).max(1).optional(),
  /** Model/checkpoint name */
  model: z.string().optional(),
  /** Positive prompt text */
  positivePrompt: z.string().optional(),
  /** Negative prompt text */
  negativePrompt: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type SettingsSyncPayload = z.infer<typeof SettingsSyncPayloadSchema>;

/** Node-selected payload: host notifies overlay which node the user clicked */
export const NodeSelectedPayloadSchema = z.object({
  nodeId: z.number().int(),
  nodeType: z.string().min(1),
  nodeTitle: z.string(),
  inputs: z.record(z.unknown()).optional(),
});
export type NodeSelectedPayload = z.infer<typeof NodeSelectedPayloadSchema>;

/** Ping payload: overlay requests latency measurement */
export const PingPayloadSchema = z.object({
  timestamp: z.number(),
});
export type PingPayload = z.infer<typeof PingPayloadSchema>;

/** Pong payload: host responds to ping with original timestamp */
export const PongPayloadSchema = z.object({
  timestamp: z.number(),
});
export type PongPayload = z.infer<typeof PongPayloadSchema>;

/** Theme payload: host reports ComfyUI's palette mode */
export const ThemePayloadSchema = z.object({
  mode: z.enum(["light", "dark"]),
});
export type ThemePayload = z.infer<typeof ThemePayloadSchema>;

/** Overlay layouts: full viewport, or a resizable panel docked right. */
export const OVERLAY_LAYOUTS = ["full", "panel"] as const;
export type OverlayLayout = (typeof OVERLAY_LAYOUTS)[number];

/** Layout payload: host reports the overlay's current layout */
export const LayoutPayloadSchema = z.object({
  layout: z.enum(OVERLAY_LAYOUTS),
  /** Docked panel width in CSS px (present in panel layout) */
  panelWidth: z.number().int().positive().max(100_000).optional(),
});
export type LayoutPayload = z.infer<typeof LayoutPayloadSchema>;

/** Set-layout payload: overlay asks the host to change layout */
export const SetLayoutPayloadSchema = z.object({
  layout: z.enum(OVERLAY_LAYOUTS),
});
export type SetLayoutPayload = z.infer<typeof SetLayoutPayloadSchema>;

// Tools bridge payloads (graph images + API workflow insert)

/** Max nodes the host accepts in one insert-api-workflow request. */
export const MAX_INSERT_NODES = 400;

/** Max images reported for one graph node. */
export const MAX_GRAPH_IMAGES = 64;

const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

/** One image a graph node shows or loads (ComfyUI /view coordinates). */
export const GraphImageRefSchema = z.object({
  filename: z
    .string()
    .min(1)
    .max(255)
    .refine(
      (f) =>
        !CONTROL_CHARS_RE.test(f) &&
        !f.includes("/") &&
        !f.includes("\\") &&
        f !== "." &&
        f !== "..",
      { message: "filename must be a plain file name" },
    ),
  subfolder: z
    .string()
    .max(255)
    .refine(
      (s) =>
        !CONTROL_CHARS_RE.test(s) &&
        !s.includes("\\") &&
        !s.split("/").some((seg) => seg === ".."),
      { message: "subfolder must not traverse" },
    )
    .optional(),
  type: z.enum(["output", "input", "temp"]),
});
export type GraphImageRef = z.infer<typeof GraphImageRefSchema>;

/** Graph-image payload: host reports the image(s) of a graph node */
export const GraphImagePayloadSchema = z.object({
  /** Echo of the request that asked for it (absent for selection pushes) */
  requestId: z.string().min(1).max(64).optional(),
  /** Graph node id, -1 when no image-bearing node was found */
  nodeId: z.number().int(),
  nodeType: z.string().max(200),
  nodeTitle: z.string().max(200),
  /** How the node was chosen */
  source: z.enum(["selection", "node", "latest", "none"]),
  images: z.array(GraphImageRefSchema).max(MAX_GRAPH_IMAGES),
});
export type GraphImagePayload = z.infer<typeof GraphImagePayloadSchema>;

/** Request-graph-image payload: overlay asks for a node's image */
export const RequestGraphImagePayloadSchema = z.object({
  requestId: z.string().min(1).max(64).optional(),
  /** Specific node; omitted = current selection, then the latest output */
  nodeId: z.number().int().min(0).optional(),
});
export type RequestGraphImagePayload = z.infer<
  typeof RequestGraphImagePayloadSchema
>;

/** API-format link value: [sourceNodeId, outputSlot]. */
export function isApiLink(value: unknown): value is [string | number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    (typeof value[0] === "string" || typeof value[0] === "number") &&
    Number.isInteger(value[1]) &&
    (value[1] as number) >= 0
  );
}

const ApiNodeSchema = z
  .object({
    class_type: z.string().min(1).max(200),
    inputs: z.record(z.unknown()),
    _meta: z
      .object({ title: z.string().max(200).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * API-format ("prompt") workflow: { [id]: { class_type, inputs } }.
 * Non-empty, bounded, and every link must point at a node in the workflow.
 */
export const ApiWorkflowSchema = z
  .record(ApiNodeSchema)
  .superRefine((wf, ctx) => {
    const ids = Object.keys(wf);
    if (ids.length === 0) {
      ctx.addIssue({ code: "custom", message: "workflow has no nodes" });
      return;
    }
    if (ids.length > MAX_INSERT_NODES) {
      ctx.addIssue({
        code: "custom",
        message: `workflow has ${ids.length} nodes (max ${MAX_INSERT_NODES})`,
      });
      return;
    }
    for (const id of ids) {
      for (const [name, value] of Object.entries(wf[id].inputs)) {
        if (isApiLink(value) && !(String(value[0]) in wf)) {
          ctx.addIssue({
            code: "custom",
            path: [id, "inputs", name],
            message: `links to missing node "${String(value[0])}"`,
          });
        }
      }
    }
  });
export type ApiWorkflow = z.infer<typeof ApiWorkflowSchema>;

/** Insert-api-workflow payload: overlay adds a tool graph to ComfyUI */
export const InsertApiWorkflowPayloadSchema = z.object({
  workflow: ApiWorkflowSchema,
  /** insert = add next to the current graph; replace = load as new graph */
  mode: z.enum(["insert", "replace"]).default("insert"),
  /** Label for the inserted group / loaded workflow */
  title: z.string().max(200).optional(),
  requestId: z.string().min(1).max(64).optional(),
  /** Switch to the graph view after inserting (default true) */
  reveal: z.boolean().optional(),
});
export type InsertApiWorkflowPayload = z.infer<
  typeof InsertApiWorkflowPayloadSchema
>;
export type InsertApiWorkflowInput = z.input<
  typeof InsertApiWorkflowPayloadSchema
>;

/** Graph-inserted payload: host reports the outcome of an insert */
export const GraphInsertedPayloadSchema = z.object({
  requestId: z.string().min(1).max(64).optional(),
  ok: z.boolean(),
  mode: z.enum(["insert", "replace"]),
  /** Ids of the nodes created in the host graph */
  nodeIds: z.array(z.number().int()).max(MAX_INSERT_NODES),
  /** Non-fatal problems (unknown node types, unmatched inputs, ...) */
  warnings: z.array(z.string().max(500)).max(50),
  error: z.string().max(500).optional(),
});
export type GraphInsertedPayload = z.infer<typeof GraphInsertedPayloadSchema>;

/** Annotated ComfyUI ref ("sub/name.png [output]") for a graph image. */
export function formatGraphImageRef(img: GraphImageRef): string {
  const sub = img.subfolder ? `${img.subfolder.replace(/\/+$/, "")}/` : "";
  return `${sub}${img.filename} [${img.type}]`;
}

/**
 * Parse a LoadImage-style widget value ("sub/name.png", "name.png [output]")
 * into a graph image ref. Mirrors parseImageWidgetValue in the host bridge.
 */
export function parseGraphImageWidgetValue(
  value: unknown,
  defaultType: GraphImageRef["type"] = "input",
): GraphImageRef | null {
  if (typeof value !== "string") return null;
  let raw = value.trim();
  if (!raw || raw.length > 400) return null;
  let type = defaultType;
  const m = /^(.*\S)\s*\[(input|output|temp)\]$/.exec(raw);
  if (m) {
    raw = m[1];
    type = m[2] as GraphImageRef["type"];
  }
  const segments = raw.split("/");
  const filename = segments.pop() ?? "";
  const ref = { filename, subfolder: segments.join("/"), type };
  return GraphImageRefSchema.safeParse(ref).success ? ref : null;
}

/** Same-origin proxy URL (GET /api/comfy/image) for a graph image. */
export function graphImageProxyUrl(img: GraphImageRef): string {
  const q = new URLSearchParams({
    filename: img.filename,
    subfolder: img.subfolder ?? "",
    type: img.type,
  });
  return `/api/comfy/image?${q.toString()}`;
}
// Envelope schema
/** Every postMessage from either side follows this envelope */
export const CjEnvelopeSchema = z.object({
  /** Protocol namespace prefix — always "cj:" */
  type: z.string().refine((t) => t.startsWith("cj:"), {
    message: "Message type must start with 'cj:' namespace",
  }),
  /** Typed payload matching the message type */
  payload: z.unknown(),
  /** Protocol version for forward compatibility */
  version: z.number().int().positive().optional(),
  /**
   * Nonce for this message — used for replay protection and ack correlation.
   * When present, the receiver should validate it matches an expected value
   * or store it for ack/NACK correlation.
   */
  nonce: z.string().min(1).optional(),
});
export type CjEnvelope = z.infer<typeof CjEnvelopeSchema>;

// Per-type envelope validation map
const TYPE_TO_PAYLOAD_SCHEMA: Record<string, z.ZodTypeAny> = {
  [HOST_MSG.CONFIG]: ConfigPayloadSchema,
  [HOST_MSG.PROGRESS]: ProgressPayloadSchema,
  [HOST_MSG.STATUS]: StatusPayloadSchema,
  [HOST_MSG.IMAGES]: ImagesPayloadSchema,
  [HOST_MSG.ERROR]: ErrorPayloadSchema,
  [HOST_MSG.VISIBILITY]: VisibilityPayloadSchema,
  [HOST_MSG.WORKFLOW]: WorkflowPayloadSchema,
  [OVERLAY_MSG.HELLO]: HelloPayloadSchema,
  [OVERLAY_MSG.READY]: ReadyPayloadSchema,
  [OVERLAY_MSG.RUN]: RunPayloadSchema,
  [OVERLAY_MSG.INTERRUPT]: InterruptPayloadSchema,
  [OVERLAY_MSG.ACK]: AckPayloadSchema,
  [OVERLAY_MSG.QUEUE]: QueuePayloadSchema,
  [OVERLAY_MSG.LOAD_WORKFLOW]: LoadWorkflowPayloadSchema,
  [OVERLAY_MSG.DRAG_IMAGE]: DragImagePayloadSchema,
  [HOST_MSG.SETTINGS_SYNC]: SettingsSyncPayloadSchema,
  [HOST_MSG.NODE_SELECTED]: NodeSelectedPayloadSchema,
  [OVERLAY_MSG.PING]: PingPayloadSchema,
  [HOST_MSG.PONG]: PongPayloadSchema,
  [HOST_MSG.GRAPH_IMAGE]: GraphImagePayloadSchema,
  [HOST_MSG.GRAPH_INSERTED]: GraphInsertedPayloadSchema,
  [OVERLAY_MSG.REQUEST_GRAPH_IMAGE]: RequestGraphImagePayloadSchema,
  [OVERLAY_MSG.INSERT_API_WORKFLOW]: InsertApiWorkflowPayloadSchema,
  [OVERLAY_MSG.SHOW_GRAPH]: ShowGraphPayloadSchema,
  [HOST_MSG.THEME]: ThemePayloadSchema,
  [HOST_MSG.LAYOUT]: LayoutPayloadSchema,
  [OVERLAY_MSG.SET_LAYOUT]: SetLayoutPayloadSchema,
};

// Parse & validate helpers
export interface ParseResult {
  ok: true;
  type: CjMessageType;
  payload: unknown;
  version?: number;
  nonce?: string;
}

export interface ParseError {
  ok: false;
  errors: z.ZodError[];
  rawType: string;
}

export type ParseOutcome = ParseResult | ParseError;

/**
 * Parse and validate an incoming postMessage data object.
 *
 * Returns { ok: true, type, payload, version?, nonce? } on success,
 * or { ok: false, errors, rawType } on validation failure.
 *
 * This is the main entry point for the bridge's receive path.
 * It is intentionally strict: unknown message types are rejected.
 */
export function parseCjMessage(data: unknown): ParseOutcome {
  const envelopeResult = CjEnvelopeSchema.safeParse(data);
  if (!envelopeResult.success) {
    return {
      ok: false,
      errors: [envelopeResult.error],
      rawType:
        typeof data === "object" && data !== null && "type" in data
          ? String((data as Record<string, unknown>).type)
          : "<missing>",
    };
  }

  const envelope = envelopeResult.data;
  const type = envelope.type as CjMessageType;

  const payloadSchema = TYPE_TO_PAYLOAD_SCHEMA[type];
  if (!payloadSchema) {
    return {
      ok: false,
      errors: [
        new z.ZodError([
          {
            code: "custom",
            path: ["type"],
            message: `Unknown message type "${type}"`,
          },
        ]),
      ],
      rawType: type,
    };
  }

  const payloadResult = payloadSchema.safeParse(envelope.payload);
  if (!payloadResult.success) {
    return {
      ok: false,
      errors: [payloadResult.error],
      rawType: type,
    };
  }

  return {
    ok: true,
    type,
    payload: payloadResult.data,
    version: envelope.version,
    nonce: envelope.nonce,
  };
}

// Build helpers
/**
 * Build a valid CjEnvelope for sending.
 * Throws if the payload doesn't match the expected schema for the type.
 *
 * @param type  Message type constant
 * @param payload  Payload data matching the type's schema
 * @param nonce  Optional nonce for replay protection / ack correlation
 */
export function buildCjMessage<T extends CjMessageType>(
  type: T,
  payload: unknown,
  nonce?: string,
): CjEnvelope {
  const payloadSchema = TYPE_TO_PAYLOAD_SCHEMA[type];
  if (!payloadSchema) {
    throw new Error(`Cannot build message for unknown type "${type}"`);
  }

  const payloadResult = payloadSchema.safeParse(payload);
  if (!payloadResult.success) {
    throw new Error(
      `Invalid payload for type "${type}": ${payloadResult.error.message}`,
    );
  }

  const envelope: CjEnvelope = {
    type,
    payload: payloadResult.data,
    version: CJ_PROTOCOL_VERSION,
  };
  if (nonce !== undefined) {
    envelope.nonce = nonce;
  }
  return envelope;
}

// Origin validation
/**
 * Validate that a postMessage origin is in the allowed set.
 *
 * IMPORTANT: By default NO origins are trusted. The bridge must
 * explicitly configure allowed origins at setup time. This ensures
 * the bridge cannot be spoofed by malicious iframes.
 */
export function validateOrigin(
  origin: string,
  allowedOrigins: readonly string[],
): { ok: true } | { ok: false; reason: string } {
  if (allowedOrigins.length === 0) {
    return {
      ok: false,
      reason: "No allowed origins configured — all origins rejected",
    };
  }

  // Exact match only — no wildcard, no substring
  const match = allowedOrigins.includes(origin);
  if (!match) {
    return {
      ok: false,
      reason: `Origin "${origin}" not in allowed list: [${allowedOrigins.join(", ")}]`,
    };
  }

  return { ok: true };
}

/**
 * Derive the default allowed origins for a given ComfyUI host.
 * In same-origin overlay mode, the overlay and host share the same origin.
 */
export function deriveSameOrigin(url: string): string {
  try {
    const u = new URL(url);
    return u.origin;
  } catch {
    return "";
  }
}

// Nonce / Session helpers (replay protection)
/**
 * Generate a session nonce. Uses crypto.randomUUID when available
 * (browser and Node 19+), falls back to Math.random for environments
 * without crypto.
 *
 * This function is deterministic for testing: inject a custom generator
 * via the parameter. In production, call without arguments.
 *
 * The nonce format is "cj_sn_" prefix + 24 hex chars, making it
 * easy to identify in logs and preventing accidental collisions with
 * other random identifiers.
 */
export function generateNonce(rng?: () => string): string {
  if (rng) {
    return `cj_sn_${rng()}`;
  }
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    const uuid = crypto.randomUUID().replace(/-/g, "");
    return `cj_sn_${uuid.slice(0, 24)}`;
  }
  const hexChars = "0123456789abcdef";
  let hex = "";
  for (let i = 0; i < 24; i++) {
    hex += hexChars[Math.floor(Math.random() * 16)];
  }
  return `cj_sn_${hex}`;
}

/**
 * Validate a nonce against an expected value.
 * Returns ok:true if the nonce matches, ok:false with a reason if not.
 *
 * Both values must be non-empty strings. If either is empty, validation fails.
 */
export function validateNonce(
  received: string | undefined,
  expected: string | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (!expected) {
    // No session nonce established yet — message is from an uninitiated session
    return {
      ok: false,
      reason: "No session nonce established — cannot validate",
    };
  }
  if (!received) {
    return {
      ok: false,
      reason: "Message missing nonce — replay protection requires it",
    };
  }
  if (received !== expected) {
    return {
      ok: false,
      reason: `Nonce mismatch: received "${received.slice(0, 8)}..." does not match session`,
    };
  }
  return { ok: true };
}

/**
 * Validate that a nonce has the expected "cj_sn_" prefix format.
 * This is a lightweight check that doesn't require knowing the expected
 * session nonce — useful for initial validation before checking against
 * the session.
 */
export function isNonceFormat(value: string): boolean {
  return (
    typeof value === "string" && value.startsWith("cj_sn_") && value.length >= 8
  );
}

// Version negotiation
/**
 * Result of a version negotiation check between a hello's version
 * and the host's supported range.
 */
export type VersionNegotiationResult =
  | { ok: true; negotiatedVersion: number }
  | {
      ok: false;
      reason: string;
      theirVersion: number;
      minVersion: number;
      maxVersion: number;
    };

/**
 * Negotiate a compatible protocol version.
 *
 * The host advertises a min and max supported version. The overlay
 * sends its version in the hello handshake. This function picks the
 * highest mutually-supported version.
 *
 * Returns:
 *   - ok:true with negotiatedVersion if a compatible version is found
 *   - ok:false with reason if no compatible version exists
 *
 * The negotiated version should be used for all subsequent messages
 * in the session.
 */
export function negotiateVersion(
  theirVersion: number,
  minVersion: number = CJ_MIN_SUPPORTED_VERSION,
  maxVersion: number = CJ_MAX_SUPPORTED_VERSION,
): VersionNegotiationResult {
  if (theirVersion < minVersion) {
    return {
      ok: false,
      reason: `Overlay version ${theirVersion} is below minimum supported version ${minVersion}`,
      theirVersion,
      minVersion,
      maxVersion,
    };
  }

  const negotiatedVersion = Math.min(theirVersion, maxVersion);

  return {
    ok: true,
    negotiatedVersion,
  };
}

// Structured event logging (audit trail)
export type BridgeLogLevel = "debug" | "info" | "warn" | "error";

export type BridgeEventDirection = "inbound" | "outbound" | "internal";

/**
 * A structured log entry for bridge events. These are purely data —
 * no side effects. The bridge (or tests) can collect these for audit,
 * debugging, or forwarding to telemetry.
 */
export interface BridgeEvent {
  /** ISO 8601 timestamp */
  timestamp: string;
  level: BridgeLogLevel;
  direction: BridgeEventDirection;
  /** Bridge session ID (if available) */
  sessionId?: string;
  /** Message type involved (if applicable) */
  messageType?: string;
  description: string;
  data?: Record<string, unknown>;
  /** Current bridge phase at time of event */
  phase?: string;
  /** Nonce involved (if applicable) */
  nonce?: string;
}

/**
 * Create a structured bridge event. Pure function — no side effects.
 *
 * This provides a structured, machine-readable audit trail that the
 * host bridge JS can use instead of ad-hoc console.log calls.
 * The bridge JS can format and emit these as it sees fit.
 */
export function createBridgeEvent(event: {
  level?: BridgeLogLevel;
  direction?: BridgeEventDirection;
  sessionId?: string;
  messageType?: string;
  description: string;
  data?: Record<string, unknown>;
  phase?: string;
  nonce?: string;
}): BridgeEvent {
  return {
    timestamp: new Date().toISOString(),
    level: event.level ?? "info",
    direction: event.direction ?? "internal",
    sessionId: event.sessionId,
    messageType: event.messageType,
    description: event.description,
    data: event.data,
    phase: event.phase,
    nonce: event.nonce,
  };
}

// Host bridge state surface
/**
 * The full state surface of the host-side bridge.
 *
 * This type models what the host-side bridge JS tracks, providing
 * a typed companion to the JS overlayState object. It includes:
 *   - The handshake FSM state (BridgeState)
 *   - Session tracking (nonce, clientId)
 *   - Origin allowlist (for audit/diagnostics)
 *   - Version negotiation result
 *   - Error buffer for recent errors
 *
 * This is a pure data type — the actual JS bridge maintains its own
 * mutable state, but this type documents the shape and can be used
 * in tests to assert expected state snapshots.
 */
export interface HostBridgeState {
  /** Handshake FSM state */
  fsm: BridgeState;
  /** Session nonce assigned during config handshake */
  sessionNonce?: string;
  /** Client ID assigned during config handshake */
  clientId?: string;
  /** Origin allowlist (for diagnostics — not mutable via this type) */
  allowedOrigins: readonly string[];
  /** Negotiated protocol version (set after hello) */
  negotiatedVersion?: number;
  /** Configuration received from the host, if any */
  config?: ConfigPayload;
  /** Whether the overlay is currently connected (iframe exists) */
  overlayConnected: boolean;
  /** Recent error descriptions (bounded buffer) */
  recentErrors: Array<{ timestamp: string; message: string }>;
}

/**
 * Create an initial HostBridgeState.
 * All fields start in their default/inert state.
 */
export function createInitialHostBridgeState(
  allowedOrigins: readonly string[] = [],
): HostBridgeState {
  return {
    fsm: { phase: "idle" },
    sessionNonce: undefined,
    clientId: undefined,
    allowedOrigins,
    negotiatedVersion: undefined,
    config: undefined,
    overlayConnected: false,
    recentErrors: [],
  };
}

export const MAX_RECENT_ERRORS = 10;

/**
 * Update HostBridgeState with an error entry.
 * Returns a new state object (immutable update).
 * Errors are capped at MAX_RECENT_ERRORS entries.
 */
export function pushHostBridgeError(
  state: HostBridgeState,
  message: string,
  timestamp?: string,
): HostBridgeState {
  const recentErrors = [
    ...state.recentErrors,
    { timestamp: timestamp ?? new Date().toISOString(), message },
  ].slice(-MAX_RECENT_ERRORS);

  return {
    ...state,
    recentErrors,
  };
}

// Inert bridge state machine (for testing / documentation)
/**
 * Represents the states of the bridge protocol handshake.
 * This is a pure data model — no IO, no mutations outside itself.
 */
export type BridgeState =
  | { phase: "idle" }
  | { phase: "hello-sent" }
  | { phase: "configured"; clientId: string }
  | { phase: "ready"; clientId: string }
  | { phase: "error"; error: string; previousPhase: string };

const VALID_TRANSITIONS: Record<string, string[]> = {
  idle: ["hello-sent"],
  "hello-sent": ["configured", "error"],
  configured: ["ready", "error"],
  ready: ["configured", "error"], // re-config allowed
  error: ["idle"], // reset
};

/**
 * Pure-function state transition for the bridge handshake FSM.
 * Returns the new state or throws if the transition is invalid.
 *
 * This exists so we can unit-test the handshake flow without
 * any real IO or iframe.
 */
export function transitionBridge(
  current: BridgeState,
  event: "send-hello" | "recv-config" | "recv-ready" | "recv-error" | "reset",
  payload?: unknown,
): BridgeState {
  const from = current.phase;
  const allowed = VALID_TRANSITIONS[from] ?? [];

  switch (event) {
    case "send-hello": {
      if (!allowed.includes("hello-sent")) break;
      return { phase: "hello-sent" };
    }
    case "recv-config": {
      if (!allowed.includes("configured")) break;
      const result = ConfigPayloadSchema.safeParse(payload);
      if (!result.success) {
        return {
          phase: "error",
          error: "Invalid config payload",
          previousPhase: from,
        };
      }
      return { phase: "configured", clientId: result.data.clientId };
    }
    case "recv-ready": {
      if (!allowed.includes("ready")) break;
      return {
        phase: "ready",
        clientId: (current as { clientId: string }).clientId,
      };
    }
    case "recv-error": {
      if (!allowed.includes("error")) break;
      const errorMsg = typeof payload === "string" ? payload : "Unknown error";
      return { phase: "error", error: errorMsg, previousPhase: from };
    }
    case "reset": {
      return { phase: "idle" };
    }
  }

  return {
    phase: "error",
    error: `Invalid transition: ${from} + ${event}`,
    previousPhase: from,
  };
}
