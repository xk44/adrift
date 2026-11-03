/**
 * Adrift Overlay Bridge — full-viewport or docked-panel iframe toggle
 *
 * ComfyUI web extension that creates a floating toggle button to swap
 * between the ComfyUI node graph and the Adrift UI (loaded in an
 * iframe). The iframe is created once and shown/hidden — never reloaded.
 * Layouts: "full" covers the viewport; "panel" docks a resizable panel on
 * the right over the canvas (width persisted). ComfyUI's palette mode
 * (light/dark) is posted to Adrift as cj:theme on open and on change.
 *
 * PROTOCOL: Message types mirror src/lib/overlay/protocol.ts.
 * The constants below are duplicated so this file runs without a bundler.
 *
 * TRUST BOUNDARY: postMessage handlers validate origin against an
 * explicit allowlist. The bridge does NOT execute workflow commands
 * or mutate the ComfyUI graph without explicit user intent.
 */

import { app } from "../../scripts/app.js";

// Protocol constants (mirror of src/lib/overlay/protocol.ts)
// Host → Overlay
const CJ_MSG_CONFIG = "cj:config";
const CJ_MSG_PROGRESS = "cj:progress";
const CJ_MSG_STATUS = "cj:status";
const CJ_MSG_IMAGES = "cj:images";
const CJ_MSG_ERROR = "cj:error";
const CJ_MSG_VISIBILITY = "cj:visibility";
const CJ_MSG_WORKFLOW = "cj:workflow";

// Overlay → Host
const CJ_MSG_HELLO = "cj:hello";
const CJ_MSG_READY = "cj:ready";
const CJ_MSG_RUN = "cj:run";
const CJ_MSG_INTERRUPT = "cj:interrupt";
const CJ_MSG_ACK = "cj:ack";
const CJ_MSG_QUEUE = "cj:queue";
const CJ_MSG_LOAD_WORKFLOW = "cj:load-workflow";
const CJ_MSG_DRAG_IMAGE = "cj:drag-image";
const CJ_MSG_SETTINGS_SYNC = "cj:settings-sync";
const CJ_MSG_NODE_SELECTED = "cj:node-selected";
const CJ_MSG_PING = "cj:ping";
const CJ_MSG_PONG = "cj:pong";
// Tools bridge (appended): graph images + API workflow insert
const CJ_MSG_GRAPH_IMAGE = "cj:graph-image";
const CJ_MSG_GRAPH_INSERTED = "cj:graph-inserted";
const CJ_MSG_REQUEST_GRAPH_IMAGE = "cj:request-graph-image";
const CJ_MSG_INSERT_API_WORKFLOW = "cj:insert-api-workflow";
const CJ_MSG_SHOW_GRAPH = "cj:show-graph";
// Layout + theme sync
const CJ_MSG_THEME = "cj:theme";
const CJ_MSG_LAYOUT = "cj:layout";
const CJ_MSG_SET_LAYOUT = "cj:set-layout";

const CJ_PROTOCOL_VERSION = 1;
const CJ_MIN_SUPPORTED_VERSION = 1;
const CJ_MAX_SUPPORTED_VERSION = 1;

// All known message types for validation
const KNOWN_MSG_TYPES = new Set([
  CJ_MSG_CONFIG,
  CJ_MSG_PROGRESS,
  CJ_MSG_STATUS,
  CJ_MSG_IMAGES,
  CJ_MSG_ERROR,
  CJ_MSG_VISIBILITY,
  CJ_MSG_WORKFLOW,
  CJ_MSG_HELLO,
  CJ_MSG_READY,
  CJ_MSG_RUN,
  CJ_MSG_INTERRUPT,
  CJ_MSG_ACK,
  CJ_MSG_QUEUE,
  CJ_MSG_LOAD_WORKFLOW,
  CJ_MSG_DRAG_IMAGE,
  CJ_MSG_SETTINGS_SYNC,
  CJ_MSG_NODE_SELECTED,
  CJ_MSG_PING,
  CJ_MSG_PONG,
  CJ_MSG_GRAPH_IMAGE,
  CJ_MSG_GRAPH_INSERTED,
  CJ_MSG_REQUEST_GRAPH_IMAGE,
  CJ_MSG_INSERT_API_WORKFLOW,
  CJ_MSG_SHOW_GRAPH,
  CJ_MSG_THEME,
  CJ_MSG_LAYOUT,
  CJ_MSG_SET_LAYOUT,
]);

// Configuration
const STORAGE_KEY = "adrift_overlay_visible";
const ADRIFT_URL_KEY = "adrift_overlay_url";
// Keys written by releases before the Adrift rename. Read as a fallback so an
// existing install keeps its saved URL / visibility; never written.
const LEGACY_STORAGE_KEY = "comfyjourney_overlay_visible"; // legacy-name
const LEGACY_URL_KEY = "comfyjourney_overlay_url"; // legacy-name
const DEFAULT_CJ_URL = "http://localhost:3000";
const LAYOUT_KEY = "adrift_overlay_layout";
const PANEL_WIDTH_KEY = "adrift_overlay_panel_width";
const DEFAULT_PANEL_WIDTH = 480;
const MIN_PANEL_WIDTH = 360;
/** Canvas strip always left visible beside a docked panel. */
const MIN_CANVAS_GUTTER = 160;

/** localStorage.getItem(primary), falling back to the pre-rename key. */
function readStoredSetting(primary, legacy) {
  const v = localStorage.getItem(primary);
  if (v !== null && v !== undefined) return v;
  return localStorage.getItem(legacy);
}

/**
 * Pack config written next to this file by Adrift's "Add Adrift to ComfyUI"
 * step (web/adrift_config.json: { "adriftUrl": "http://host:port" }), so the
 * overlay finds Adrift without the user typing its URL. ComfyUI serves it
 * from the pack's web dir; it is local disk, trusted like this script.
 */
const PACK_CONFIG_PATH = "/extensions/adrift_overlay/adrift_config.json";
let packConfigUrl = null;

async function loadPackConfig() {
  try {
    const path =
      typeof app?.api?.fileURL === "function"
        ? app.api.fileURL(PACK_CONFIG_PATH)
        : PACK_CONFIG_PATH;
    const resp = await fetch(path, { cache: "no-store" });
    if (!resp || !resp.ok) return null;
    const data = await resp.json();
    const url = sanitizeCjUrl(data && data.adriftUrl);
    if (url) packConfigUrl = url;
    return url;
  } catch {
    return null;
  }
}

/**
 * Get the Adrift app URL from (in priority order):
 * 1. URL query param ?cj_url=... (this host or loopback only)
 * 2. localStorage setting
 * 3. web/adrift_config.json (written by Adrift's install step)
 * 4. Default localhost:3000
 */
function getAdriftUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const paramUrl = sanitizeCjUrl(params.get("cj_url"));
    // A link can carry ?cj_url=, so only honor it for this host or loopback;
    // the framed page is trusted to queue prompts. Other hosts must be set
    // deliberately via localStorage.
    if (paramUrl && isLocalCjHost(paramUrl)) return paramUrl;
  } catch {
    /* ignore */
  }

  try {
    const stored = sanitizeCjUrl(
      readStoredSetting(ADRIFT_URL_KEY, LEGACY_URL_KEY),
    );
    if (stored) return stored;
  } catch {
    /* ignore */
  }

  if (packConfigUrl) return packConfigUrl;
  return DEFAULT_CJ_URL;
}

/**
 * Accept only absolute http(s) URLs. The value becomes iframe.src, so a
 * `javascript:` / `data:` URL from a crafted `?cj_url=` link would run
 * script in ComfyUI's origin.
 */
function sanitizeCjUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href;
  } catch {
    return null;
  }
}

function isLocalCjHost(url) {
  try {
    const host = new URL(url).hostname;
    return (
      host === window.location.hostname ||
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]"
    );
  } catch {
    return false;
  }
}

/**
 * Derive allowed origins from the configured Adrift URL + ComfyUI origin.
 */
function deriveAllowedOrigins() {
  const origins = new Set();
  try {
    const cjUrl = getAdriftUrl();
    origins.add(new URL(cjUrl).origin);
  } catch {
    /* ignore */
  }
  origins.add(window.location.origin);
  return [...origins];
}

// Origin validation
function isOriginAllowed(origin) {
  const allowed = deriveAllowedOrigins();
  return allowed.includes(origin);
}

// Nonce generation
function generateNonce() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    const uuid = crypto.randomUUID().replace(/-/g, "");
    return "cj_sn_" + uuid.slice(0, 24);
  }
  let hex = "";
  for (let i = 0; i < 24; i++) {
    hex += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  }
  return "cj_sn_" + hex;
}

function generateClientId() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return "cj_overlay_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  }
  let hex = "";
  for (let i = 0; i < 16; i++) {
    hex += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  }
  return "cj_overlay_" + hex;
}

