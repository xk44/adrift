"use client";

import { RotateCw } from "lucide-react";
import { useGenerationStore } from "@/store";
import {
  connectionDotClass,
  connectionLabel,
  connectionTitle,
  deriveConnectionState,
} from "@/lib/ui/connectionState";
import { useConnectionDownFor } from "@/hooks/useConnectionDownFor";

/**
 * Compact, calm connection indicator under the prompt bar. Mobile only: on
 * desktop the sidebar footer carries the status dot. Renders nothing while
 * connected, and stays hidden through short blips (reconnect handshakes,
 * ComfyUI restarts) until the outage outlasts the shared alert delay.
 */
export function ConnectionStatusPill({
  isConnected,
}: {
  isConnected: boolean;
}) {
  const comfyReachable = useGenerationStore((s) => s.comfyReachable);
  const wsReconnecting = useGenerationStore((s) => s.wsReconnecting);
  const downLong = useConnectionDownFor(isConnected);

  if (isConnected || !downLong) return null;

  const state = deriveConnectionState({
    wsConnected: isConnected,
    comfyReachable,
    wsReconnecting,
  });
  const title = connectionTitle(state);

  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event("cj:ws-reconnect"))}
      title={title}
      aria-label={title}
      className="md:hidden mt-1.5 inline-flex h-6 items-center gap-1.5 rounded-full bg-[var(--bg-secondary)] pl-2 pr-1.5 text-[11px] text-[var(--text-tertiary)] shadow-[inset_0_0_0_1px_var(--border-primary)] animate-fade-in transition-[color,transform] duration-150 hover:text-[var(--text-secondary)] active:scale-[0.96]"
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${connectionDotClass(state)}`}
      />
      <span>{connectionLabel(state)}</span>
      {state !== "reconnecting" && (
        <RotateCw className="h-3 w-3 opacity-70" aria-hidden />
      )}
    </button>
  );
}

export default ConnectionStatusPill;
