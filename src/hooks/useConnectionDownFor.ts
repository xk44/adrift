"use client";

import { useEffect, useState } from "react";
import { CONNECTION_ALERT_DELAY_MS } from "@/lib/ui/connectionState";

/**
 * True once the connection has been continuously down for `delayMs`.
 * Resets as soon as it reconnects, so a brief blip never surfaces UI.
 * State only changes from timer callbacks (no synchronous setState in the
 * effect body).
 */
export function useConnectionDownFor(
  isConnected: boolean,
  delayMs = CONNECTION_ALERT_DELAY_MS,
): boolean {
  const [due, setDue] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(
      () => setDue(!isConnected),
      isConnected ? 0 : delayMs,
    );
    return () => window.clearTimeout(t);
  }, [isConnected, delayMs]);

  return !isConnected && due;
}

export default useConnectionDownFor;