// Version negotiation
function negotiateVersion(theirVersion) {
  if (theirVersion < CJ_MIN_SUPPORTED_VERSION) {
    return {
      ok: false,
      reason: `Overlay version ${theirVersion} is below minimum supported version ${CJ_MIN_SUPPORTED_VERSION}`,
    };
  }
  return {
    ok: true,
    negotiatedVersion: Math.min(theirVersion, CJ_MAX_SUPPORTED_VERSION),
  };
}

// Bridge state
const overlayState = {
  bridgePhase: "idle",
  sessionNonce: null,
  clientId: null,
  negotiatedVersion: null,
  overlayFrame: null,
  toggleBtn: null,
  overlayContainer: null,
  visible: false,
  overlayReady: false,
  /** Revision counter for workflow change detection */
  workflowRevision: 0,
  /** Last serialized workflow hash for change detection */
  lastWorkflowHash: null,
  /** Debounce timer for graph change detection */
  graphChangeTimer: null,
  /** Debounce timer for settings sync */
  settingsSyncTimer: null,
  /** Widget-value poll interval (cleared before re-arming) */
  graphPollTimer: null,
  /** Guards setup() against double invocation stacking listeners/intervals */
  setupDone: false,
  /** "full" (viewport) or "panel" (docked right) */
  layout: "full",
  /** Docked panel width in CSS px */
  panelWidth: DEFAULT_PANEL_WIDTH,
  /** Drag handle on the docked panel's left edge */
  resizeHandle: null,
  /** Last palette mode posted to the overlay ("light" | "dark" | null) */
  lastSentTheme: null,
  /** Debounce timer for palette change detection */
  themeTimer: null,
};

// Logging
function log(level, message, data) {
  const prefix = `[Adrift]`;
  if (level === "error") {
    console.error(prefix, message, data ?? "");
  } else if (level === "warn") {
    console.warn(prefix, message, data ?? "");
  } else {
    console.log(prefix, message, data ?? "");
  }
}

// Iframe creation
function createOverlayIframe() {
  if (overlayState.overlayFrame) return overlayState.overlayFrame;

  const cjUrl = getAdriftUrl();

  // Container div (full viewport, sits over ComfyUI canvas)
  const container = document.createElement("div");
  container.id = "adrift-overlay-container";
  container.style.cssText = [
    "position: fixed",
    "top: 0",
    "left: 0",
    "width: 100vw",
    "height: 100vh",
    "z-index: 9998",
    "display: none",
    "box-sizing: border-box",
    "background: #0d0e12",
  ].join(";");

  const iframe = document.createElement("iframe");
  iframe.id = "adrift-overlay-iframe";
  iframe.src = cjUrl;
  iframe.style.cssText = [
    "width: 100%",
    "height: 100%",
    "border: none",
    "background: #0d0e12",
  ].join(";");
  // clipboard-read: the editor's Paste button reads images from the clipboard.
  iframe.allow = "clipboard-read; clipboard-write";
  iframe.setAttribute("loading", "lazy");

  showIframeLoadingSpinner();
  iframe.addEventListener("load", () => {
    hideIframeLoadingSpinner();
  });

  container.appendChild(iframe);
  container.appendChild(createResizeHandle(container));
  document.body.appendChild(container);

  overlayState.overlayFrame = iframe;
  overlayState.overlayContainer = container;
  applyOverlayLayout();

  log("info", `Overlay iframe created, src=${cjUrl}`);
  return iframe;
}

// Toggle button creation
function createToggleButton() {
  if (overlayState.toggleBtn) return overlayState.toggleBtn;

  const btn = document.createElement("button");
  btn.id = "adrift-toggle-btn";

  // Polished dark theme button.
  // Default sits below ComfyUI's top menu bar on the right — the bottom-right
  // corner is occupied by ComfyUI 0.24+'s zoom/queue button cluster.
  // Draggable; last position persists in localStorage.
  btn.style.cssText = [
    "position: fixed",
    "top: 56px",
    "right: 20px",
    "z-index: 10000",
    "padding: 10px 18px",
    "border: 1px solid rgba(255,255,255,0.15)",
    "border-radius: 12px",
    "background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)",
    "color: #e0e0e0",
    "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    "font-size: 13px",
    "font-weight: 600",
    "cursor: pointer",
    "display: flex",
    "align-items: center",
    "gap: 8px",
    "box-shadow: 0 4px 16px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.05) inset",
    "transition: all 0.2s ease",
    "user-select: none",
    "white-space: nowrap",
  ].join(";");

  btn.addEventListener("mouseenter", () => {
    btn.style.background = "linear-gradient(135deg, #252547 0%, #1e2d50 100%)";
    btn.style.borderColor = "rgba(255,255,255,0.25)";
    btn.style.transform = "translateY(-1px)";
    btn.style.boxShadow =
      "0 6px 20px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08) inset";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.background = "linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)";
    btn.style.borderColor = "rgba(255,255,255,0.15)";
    btn.style.transform = "translateY(0)";
    btn.style.boxShadow =
      "0 4px 16px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.05) inset";
  });

  // Drag to reposition (click still toggles). Position persists across
  // sessions so the button can be moved off anything it collides with.
  const POS_KEY = "cj_overlay_btn_pos";
  let dragMoved = false;
  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) || "null");
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      btn.style.top = `${saved.y}px`;
      btn.style.left = `${saved.x}px`;
      btn.style.right = "auto";
    }
  } catch {
    /* ignore corrupt saved position */
  }
  btn.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragMoved = false;
    const startX = e.clientX;
    const startY = e.clientY;
    const rect = btn.getBoundingClientRect();
    const onMove = (ev) => {
      if (
        !dragMoved &&
        Math.abs(ev.clientX - startX) < 4 &&
        Math.abs(ev.clientY - startY) < 4
      )
        return;
      dragMoved = true;
      const x = Math.min(
        Math.max(0, rect.left + (ev.clientX - startX)),
        window.innerWidth - rect.width,
      );
      const y = Math.min(
        Math.max(0, rect.top + (ev.clientY - startY)),
        window.innerHeight - rect.height,
      );
      btn.style.left = `${x}px`;
      btn.style.top = `${y}px`;
      btn.style.right = "auto";
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (dragMoved) {
        const r = btn.getBoundingClientRect();
        try {
          localStorage.setItem(
            POS_KEY,
            JSON.stringify({ x: r.left, y: r.top }),
          );
        } catch {
          /* storage full — position just won't persist */
        }
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // A cancelled pointer (touch scroll, pen leaving range, OS gesture) never
    // fires pointerup; without this the move listener stays attached forever.
    window.addEventListener("pointercancel", onUp);
  });

  btn.addEventListener("click", () => {
    if (dragMoved) return; // drag release, not a click
    toggleOverlay();
  });

  updateButtonLabel(btn, false);
  document.body.appendChild(btn);
  overlayState.toggleBtn = btn;

  log("info", "Toggle button created");
  return btn;
}

// Button label/icon
function updateButtonLabel(btn, showingCJ) {
  if (showingCJ) {
    // Adrift is visible, button says "Show ComfyUI"
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <circle cx="12" cy="12" r="3"/>
        <line x1="3" y1="12" x2="9" y2="12"/>
        <line x1="15" y1="12" x2="21" y2="12"/>
        <line x1="12" y1="3" x2="12" y2="9"/>
        <line x1="12" y1="15" x2="12" y2="21"/>
      </svg>
      ComfyUI`;
  } else {
    // ComfyUI is visible, button says "Adrift"
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z"/>
        <path d="M2 17l10 5 10-5"/>
        <path d="M2 12l10 5 10-5"/>
      </svg>
      Adrift`;
  }
}

// Show/hide the overlay
function toggleOverlay() {
  const newVisible = !overlayState.visible;
  setOverlayVisible(newVisible);
}

function setOverlayVisible(visible) {
  if (!overlayState.overlayFrame) {
    createOverlayIframe();
  }

  overlayState.visible = visible;
  overlayState.overlayContainer.style.display = visible ? "block" : "none";
  updateButtonLabel(overlayState.toggleBtn, visible);
  // The overlay has its own "back to ComfyUI" affordance — hide the floating
  // toggle while it is open so it doesn't sit on top of Adrift's status bar.
  if (overlayState.toggleBtn) {
    overlayState.toggleBtn.style.display = visible ? "none" : "flex";
  }

  try {
    localStorage.setItem(STORAGE_KEY, visible ? "1" : "0");
  } catch {
    /* ignore */
  }

  sendToOverlay({
    type: CJ_MSG_VISIBILITY,
    payload: { visible },
    version: CJ_PROTOCOL_VERSION,
    nonce: overlayState.sessionNonce,
  });
  // Re-read the palette on open; it may have changed while hidden.
  if (visible) sendThemeToOverlay(true);

  log("info", `Overlay ${visible ? "shown" : "hidden"}`);
}

