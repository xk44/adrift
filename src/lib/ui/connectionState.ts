/**
 * Shared ComfyUI connection-state derivation for the app shell.
 *
 * Both the desktop sidebar footer and the compact pill under the prompt bar
 * render from this, so the wording stays calm and consistent: a lost
 * connection is a status, not an alarm.
 */

export type ConnectionState =
  "connected" | "partial" | "reconnecting" | "offline";

export interface ConnectionInputs {
  wsConnected: boolean;
  comfyReachable: boolean;
  wsReconnecting: boolean;
}

export function deriveConnectionState({
  wsConnected,
  comfyReachable,
  wsReconnecting,
}: ConnectionInputs): ConnectionState {
  if (wsConnected) return "connected";
  if (wsReconnecting) return "reconnecting";
  if (comfyReachable) return "partial";
  return "offline";
}

/** Short label for the status row / pill. */
export function connectionLabel(
  state: ConnectionState,
  queueRemaining = 0,
): string {
  switch (state) {
    case "connected":
      return queueRemaining > 0
        ? `ComfyUI · queue ${queueRemaining}`
        : "ComfyUI";
    case "partial":
      return "Live updates paused";
    case "reconnecting":
      return "Reconnecting…";
    case "offline":
      return "Offline";
  }
}

/** Longer tooltip / aria text. */
export function connectionTitle(
  state: ConnectionState,
  queueRemaining = 0,
): string {
  switch (state) {
    case "connected":
      return `ComfyUI connected — queue: ${queueRemaining}`;
    case "partial":
      return "ComfyUI reachable over HTTP but the WebSocket is down — click to retry";
    case "reconnecting":
      return "Reconnecting to ComfyUI…";
    case "offline":
      return "ComfyUI not reachable — click to retry";
  }
}

/** Tailwind classes for the status dot. Amber for transient, muted grey for offline. */
export function connectionDotClass(state: ConnectionState): string {
  switch (state) {
    case "connected":
      return "bg-[var(--success)]";
    case "offline":
      return "bg-[var(--text-tertiary)]";
    default:
      return "bg-[var(--warning)] animate-pulse-soft";
  }
}

// Delayed connection alerts

/**
 * How long the socket must stay down before anything louder than the status
 * dot appears. ComfyUI restarts and the reconnect handshake routinely take a
 * few seconds; those should never flash a banner.
 */
export const CONNECTION_ALERT_DELAY_MS = 15_000;

/** sessionStorage key: the user dismissed the connection banner this session. */
export const CONNECTION_BANNER_DISMISSED_KEY = "cj:conn-banner-dismissed";

const CONNECTION_ERROR_PATTERNS: readonly RegExp[] = [
  /lost connection to comfyui/i,
  /websocket disconnected/i,
  /failed to connect to comfyui/i,
];

/** True for the store errors the socket hook raises when ComfyUI goes away. */
export function isConnectionErrorMessage(
  message: string | null | undefined,
): boolean {
  if (!message) return false;
  return CONNECTION_ERROR_PATTERNS.some((re) => re.test(message));
}

export type ErrorBannerMode = "hidden" | "connection" | "error";

/**
 * Decide how the header error banner renders. Ordinary errors (failed
 * generation, bad workflow) always show. Connection errors stay quiet (the
 * sidebar dot already says it) until the outage outlasts the grace period,
 * and never again once dismissed this session. A connection error left over
 * after the socket came back is stale and hidden.
 */
export function errorBannerMode({
  message,
  isConnected,
  downLong,
  dismissed,
}: {
  message: string | null | undefined;
  isConnected: boolean;
  downLong: boolean;
  dismissed: boolean;
}): ErrorBannerMode {
  if (!message) return "hidden";
  if (!isConnectionErrorMessage(message)) return "error";
  if (isConnected || !downLong || dismissed) return "hidden";
  return "connection";
}

/** Plain-text error report used by the status popover's Copy action. */
export function formatErrorReport(
  errors: readonly { message: string; timestamp: number; promptId?: string }[],
): string {
  return errors
    .map(
      (err, i) =>
        `${i + 1}. [${new Date(err.timestamp).toLocaleTimeString()}] ${err.message}${err.promptId ? ` (prompt: ${err.promptId})` : ""}`,
    )
    .join("\n");
}

/** Badge text for the error count on the status dot (compact, capped). */
export function errorBadgeText(count: number): string | null {
  if (count <= 0) return null;
  return count > 9 ? "9+" : String(count);
}
