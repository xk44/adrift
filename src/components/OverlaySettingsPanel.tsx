"use client";

import { useOverlayStore } from "@/store/overlayStore";
import { X } from "lucide-react";

/**
 * Settings panel shown when Adrift runs as a ComfyUI overlay.
 * Controls progress display. The ComfyUI address comes from the host bridge
 * handshake (cj:config), so there is no URL field here. The queueViaComfyUI and
 * autoSyncWorkflow store flags have no consumer yet, so they get no toggle
 * (jobs always go through the Adrift API, which tracks outputs and history).
 */
interface OverlaySettingsPanelProps {
  onClose?: () => void;
}

export function OverlaySettingsPanel({ onClose }: OverlaySettingsPanelProps) {
  const settings = useOverlayStore((s) => s.overlaySettings);
  const update = useOverlayStore((s) => s.updateOverlaySettings);
  const setOpen = useOverlayStore((s) => s.setSettingsPanelOpen);

  const handleClose = () => {
    setOpen(false);
    onClose?.();
  };

  return (
    <div className="absolute right-0 top-12 z-50 w-80 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4 shadow-xl">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          Overlay Settings
        </h3>
        <button
          aria-label="Close overlay settings"
          type="button"
          onClick={handleClose}
          className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-3">
        <ToggleRow
          label="Show ComfyUI progress"
          description="Display execution progress from ComfyUI"
          checked={settings.showComfyProgress}
          onChange={(v) => update({ showComfyProgress: v })}
        />
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div>
        <div className="text-sm text-[var(--text-primary)]">{label}</div>
        <div className="text-xs text-[var(--text-tertiary)]">{description}</div>
      </div>
      <button
        aria-label={label}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 h-5 w-9 flex-shrink-0 rounded-full transition-colors ${
          checked ? "bg-[var(--accent-primary)]" : "bg-[var(--bg-tertiary)]"
        }`}
      >
        <span
          className={`block h-4 w-4 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}