// Send message to overlay iframe
function sendToOverlay(message) {
  if (!overlayState.overlayFrame?.contentWindow) return;

  const cjUrl = getAdriftUrl();
  let targetOrigin;
  try {
    targetOrigin = new URL(cjUrl).origin;
  } catch {
    log("warn", "Cannot derive target origin from Adrift URL, skipping send");
    return;
  }

  // Before the first hello there is no session nonce. The envelope schema
  // rejects `nonce: null`, so omit the field instead of sending null.
  if (message && message.nonce == null) {
    const { nonce: _omit, ...rest } = message;
    message = rest;
  }

  try {
    overlayState.overlayFrame.contentWindow.postMessage(message, targetOrigin);
  } catch (e) {
    // DataCloneError (non-cloneable widget value) must not break the
    // LiteGraph/api callback that triggered this send.
    log("warn", "Failed to post message to overlay", e);
  }
}

// Send config handshake to overlay
function sendConfigToOverlay() {
  if (!overlayState.overlayFrame?.contentWindow) return;

  overlayState.sessionNonce = generateNonce();
  overlayState.clientId = overlayState.clientId || generateClientId();

  // location.host keeps the default port implicit (an https ComfyUI on 443
  // must not become :8188) and brackets IPv6 hosts.
  const secure = window.location.protocol === "https:";
  const config = {
    type: CJ_MSG_CONFIG,
    payload: {
      comfyUrl: `${window.location.protocol}//${window.location.host}`,
      wsUrl: `${secure ? "wss" : "ws"}://${window.location.host}`,
      clientId: overlayState.clientId,
      mode: "overlay",
      version: overlayState.negotiatedVersion ?? CJ_PROTOCOL_VERSION,
      nonce: overlayState.sessionNonce,
    },
    version: CJ_PROTOCOL_VERSION,
    nonce: overlayState.sessionNonce,
  };

  sendToOverlay(config);
  overlayState.bridgePhase = "configured";
  log("info", "Sent config to overlay");
  // Session-scoped state the new overlay document needs right away.
  sendLayoutToOverlay();
  sendThemeToOverlay(true);
}

// Send current workflow to overlay
/**
 * Best-effort human-readable name of the active workflow across ComfyUI
 * frontend generations (workflowStore → legacy workflowManager → none).
 */
function getActiveWorkflowName() {
  try {
    const wf =
      app.extensionManager?.workflow?.activeWorkflow ??
      app.workflowManager?.activeWorkflow;
    const raw = wf?.filename ?? wf?.name ?? wf?.path;
    if (typeof raw === "string" && raw.trim()) {
      return raw
        .split("/")
        .pop()
        .replace(/\.json$/i, "");
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function sendWorkflowToOverlay() {
  if (!overlayState.overlayFrame?.contentWindow || !overlayState.overlayReady)
    return;

  try {
    const workflow = app.graph.serialize();
    // Record the hash so the change poller doesn't immediately resend the
    // same graph under a bumped revision (which the overlay could read as
    // a remote edit and raise a sync conflict for).
    overlayState.lastWorkflowHash = quickHash(workflow);
    sendToOverlay({
      type: CJ_MSG_WORKFLOW,
      payload: {
        workflow,
        revision: overlayState.workflowRevision,
        name: getActiveWorkflowName(),
      },
      version: CJ_PROTOCOL_VERSION,
      nonce: overlayState.sessionNonce,
    });
  } catch (e) {
    log("warn", "Failed to serialize workflow for overlay", e);
  }
}

// Handle messages from overlay iframe
function handleMessageFromOverlay(event) {
  // Only our own iframe may drive the bridge. Origin alone is not enough:
  // the allowlist includes ComfyUI's own origin, so any same-origin frame
  // or popup could otherwise queue prompts or replace the graph.
  const frameWindow = overlayState.overlayFrame?.contentWindow;
  if (!frameWindow || event.source !== frameWindow) return;
  if (!isOriginAllowed(event.origin)) return;

  const { type, payload } = event.data ?? {};
  if (!type || typeof type !== "string" || !type.startsWith("cj:")) return;

  // Handle toggle-back request from overlay (not in the formal protocol)
  if (type === "cj:toggle") {
    if (payload?.visible === false) {
      setOverlayVisible(false);
    }
    return;
  }

  if (!KNOWN_MSG_TYPES.has(type)) return;

  // Only handle overlay→host messages
  const overlayToHostTypes = new Set([
    CJ_MSG_HELLO,
    CJ_MSG_READY,
    CJ_MSG_RUN,
    CJ_MSG_INTERRUPT,
    CJ_MSG_ACK,
    CJ_MSG_QUEUE,
    CJ_MSG_IMAGES, // CJ can send generated images back
    CJ_MSG_LOAD_WORKFLOW,
    CJ_MSG_DRAG_IMAGE,
    CJ_MSG_PING,
    CJ_MSG_REQUEST_GRAPH_IMAGE,
    CJ_MSG_INSERT_API_WORKFLOW,
    CJ_MSG_SHOW_GRAPH,
    CJ_MSG_SET_LAYOUT,
  ]);
  if (!overlayToHostTypes.has(type)) return;

  // Graph-replacing / view-switching requests must carry this session's nonce.
  if (
    (type === CJ_MSG_LOAD_WORKFLOW ||
      type === CJ_MSG_SHOW_GRAPH ||
      type === CJ_MSG_SET_LAYOUT) &&
    (!overlayState.sessionNonce || event.data?.nonce !== overlayState.sessionNonce)
  ) {
    log("warn", `Dropped ${type}: missing or stale session nonce`);
    return;
  }

  switch (type) {
    case CJ_MSG_HELLO: {
      const helloVersion = payload?.version;
      if (typeof helloVersion === "number") {
        const neg = negotiateVersion(helloVersion);
        if (neg.ok) {
          overlayState.negotiatedVersion = neg.negotiatedVersion;
          log(
            "info",
            `Overlay HELLO (v${helloVersion}, negotiated v${neg.negotiatedVersion})`,
          );
        } else {
          overlayState.bridgePhase = "error";
          log("warn", `Version negotiation failed: ${neg.reason}`);
          return;
        }
      }
      // A hello means a fresh overlay document (first load, reload, or
      // in-iframe navigation). Hold workflow/selection pushes until its
      // cj:ready, which resends the current workflow.
      overlayState.overlayReady = false;
      overlayState.bridgePhase = "hello-sent";
      sendConfigToOverlay();
      break;
    }

    case CJ_MSG_SET_LAYOUT:
      if (payload?.layout === "full" || payload?.layout === "panel") {
        setOverlayLayout(payload.layout);
      }
      break;

    case CJ_MSG_READY:
      overlayState.bridgePhase = "ready";
      overlayState.overlayReady = true;
      log("info", "Overlay ready");
      // Send current workflow when overlay becomes ready
      sendWorkflowToOverlay();
      break;

    case CJ_MSG_QUEUE: {
      // Overlay wants to queue a prompt via ComfyUI
      log("info", "Overlay requested prompt queue", payload);
      if (payload?.prompt && typeof payload.prompt === "object") {
        queuePromptFromOverlay(payload.prompt);
      } else {
        sendToOverlay({
          type: CJ_MSG_ERROR,
          payload: {
            code: "QUEUE_FAILED",
            message: "Invalid prompt: expected an API-format JSON object",
          },
          version: CJ_PROTOCOL_VERSION,
          nonce: overlayState.sessionNonce,
        });
      }
      break;
    }

    case CJ_MSG_RUN:
      log("info", "Overlay requested workflow run", payload);
      break;

    case CJ_MSG_INTERRUPT:
      log("info", "Overlay requested interrupt");
      interruptFromOverlay();
      break;

    case CJ_MSG_ACK:
      log("info", "Overlay ACK", payload);
      break;

    case CJ_MSG_IMAGES: {
      // Overlay sent generated images — load the first into ComfyUI preview
      log("info", "Overlay sent images", payload);
      if (payload?.images?.length > 0) {
        loadImagePreview(payload.images[0]);
        updateToggleGlow(false);
      }
      break;
    }

    case CJ_MSG_LOAD_WORKFLOW: {
      // Overlay sends a workflow for loading into ComfyUI's graph editor
      log("info", "Overlay requested workflow load");
      if (payload?.workflow) {
        loadWorkflowFromOverlay(payload.workflow, payload.name);
      }
      break;
    }

    case CJ_MSG_SHOW_GRAPH:
      setOverlayVisible(false);
      break;

    case CJ_MSG_DRAG_IMAGE: {
      // Overlay sends an image to create a LoadImage node in the graph
      log("info", "Overlay sent drag-image", payload);
      if (payload?.filename) {
        createLoadImageNode(payload.filename, payload.subfolder, payload.type);
      }
      break;
    }

    case CJ_MSG_REQUEST_GRAPH_IMAGE: {
      const requestId = cleanRequestId(payload?.requestId);
      const nodeId = Number.isInteger(payload?.nodeId)
        ? payload.nodeId
        : undefined;
      const found = findGraphImage(nodeId);
      sendGraphImage(found.node, found.source, found.images, requestId);
      break;
    }

    case CJ_MSG_INSERT_API_WORKFLOW: {
      log("info", "Overlay requested API workflow insert");
      void handleInsertApiWorkflow(payload ?? {});
      break;
    }

    case CJ_MSG_PING: {
      // Respond with pong echoing the timestamp for latency measurement
      sendToOverlay({
        type: CJ_MSG_PONG,
        payload: { timestamp: payload?.timestamp ?? Date.now() },
        version: CJ_PROTOCOL_VERSION,
        nonce: overlayState.sessionNonce,
      });
      break;
    }
  }
}

// ComfyUI API interactions
async function queuePromptFromOverlay(prompt) {
  try {
    const resp = await fetch("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, client_id: overlayState.clientId }),
    });
    const data = await resp.json().catch(() => ({}));
    // ComfyUI answers a rejected graph with HTTP 400 + { error, node_errors }
    // and no prompt_id. That is a failure, not an accepted queue.
    if (!resp.ok || typeof data?.prompt_id !== "string" || !data.prompt_id) {
      const reason =
        data?.error?.message ||
        (typeof data?.error === "string" ? data.error : "") ||
        `ComfyUI /prompt returned HTTP ${resp.status}`;
      throw new Error(reason);
    }
    log("info", "Prompt queued from overlay", { promptId: data.prompt_id });

    sendToOverlay({
      type: CJ_MSG_ACK,
      payload: {
        ackType: CJ_MSG_QUEUE,
        accepted: true,
        promptId: data.prompt_id,
      },
      version: CJ_PROTOCOL_VERSION,
      nonce: overlayState.sessionNonce,
    });
  } catch (e) {
    log("error", "Failed to queue prompt from overlay", e);
    sendToOverlay({
      type: CJ_MSG_ERROR,
      payload: { code: "QUEUE_FAILED", message: String(e) },
      version: CJ_PROTOCOL_VERSION,
      nonce: overlayState.sessionNonce,
    });
  }
}

async function interruptFromOverlay() {
  try {
    await fetch("/interrupt", { method: "POST" });
    log("info", "Interrupt sent from overlay");
  } catch (e) {
    log("error", "Failed to send interrupt", e);
  }
}

// Load workflow from overlay
/**
 * Load a workflow JSON into ComfyUI's graph editor.
 * Called when the overlay sends cj:load-workflow.
 */
function sanitizeWorkflowName(name) {
  if (typeof name !== "string") return null;
  const clean = name.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean || clean.length > 256) return null;
  if (clean.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    return null;
  }
  return clean;
}

function isApiFormatWorkflow(workflow) {
  if (Array.isArray(workflow.nodes)) return false;
  const first = Object.entries(workflow).find(([k]) => !k.startsWith("_"))?.[1];
  return !!first && typeof first === "object" && "class_type" in first;
}

// The workflow-tab frontend opens a named load in its own tab (the current
// graph stays in its tab), so only the legacy single-graph UI needs a confirm.
function confirmReplaceGraph(name) {
  if (app.extensionManager?.workflow) return true;
  const nodeCount = app.graph?._nodes?.length ?? app.graph?.nodes?.length ?? 0;
  if (!nodeCount || typeof window.confirm !== "function") return true;
  return window.confirm(
    `Replace the current graph with ${name || "this workflow"}? Unsaved changes will be lost.`,
  );
}

function loadWorkflowFromOverlay(workflow, rawName) {
  try {
    if (!workflow || typeof workflow !== "object") {
      log("warn", "Invalid workflow data received — not an object");
      sendToOverlay({
        type: CJ_MSG_ERROR,
        payload: {
          code: "LOAD_WORKFLOW_FAILED",
          message: "Invalid workflow data: expected a JSON object",
        },
        version: CJ_PROTOCOL_VERSION,
        nonce: overlayState.sessionNonce,
      });
      return;
    }
    const name = sanitizeWorkflowName(rawName);
    if (!confirmReplaceGraph(name)) {
      sendToOverlay({
        type: CJ_MSG_ACK,
        payload: { ackType: CJ_MSG_LOAD_WORKFLOW, accepted: false, error: "Cancelled" },
        version: CJ_PROTOCOL_VERSION,
        nonce: overlayState.sessionNonce,
      });
      return;
    }
    const apiFormat = isApiFormatWorkflow(workflow);
    if (apiFormat && typeof app.loadApiJson === "function") {
      void Promise.resolve(app.loadApiJson(workflow, name ?? undefined)).catch((e) =>
        log("error", "loadApiJson failed", e),
      );
      log("info", "API workflow loaded into ComfyUI graph from overlay");
      sendToOverlay({
        type: CJ_MSG_ACK,
        payload: { ackType: CJ_MSG_LOAD_WORKFLOW, accepted: true },
        version: CJ_PROTOCOL_VERSION,
        nonce: overlayState.sessionNonce,
      });
    } else if (typeof app.loadGraphData === "function") {
      // A name opens/reuses the saved user workflow's tab (workflows/<name>).
      void Promise.resolve(
        name ? app.loadGraphData(workflow, true, true, name) : app.loadGraphData(workflow),
      ).catch((e) => log("error", "loadGraphData failed", e));
      log("info", "Workflow loaded into ComfyUI graph from overlay");
      sendToOverlay({
        type: CJ_MSG_ACK,
        payload: {
          ackType: CJ_MSG_LOAD_WORKFLOW,
          accepted: true,
        },
        version: CJ_PROTOCOL_VERSION,
        nonce: overlayState.sessionNonce,
      });
    } else {
      log("warn", "app.loadGraphData not available — cannot load workflow");
      sendToOverlay({
        type: CJ_MSG_ERROR,
        payload: {
          code: "LOAD_WORKFLOW_FAILED",
          message: "app.loadGraphData is not available in this ComfyUI version",
        },
        version: CJ_PROTOCOL_VERSION,
        nonce: overlayState.sessionNonce,
      });
    }
  } catch (e) {
    log("error", "Failed to load workflow from overlay", e);
    sendToOverlay({
      type: CJ_MSG_ERROR,
      payload: { code: "LOAD_WORKFLOW_FAILED", message: String(e) },
      version: CJ_PROTOCOL_VERSION,
      nonce: overlayState.sessionNonce,
    });
  }
}

// Create LoadImage node from overlay drag
/**
 * Create a LoadImage node in the ComfyUI graph with the given image filename.
 * Called when the overlay sends cj:drag-image.
 */
function createLoadImageNode(filename, subfolder, imageType) {
  try {
    const graph = app.graph;
    if (!graph) {
      log("warn", "ComfyUI graph not available — cannot create LoadImage node");
      return;
    }

    const node = LiteGraph.createNode("LoadImage");
    if (!node) {
      log("warn", "Could not create LoadImage node type");
      return;
    }

    // Position near center of current view
    const canvas = app.canvas;
    const cx = canvas
      ? (canvas.ds?.offset?.[0] ?? 0) * -1 + canvas.canvas.width / 2
      : 300;
    const cy = canvas
      ? (canvas.ds?.offset?.[1] ?? 0) * -1 + canvas.canvas.height / 2
      : 300;
    node.pos = [cx - 100, cy - 50];

    graph.add(node);

    const imageWidget = node.widgets?.find((w) => w.name === "image");
    if (imageWidget) {
      const imgPath =
        subfolder && subfolder !== "" ? `${subfolder}/${filename}` : filename;
      imageWidget.value = imgPath;
    }

    graph.setDirtyCanvas(true, true);
    log("info", `LoadImage node created for: ${filename}`);
  } catch (e) {
    log("error", "Failed to create LoadImage node from overlay", e);
  }
}

// Image preview loading
/**
 * Load an output image into ComfyUI's image preview area (if available).
 */
function loadImagePreview(imageInfo) {
  if (!imageInfo?.filename) return;

  const previewUrl = `/view?filename=${encodeURIComponent(imageInfo.filename)}&subfolder=${encodeURIComponent(imageInfo.subfolder || "")}&type=${encodeURIComponent(imageInfo.type || "output")}`;

  log("info", `Image preview available: ${previewUrl}`);

  // Dispatch a custom event that custom nodes can listen for
  const detail = { url: previewUrl, ...imageInfo };
  window.dispatchEvent(new CustomEvent("adrift:image-output", { detail }));
  // Pre-rename event name, kept for listeners written against older releases.
  window.dispatchEvent(
    new CustomEvent("comfyjourney:image-output", { detail }), // legacy-name
  );
}

// Toggle button glow for active jobs
function updateToggleGlow(active) {
  if (!overlayState.toggleBtn) return;
  if (active) {
    overlayState.toggleBtn.style.boxShadow =
      "0 4px 16px rgba(0,0,0,0.4), 0 0 12px rgba(99,140,255,0.5), 0 0 0 1px rgba(99,140,255,0.3) inset";
    overlayState.toggleBtn.style.borderColor = "rgba(99,140,255,0.5)";
  } else {
    overlayState.toggleBtn.style.boxShadow =
      "0 4px 16px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.05) inset";
    overlayState.toggleBtn.style.borderColor = "rgba(255,255,255,0.15)";
  }
}

// Loading spinner for iframe
function showIframeLoadingSpinner() {
  if (!overlayState.toggleBtn) return;

  const spinner = document.createElement("span");
  spinner.id = "cj-iframe-spinner";
  spinner.style.cssText = [
    "display: inline-block",
    "width: 12px",
    "height: 12px",
    "border: 2px solid rgba(255,255,255,0.2)",
    "border-top-color: rgba(255,255,255,0.8)",
    "border-radius: 50%",
    "animation: cj-spin 0.6s linear infinite",
  ].join(";");
  overlayState.toggleBtn.appendChild(spinner);

  if (!document.getElementById("cj-spinner-style")) {
    const style = document.createElement("style");
    style.id = "cj-spinner-style";
    style.textContent =
      "@keyframes cj-spin { to { transform: rotate(360deg); } }";
    document.head.appendChild(style);
  }
}

function hideIframeLoadingSpinner() {
  const spinner = document.getElementById("cj-iframe-spinner");
  if (spinner) spinner.remove();
}

// ComfyUI execution event forwarding
function setupExecutionForwarding() {
  const api = app.api;
  if (!api) {
    log("warn", "ComfyUI api not available for execution forwarding");
    return;
  }

  api.addEventListener("progress", (event) => {
    const detail = event.detail ?? {};
    updateToggleGlow(true);
    // The overlay schema wants int value/max and an int nodeId. Subgraph
    // node ids ("12:5") become NaN under Number() and would get the whole
    // progress message rejected, so drop nodeId instead.
    const nodeId = detail.node != null ? Number(detail.node) : NaN;
    const max = Math.max(1, Math.round(Number(detail.max) || 1));
    sendToOverlay({
      type: CJ_MSG_PROGRESS,
      payload: {
        promptId: detail.prompt_id || "unknown",
        value: Math.max(0, Math.round(Number(detail.value) || 0)),
        max,
        ...(Number.isInteger(nodeId) ? { nodeId } : {}),
      },
      version: CJ_PROTOCOL_VERSION,
      nonce: overlayState.sessionNonce,
    });
  });

  api.addEventListener("executed", (event) => {
    const detail = event.detail ?? {};
    const output = detail.output ?? {};
    // One entry without a filename (or with an unknown type) would fail the
    // overlay's schema and drop the whole batch, so filter per image.
    const images = (Array.isArray(output.images) ? output.images : [])
      .filter((img) => img && typeof img.filename === "string" && img.filename)
      .map((img) => ({
        filename: img.filename,
        subfolder: typeof img.subfolder === "string" ? img.subfolder : "",
        type: ["output", "input", "temp"].includes(img.type)
          ? img.type
          : "output",
      }));

    if (images.length > 0) {
      sendToOverlay({
        type: CJ_MSG_IMAGES,
        payload: {
          promptId: detail.prompt_id || "unknown",
          images,
        },
        version: CJ_PROTOCOL_VERSION,
        nonce: overlayState.sessionNonce,
      });
      updateToggleGlow(false);
    }
  });

  api.addEventListener("status", (event) => {
    const detail = event.detail ?? {};
    const queueRemaining =
      detail.exec_info?.queue_remaining ??
      detail.status?.exec_info?.queue_remaining;
    if (queueRemaining != null) {
      sendToOverlay({
        type: CJ_MSG_STATUS,
        payload: { queueRemaining },
        version: CJ_PROTOCOL_VERSION,
        nonce: overlayState.sessionNonce,
      });
      if (queueRemaining === 0) {
        updateToggleGlow(false);
      }
    }
  });

  log("info", "Execution event forwarding set up");
}

// Restore persisted visibility
function restoreVisibility() {
  try {
    const stored = readStoredSetting(STORAGE_KEY, LEGACY_STORAGE_KEY);
    if (stored === "1") {
      // Delay slightly to let ComfyUI finish loading
      requestAnimationFrame(() => {
        setOverlayVisible(true);
      });
    }
  } catch {
    /* ignore */
  }
}

// Graph change detection (real-time sync)
/**
 * Simple hash of a serialized workflow for fast change detection.
 * Not cryptographic — just needs to detect differences.
 */
function quickHash(obj) {
  const str = JSON.stringify(obj);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return hash;
}

/**
 * Check if the graph has changed and send the updated workflow to overlay.
 * Debounced — called from graph change events or polling.
 */
function onGraphChanged() {
  if (overlayState.graphChangeTimer) {
    clearTimeout(overlayState.graphChangeTimer);
  }
  overlayState.graphChangeTimer = setTimeout(() => {
    overlayState.graphChangeTimer = null;
    if (!overlayState.overlayReady) return;

    try {
      const workflow = app.graph.serialize();
      const hash = quickHash(workflow);
      if (hash === overlayState.lastWorkflowHash) return;

      overlayState.lastWorkflowHash = hash;
      overlayState.workflowRevision++;

      sendToOverlay({
        type: CJ_MSG_WORKFLOW,
        payload: {
          workflow,
          revision: overlayState.workflowRevision,
          name: getActiveWorkflowName(),
        },
        version: CJ_PROTOCOL_VERSION,
        nonce: overlayState.sessionNonce,
      });

      // Also extract and sync settings from KSampler-type nodes
      syncSettingsFromGraph(workflow);
    } catch (e) {
      log("warn", "Failed to detect graph change", e);
    }
  }, 500);
}

/**
 * Keep only fields whose values satisfy SettingsSyncPayloadSchema. Widget
 * values can be null/strings when an input is converted or linked, and one
 * bad field would get the whole settings-sync message rejected.
 */
function sanitizeSyncedSettings(settings) {
  const out = {};
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const isPosInt = (v) => Number.isInteger(v) && v > 0;
  for (const key of ["sampler", "scheduler", "model"]) {
    if (typeof settings[key] === "string") out[key] = settings[key];
  }
  for (const key of ["positivePrompt", "negativePrompt"]) {
    if (typeof settings[key] === "string") out[key] = settings[key];
  }
  for (const key of ["steps", "width", "height"]) {
    if (isPosInt(settings[key])) out[key] = settings[key];
  }
  if (isNum(settings.cfg) && settings.cfg > 0) out.cfg = settings.cfg;
  if (isNum(settings.seed)) out.seed = settings.seed;
  if (
    isNum(settings.denoise) &&
    settings.denoise >= 0 &&
    settings.denoise <= 1
  ) {
    out.denoise = settings.denoise;
  }
  return out;
}

/**
 * Extract sampler/model settings from workflow nodes and send to overlay.
 */
function syncSettingsFromGraph(workflow) {
  if (overlayState.settingsSyncTimer) {
    clearTimeout(overlayState.settingsSyncTimer);
  }
  overlayState.settingsSyncTimer = setTimeout(() => {
    overlayState.settingsSyncTimer = null;
    try {
      const settings = {};
      const nodes = workflow?.nodes ?? [];
      for (const node of nodes) {
        const type = node.type ?? "";
        const widgets = node.widgets_values ?? [];

        // KSampler variants
        if (
          type === "KSampler" ||
          type === "KSamplerAdvanced" ||
          type.includes("KSampler")
        ) {
          // KSampler widget order: seed, control_after_generate, steps, cfg, sampler_name, scheduler, denoise
          if (type === "KSampler" && widgets.length >= 7) {
            settings.seed = widgets[0];
            settings.steps = widgets[2];
            settings.cfg = widgets[3];
            settings.sampler = widgets[4];
            settings.scheduler = widgets[5];
            settings.denoise = widgets[6];
          }
        }

        // Checkpoint loader
        if (type === "CheckpointLoaderSimple" && widgets.length >= 1) {
          settings.model = widgets[0];
        }

        // Empty latent image (dimensions)
        if (type === "EmptyLatentImage" && widgets.length >= 3) {
          settings.width = widgets[0];
          settings.height = widgets[1];
        }

        // CLIP Text Encode (prompts)
        if (type === "CLIPTextEncode" && widgets.length >= 1) {
          const title = (node.title ?? "").toLowerCase();
          if (title.includes("positive") || title.includes("prompt")) {
            settings.positivePrompt = widgets[0];
          } else if (title.includes("negative")) {
            settings.negativePrompt = widgets[0];
          }
        }
      }

      const clean = sanitizeSyncedSettings(settings);
      if (Object.keys(clean).length > 0) {
        sendToOverlay({
          type: CJ_MSG_SETTINGS_SYNC,
          payload: { revision: overlayState.workflowRevision, ...clean },
          version: CJ_PROTOCOL_VERSION,
          nonce: overlayState.sessionNonce,
        });
      }
    } catch (e) {
      log("warn", "Failed to sync settings from graph", e);
    }
  }, 200);
}

/**
 * Set up graph change listeners on the ComfyUI LiteGraph instance.
 */
function setupGraphChangeDetection() {
  const graph = app.graph;
  if (!graph) {
    log("warn", "ComfyUI graph not available for change detection");
    return;
  }

  // Hook into LiteGraph events
  const origOnNodeAdded = graph.onNodeAdded;
  graph.onNodeAdded = function (node) {
    if (origOnNodeAdded) origOnNodeAdded.call(this, node);
    onGraphChanged();
  };

  const origOnNodeRemoved = graph.onNodeRemoved;
  graph.onNodeRemoved = function (node) {
    if (origOnNodeRemoved) origOnNodeRemoved.call(this, node);
    onGraphChanged();
  };

  const origOnConnectionChange = graph.onConnectionChange;
  graph.onConnectionChange = function (node, link_info) {
    if (origOnConnectionChange)
      origOnConnectionChange.call(this, node, link_info);
    onGraphChanged();
  };

  // Also poll for widget value changes (no event for those)
  if (overlayState.graphPollTimer) clearInterval(overlayState.graphPollTimer);
  overlayState.graphPollTimer = setInterval(() => {
    if (!overlayState.overlayReady) return;
    try {
      const workflow = app.graph.serialize();
      const hash = quickHash(workflow);
      if (hash !== overlayState.lastWorkflowHash) {
        onGraphChanged();
      }
    } catch {
      /* ignore */
    }
  }, 2000);

  log("info", "Graph change detection set up");
}

// Node selection sync
/**
 * Set up node selection tracking — when user clicks a node in ComfyUI,
 * send the selection to the overlay.
 */
function setupNodeSelectionSync() {
  const canvas = app.canvas;
  if (!canvas) {
    log("warn", "ComfyUI canvas not available for node selection sync");
    return;
  }

  const origOnNodeSelected = canvas.onNodeSelected;
  canvas.onNodeSelected = function (node) {
    if (origOnNodeSelected) origOnNodeSelected.call(this, node);
    if (!overlayState.overlayReady || !node || !Number.isInteger(node.id)) {
      return;
    }

    // Collect primitive widget values only: some widgets hold DOM nodes or
    // functions, which postMessage cannot clone (DataCloneError).
    const inputs = {};
    if (node.widgets) {
      for (const w of node.widgets) {
        const t = typeof w.value;
        if (
          w.name &&
          (w.value === null ||
            t === "string" ||
            t === "number" ||
            t === "boolean")
        ) {
          inputs[w.name] = w.value;
        }
      }
    }

    sendToOverlay({
      type: CJ_MSG_NODE_SELECTED,
      payload: {
        nodeId: node.id,
        nodeType: node.type ?? "Unknown",
        nodeTitle: node.title ?? node.type ?? "Untitled",
        inputs,
      },
      version: CJ_PROTOCOL_VERSION,
      nonce: overlayState.sessionNonce,
    });

    // Tools bridge: an image-bearing selection becomes the overlay's
    // "graph image" so a tool can run on it.
    const images = nodeGraphImages(node);
    if (images.length > 0) sendGraphImage(node, "selection", images);
  };

  // Clear selection when deselected
  const origOnNodeDeselected = canvas.onNodeDeselected;
  canvas.onNodeDeselected = function (node) {
    if (origOnNodeDeselected) origOnNodeDeselected.call(this, node);
    if (!overlayState.overlayReady) return;

    sendToOverlay({
      type: CJ_MSG_NODE_SELECTED,
      payload: {
        nodeId: -1,
        nodeType: "",
        nodeTitle: "",
        inputs: {},
      },
      version: CJ_PROTOCOL_VERSION,
      nonce: overlayState.sessionNonce,
    });
  };

  log("info", "Node selection sync set up");
}

// ── Overlay layout: full viewport or docked right panel ──────────────
function clampPanelWidth(width, viewportWidth) {
  const vw = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1280;
  const max = Math.max(MIN_PANEL_WIDTH, vw - MIN_CANVAS_GUTTER);
  const w = Number.isFinite(width) ? Math.round(width) : DEFAULT_PANEL_WIDTH;
  return Math.min(Math.max(w, MIN_PANEL_WIDTH), max);
}

/** Read the saved layout + panel width (storage may throw or be blocked). */
function restoreOverlayLayout() {
  try {
    const layout = localStorage.getItem(LAYOUT_KEY);
    if (layout === "full" || layout === "panel") overlayState.layout = layout;
  } catch {
    /* ignore */
  }
  try {
    const w = Number.parseInt(localStorage.getItem(PANEL_WIDTH_KEY) ?? "", 10);
    if (Number.isFinite(w)) overlayState.panelWidth = w;
  } catch {
    /* ignore */
  }
}

function persistOverlayLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, overlayState.layout);
    localStorage.setItem(PANEL_WIDTH_KEY, String(overlayState.panelWidth));
  } catch {
    /* storage full or blocked — layout just won't persist */
  }
}

/** Position the overlay container for the current layout. */
function applyOverlayLayout() {
  const container = overlayState.overlayContainer;
  if (!container?.style) return;
  const style = container.style;
  if (overlayState.layout === "panel") {
    overlayState.panelWidth = clampPanelWidth(
      overlayState.panelWidth,
      window.innerWidth,
    );
    style.left = "auto";
    style.right = "0";
    style.width = `${overlayState.panelWidth}px`;
    style.borderLeft = "1px solid rgba(255,255,255,0.12)";
    style.boxShadow = "-8px 0 24px rgba(0,0,0,0.35)";
  } else {
    style.left = "0";
    style.right = "auto";
    style.width = "100vw";
    style.borderLeft = "none";
    style.boxShadow = "none";
  }
  if (overlayState.resizeHandle?.style) {
    overlayState.resizeHandle.style.display =
      overlayState.layout === "panel" ? "block" : "none";
  }
}

function sendLayoutToOverlay() {
  if (!overlayState.sessionNonce) return;
  sendToOverlay({
    type: CJ_MSG_LAYOUT,
    payload: {
      layout: overlayState.layout,
      ...(overlayState.layout === "panel"
        ? { panelWidth: overlayState.panelWidth }
        : {}),
    },
    version: CJ_PROTOCOL_VERSION,
    nonce: overlayState.sessionNonce,
  });
}

function setOverlayLayout(layout) {
  if (layout !== "full" && layout !== "panel") return;
  overlayState.layout = layout;
  applyOverlayLayout();
  persistOverlayLayout();
  sendLayoutToOverlay();
  log("info", `Overlay layout: ${layout}`);
}

/** Drag strip on the docked panel's left edge; resizes and persists width. */
function createResizeHandle(container) {
  const handle = document.createElement("div");
  handle.id = "adrift-overlay-resize";
  handle.title = "Drag to resize";
  handle.style.cssText = [
    "position: absolute",
    "top: 0",
    "left: -4px",
    "width: 8px",
    "height: 100%",
    "cursor: ew-resize",
    "z-index: 1",
    "display: none",
    "touch-action: none",
  ].join(";");
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // The iframe would swallow pointermove once the cursor crosses it.
    const frame = overlayState.overlayFrame;
    if (frame?.style) frame.style.pointerEvents = "none";
    const onMove = (ev) => {
      overlayState.panelWidth = clampPanelWidth(
        window.innerWidth - ev.clientX,
        window.innerWidth,
      );
      container.style.width = `${overlayState.panelWidth}px`;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (frame?.style) frame.style.pointerEvents = "";
      persistOverlayLayout();
      sendLayoutToOverlay();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
  overlayState.resizeHandle = handle;
  return handle;
}

// ── Theme sync: ComfyUI palette mode → Adrift ────────────────────────
/** Parse "#rgb", "#rrggbb" or "rgb(a)(r, g, b...)" into [r, g, b]. */
function parseCssColor(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return m[1].split("").map((c) => parseInt(c + c, 16));
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/.exec(v);
  if (m) return [m[1], m[2], m[3]].map(Number);
  return null;
}

function relativeLuminance([r, g, b]) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * ComfyUI's palette mode, or null when it can't be told. The palette's
 * background color decides (works for custom palettes and every frontend
 * generation); the dark-theme class and the palette setting are fallbacks.
 */
function detectComfyTheme() {
  try {
    const root = document.documentElement;
    if (root && typeof window.getComputedStyle === "function") {
      const cs = window.getComputedStyle(root);
      for (const name of ["--comfy-menu-bg", "--bg-color"]) {
        const rgb = parseCssColor(cs.getPropertyValue(name));
        if (rgb) return relativeLuminance(rgb) > 0.4 ? "light" : "dark";
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const els = [document.documentElement, document.body];
    if (els.some((el) => el?.classList?.contains("dark-theme"))) return "dark";
  } catch {
    /* ignore */
  }
  try {
    const id =
      app.extensionManager?.setting?.get?.("Comfy.ColorPalette") ??
      app.ui?.settings?.getSettingValue?.("Comfy.ColorPalette");
    if (id === "light") return "light";
    if (id === "dark") return "dark";
  } catch {
    /* ignore */
  }
  return null;
}

/** Post the palette mode when it changed (or always, with force). */
function sendThemeToOverlay(force) {
  if (!overlayState.sessionNonce) return;
  const mode = detectComfyTheme();
  if (!mode) return;
  if (!force && mode === overlayState.lastSentTheme) return;
  overlayState.lastSentTheme = mode;
  sendToOverlay({
    type: CJ_MSG_THEME,
    payload: { mode },
    version: CJ_PROTOCOL_VERSION,
    nonce: overlayState.sessionNonce,
  });
}

function scheduleThemeCheck() {
  if (overlayState.themeTimer) clearTimeout(overlayState.themeTimer);
  overlayState.themeTimer = setTimeout(() => {
    overlayState.themeTimer = null;
    sendThemeToOverlay(false);
  }, 150);
}

/** Watch for palette switches: setting event + style/class mutations. */
function setupThemeSync() {
  try {
    app.ui?.settings?.addEventListener?.(
      "Comfy.ColorPalette.change",
      scheduleThemeCheck,
    );
  } catch {
    /* older frontends have no settings events */
  }
  try {
    if (typeof MutationObserver !== "function") return;
    const observer = new MutationObserver(scheduleThemeCheck);
    if (document.documentElement) {
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["style", "class"],
      });
    }
    if (document.body) {
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }
    // Palettes may also arrive as a swapped <style> element.
    if (document.head) {
      observer.observe(document.head, { childList: true });
    }
  } catch (e) {
    log("warn", "Theme sync observer unavailable", e);
  }
}

// ── Tools bridge: graph images + API workflow insert ─────────────────
// Lets the overlay run a tool on an image shown/loaded by a graph node and
// add a tool's API-format workflow to the current graph as real nodes.
// Every ComfyUI/LiteGraph API is feature-detected: the insert path mirrors
// what app.loadApiJson does internally (frontend 1.57.x) but adds the nodes
// to the existing graph instead of replacing it.

const TOOLS_MAX_INSERT_NODES = 400;
const TOOLS_MAX_GRAPH_IMAGES = 64;
const TOOLS_IMAGE_TYPES = new Set(["output", "input", "temp"]);
const TOOLS_CONTROL_RE = /[\x00-\x1f\x7f]/;

function cleanRequestId(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 64
    ? value
    : undefined;
}

function clip(text, max) {
  const s = String(text ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

/** Same rules as GraphImageRefSchema in protocol.ts. */
function isValidImageRef(ref) {
  if (!ref || typeof ref.filename !== "string") return false;
  const f = ref.filename;
  if (!f || f.length > 255 || TOOLS_CONTROL_RE.test(f)) return false;
  if (f.includes("/") || f.includes("\\") || f === "." || f === "..") {
    return false;
  }
  const sub = ref.subfolder ?? "";
  if (typeof sub !== "string" || sub.length > 255) return false;
  if (TOOLS_CONTROL_RE.test(sub) || sub.includes("\\")) return false;
  if (sub.split("/").some((seg) => seg === "..")) return false;
  return TOOLS_IMAGE_TYPES.has(ref.type);
}

/** "sub/name.png [output]" -> { filename, subfolder, type } (or null). */
function parseImageWidgetValue(value, defaultType) {
  if (typeof value !== "string") return null;
  let raw = value.trim();
  if (!raw || raw.length > 400) return null;
  let type = defaultType || "input";
  const m = /^(.*\S)\s*\[(input|output|temp)\]$/.exec(raw);
  if (m) {
    raw = m[1];
    type = m[2];
  }
  const segments = raw.split("/");
  const filename = segments.pop() ?? "";
  const ref = { filename, subfolder: segments.join("/"), type };
  return isValidImageRef(ref) ? ref : null;
}

function normalizeImageRef(img) {
  if (!img || typeof img !== "object") return null;
  const ref = {
    filename: img.filename,
    subfolder: typeof img.subfolder === "string" ? img.subfolder : "",
    type: TOOLS_IMAGE_TYPES.has(img.type) ? img.type : "output",
  };
  return isValidImageRef(ref) ? ref : null;
}

/** Images a node shows (execution outputs) or loads (LoadImage widget). */
function nodeGraphImages(node) {
  if (!node) return [];
  const out = [];
  const push = (ref) => {
    if (ref && out.length < TOOLS_MAX_GRAPH_IMAGES) out.push(ref);
  };
  // 1. Execution outputs keyed by node locator id (root graph: String(id)).
  const outputs =
    app.nodeOutputs && typeof app.nodeOutputs === "object"
      ? app.nodeOutputs[String(node.id)]
      : undefined;
  if (Array.isArray(outputs?.images)) {
    for (const img of outputs.images) push(normalizeImageRef(img));
  }
  // 2. Legacy per-node image list.
  if (out.length === 0 && Array.isArray(node.images)) {
    for (const img of node.images) push(normalizeImageRef(img));
  }
  // 3. LoadImage-style "image" widget.
  if (out.length === 0 && Array.isArray(node.widgets)) {
    const w = node.widgets.find((x) => x?.name === "image");
    if (w) push(parseImageWidgetValue(w.value, "input"));
  }
  return out;
}

function selectedGraphNodes() {
  const canvas = app.canvas;
  if (!canvas) return [];
  if (canvas.selected_nodes && typeof canvas.selected_nodes === "object") {
    const nodes = Object.values(canvas.selected_nodes).filter(Boolean);
    if (nodes.length) return nodes;
  }
  if (canvas.selectedItems instanceof Set) {
    return [...canvas.selectedItems].filter(
      (n) => n && typeof n.id === "number" && "widgets" in n,
    );
  }
  return [];
}

/** Pick the node to report: explicit id, then selection, then latest output. */
function findGraphImage(nodeId) {
  const graph = app.graph;
  if (graph && Number.isInteger(nodeId)) {
    const node =
      typeof graph.getNodeById === "function"
        ? graph.getNodeById(nodeId)
        : null;
    if (node) return { node, source: "node", images: nodeGraphImages(node) };
  }
  for (const node of selectedGraphNodes()) {
    const images = nodeGraphImages(node);
    if (images.length) return { node, source: "selection", images };
  }
  // Latest node with execution outputs (highest id wins as a recency proxy).
  if (graph && app.nodeOutputs && typeof app.nodeOutputs === "object") {
    let best = null;
    for (const key of Object.keys(app.nodeOutputs)) {
      if (!/^\d+$/.test(key)) continue;
      const node =
        typeof graph.getNodeById === "function"
          ? graph.getNodeById(Number(key))
          : null;
      if (!node || (best && best.id > node.id)) continue;
      if (nodeGraphImages(node).length) best = node;
    }
    if (best) {
      return { node: best, source: "latest", images: nodeGraphImages(best) };
    }
  }
  return { node: null, source: "none", images: [] };
}

function sendGraphImage(node, source, images, requestId) {
  if (!overlayState.overlayReady) return;
  const payload = {
    nodeId: node ? node.id : -1,
    nodeType: clip(node?.type ?? "", 200),
    nodeTitle: clip(node?.title ?? node?.type ?? "", 200),
    source: node ? source : "none",
    images: node ? images.slice(0, TOOLS_MAX_GRAPH_IMAGES) : [],
  };
  if (requestId) payload.requestId = requestId;
  sendToOverlay({
    type: CJ_MSG_GRAPH_IMAGE,
    payload,
    version: CJ_PROTOCOL_VERSION,
    nonce: overlayState.sessionNonce,
  });
}

function sendGraphInserted(result) {
  sendToOverlay({
    type: CJ_MSG_GRAPH_INSERTED,
    payload: {
      ...result,
      nodeIds: result.nodeIds.slice(0, TOOLS_MAX_INSERT_NODES),
      warnings: result.warnings.slice(0, 50).map((w) => clip(w, 500)),
      ...(result.error ? { error: clip(result.error, 500) } : {}),
    },
    version: CJ_PROTOCOL_VERSION,
    nonce: overlayState.sessionNonce,
  });
}

function isApiLinkValue(v) {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    (typeof v[0] === "string" || typeof v[0] === "number") &&
    Number.isInteger(v[1]) &&
    v[1] >= 0
  );
}

/** Structural check matching ApiWorkflowSchema; returns an error string. */
function validateApiWorkflow(wf) {
  if (!wf || typeof wf !== "object" || Array.isArray(wf)) {
    return "workflow must be an object";
  }
  const ids = Object.keys(wf);
  if (ids.length === 0) return "workflow has no nodes";
  if (ids.length > TOOLS_MAX_INSERT_NODES) {
    return `workflow has ${ids.length} nodes (max ${TOOLS_MAX_INSERT_NODES})`;
  }
  for (const id of ids) {
    const n = wf[id];
    if (!n || typeof n.class_type !== "string" || !n.class_type) {
      return `node ${id} has no class_type`;
    }
    if (!n.inputs || typeof n.inputs !== "object") {
      return `node ${id} has no inputs`;
    }
    for (const v of Object.values(n.inputs)) {
      if (isApiLinkValue(v) && !(String(v[0]) in wf)) {
        return `node ${id} links to missing node ${String(v[0])}`;
      }
    }
  }
  return null;
}

/** Rightmost edge of the existing graph, so inserted nodes don't overlap. */
function graphRightEdge(graph) {
  let maxX = null;
  let minY = null;
  for (const n of graph._nodes ?? graph.nodes ?? []) {
    const x = (n.pos?.[0] ?? 0) + (n.size?.[0] ?? 0);
    if (maxX === null || x > maxX) maxX = x;
    const y = n.pos?.[1] ?? 0;
    if (minY === null || y < minY) minY = y;
  }
  return { x: maxX === null ? 0 : maxX + 120, y: minY === null ? 0 : minY };
}

/** Column per dependency depth, so links run left to right. */
function layoutDepths(wf) {
  const depth = {};
  const visiting = new Set();
  const visit = (id) => {
    if (depth[id] !== undefined) return depth[id];
    if (visiting.has(id)) return 0; // cycle guard (invalid but don't hang)
    visiting.add(id);
    let d = 0;
    for (const v of Object.values(wf[id].inputs)) {
      if (isApiLinkValue(v) && String(v[0]) in wf) {
        d = Math.max(d, visit(String(v[0])) + 1);
      }
    }
    visiting.delete(id);
    depth[id] = d;
    return d;
  };
  for (const id of Object.keys(wf)) visit(id);
  return depth;
}

/** Add an API-format workflow to the current graph (no graph replace). */
function insertApiWorkflowNodes(wf, title) {
  const LG = window.LiteGraph;
  const graph = app.graph;
  if (!LG || typeof LG.createNode !== "function") {
    throw new Error("LiteGraph.createNode is not available");
  }
  if (!graph || typeof graph.add !== "function") {
    throw new Error("ComfyUI graph is not available");
  }
  const warnings = [];
  const created = {};
  const origin = graphRightEdge(graph);
  const depth = layoutDepths(wf);
  const rowsPerCol = {};

  graph.beforeChange?.();
  try {
    for (const id of Object.keys(wf)) {
      const data = wf[id];
      const node = LG.createNode(data.class_type);
      if (!node) {
        warnings.push(`Unknown node type "${data.class_type}" (node ${id})`);
        continue;
      }
      const t = data._meta?.title;
      if (typeof t === "string" && t) node.title = clip(t, 200);
      const col = depth[id] ?? 0;
      const row = rowsPerCol[col] ?? 0;
      rowsPerCol[col] = row + 1;
      node.pos = [origin.x + col * 380, origin.y + row * 260];
      graph.add(node);
      created[id] = node;
    }

    // Inputs: links + widget values. Retry because dynamic inputs (e.g.
    // autogrow sockets) can appear only after an earlier value is set.
    let pending = [];
    for (const id of Object.keys(created)) {
      for (const [name, value] of Object.entries(wf[id].inputs)) {
        pending.push({ id, name, value });
      }
    }
    for (let pass = 0; pass < 4 && pending.length; pass++) {
      const next = [];
      for (const item of pending) {
        if (!applyApiInput(created, item)) next.push(item);
      }
      if (next.length === pending.length) {
        pending = next;
        break;
      }
      pending = next;
    }
    for (const item of pending) {
      warnings.push(
        `Input "${item.name}" on node ${item.id} (${wf[item.id].class_type}) was not applied`,
      );
    }

    // Wrap in a group when the LiteGraph build exposes one.
    const nodes = Object.values(created);
    if (nodes.length && typeof LG.LGraphGroup === "function") {
      try {
        const group = new LG.LGraphGroup(clip(title || "Adrift tool", 200));
        if (typeof group.recomputeInsideNodes === "function") {
          graph.add(group);
          if (typeof group.resizeTo === "function") group.resizeTo(nodes, 40);
        }
      } catch (e) {
        log("warn", "Could not create group for inserted nodes", e);
      }
    }
  } finally {
    graph.afterChange?.();
  }
  graph.setDirtyCanvas?.(true, true);

  const nodes = Object.values(created);
  const canvas = app.canvas;
  if (nodes.length && canvas) {
    if (typeof canvas.selectNodes === "function") canvas.selectNodes(nodes);
    if (typeof canvas.centerOnNode === "function")
      canvas.centerOnNode(nodes[0]);
  }
  return { nodeIds: nodes.map((n) => n.id), warnings };
}

function applyApiInput(created, { id, name, value }) {
  const node = created[id];
  if (isApiLinkValue(value)) {
    const src = created[String(value[0])];
    if (!src) return true; // source failed to create; warned already
    let slot = node.inputs?.findIndex((i) => i.name === name) ?? -1;
    if (slot < 0) {
      const widget = node.widgets?.find((w) => w.name === name);
      if (widget && typeof node.convertWidgetToInput === "function") {
        node.convertWidgetToInput(widget);
        slot = node.inputs?.findIndex((i) => i.name === name) ?? -1;
      }
    }
    if (slot < 0 || typeof src.connect !== "function") return false;
    src.connect(value[1], node, slot);
    return true;
  }
  const widget = node.widgets?.find((w) => w.name === name);
  if (!widget) return false;
  widget.value = value;
  widget.callback?.(value);
  return true;
}

async function handleInsertApiWorkflow(payload) {
  const requestId = cleanRequestId(payload.requestId);
  const mode = payload.mode === "replace" ? "replace" : "insert";
  const base = { mode, nodeIds: [], warnings: [] };
  if (requestId) base.requestId = requestId;
  const invalid = validateApiWorkflow(payload.workflow);
  if (invalid) {
    sendGraphInserted({ ...base, ok: false, error: invalid });
    return;
  }
  try {
    let result;
    if (mode === "replace") {
      if (typeof app.loadApiJson !== "function") {
        throw new Error(
          "app.loadApiJson is not available in this ComfyUI version",
        );
      }
      await app.loadApiJson(
        payload.workflow,
        clip(payload.title || "Adrift tool", 200),
      );
      const ids = (app.graph?._nodes ?? app.graph?.nodes ?? []).map(
        (n) => n.id,
      );
      result = { nodeIds: ids, warnings: [] };
    } else {
      result = insertApiWorkflowNodes(payload.workflow, payload.title);
    }
    const ok = result.nodeIds.length > 0;
    sendGraphInserted({
      ...base,
      ok,
      nodeIds: result.nodeIds,
      warnings: result.warnings,
      ...(ok ? {} : { error: "No nodes could be created" }),
    });
    if (ok && payload.reveal !== false) setOverlayVisible(false);
    log("info", `API workflow ${mode}: ${result.nodeIds.length} nodes`);
  } catch (e) {
    log("error", "API workflow insert failed", e);
    sendGraphInserted({ ...base, ok: false, error: String(e?.message ?? e) });
  }
}
// ── ComfyUI Extension Registration ─────────────────────────────────────
// A second copy of this file (e.g. an old pack that still ships it next to
// this one) must not add a second button, listener set and iframe.
const ALREADY_LOADED =
  typeof window !== "undefined" && window.__adriftOverlayLoaded === true;
if (typeof window !== "undefined") window.__adriftOverlayLoaded = true;
if (ALREADY_LOADED) {
  log("warn", "Adrift overlay is installed twice; ignoring this copy");
} else app.registerExtension({
  name: "Adrift.Overlay",

  async setup() {
    if (overlayState.setupDone) return;
    overlayState.setupDone = true;
    overlayState.clientId = generateClientId();

    await loadPackConfig();

    createToggleButton();

    window.addEventListener("message", handleMessageFromOverlay);

    restoreOverlayLayout();
    restoreVisibility();

    // Set up execution event forwarding (progress, images, status)
    setupExecutionForwarding();

    setupGraphChangeDetection();

    setupNodeSelectionSync();

    setupThemeSync();

    // Keep a docked panel inside the viewport when the window shrinks.
    window.addEventListener("resize", () => {
      if (overlayState.layout === "panel") applyOverlayLayout();
    });

    // Register context menu item
    const originalGetCanvasMenuOptions = app.canvas?.getCanvasMenuOptions;
    if (app.canvas) {
      app.canvas.getCanvasMenuOptions = function () {
        const options = originalGetCanvasMenuOptions
          ? originalGetCanvasMenuOptions.apply(this, arguments)
          : [];

        options.push(null); // separator
        options.push({
          content: overlayState.visible ? "Show ComfyUI" : "Open Adrift",
          callback: () => toggleOverlay(),
        });

        return options;
      };
    }

    // Keyboard shortcut: Ctrl+Shift+J toggles overlay
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === "J") {
        e.preventDefault();
        toggleOverlay();
      }
    });

    log("info", "Adrift.Overlay setup complete (Ctrl+Shift+J to toggle)");
  },
});

log("info", "Adrift overlay bridge loaded");
