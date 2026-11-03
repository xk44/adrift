"use client";

/**
 * System card — ComfyUI server status and maintenance.
 *
 * Surfaces ComfyUI 0.24+ system info: version, per-device VRAM (multi-GPU),
 * core package versions, plus Free VRAM / Interrupt maintenance actions.
 */

import { useCallback, useEffect, useState } from "react";
import { SettingCard } from "@/components/settings/SettingCard";
import { SettingLabel } from "@/components/settings/SettingLabel";
import { showToast } from "@/components/Toast";
import { Cpu, Loader2, RefreshCw, Trash2, OctagonX } from "lucide-react";
import { useComfyCapabilities } from "@/hooks/useComfyCapabilities";
import { openOnboarding } from "@/store/onboardingStore";

/** Plain words for "ComfyUI unreachable" and friends, with what to do. */
export function systemErrorText(error: string): string {
  if (/unreachable|fetch failed|ECONNREFUSED|HTTP 50[234]/i.test(error))
    return "Can't reach ComfyUI. Make sure it's running, then press Try again, or check the address in Set up connection.";
  return `ComfyUI didn't answer as expected (${error}). Press Try again, or check the address in Set up connection.`;
}

interface SystemDevice {
  name?: string;
  type?: string;
  index?: number;
  vramTotal?: number;
  vramFree?: number;
}

interface SystemInfo {
  os?: string;
  comfyuiVersion?: string;
  pythonVersion?: string;
  pytorchVersion?: string;
  ramTotal?: number;
  ramFree?: number;
  packageVersions: Array<{ name: string; installed: string; required: string }>;
}

function formatGiB(bytes?: number): string {
  if (bytes === undefined || !isFinite(bytes)) return "—";
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function shortDeviceName(name?: string): string {
  if (!name) return "GPU";
  // "NVIDIA GeForce RTX 4090 : cudaMallocAsync" → "RTX 4090"
  return name
    .replace(/\s*:\s*\w+$/, "")
    .replace(/NVIDIA (GeForce )?/i, "")
    .trim();
}

function VramBar({ device }: { device: SystemDevice }) {
  const total = device.vramTotal ?? 0;
  const free = device.vramFree ?? 0;
  const used = Math.max(0, total - free);
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const high = pct > 90;

  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
        <span className="truncate">
          {shortDeviceName(device.name)}
          {device.type ? ` · ${device.type}` : ""}
        </span>
        <span className="font-mono tabular-nums">
          {formatGiB(used)} / {formatGiB(total)}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${
            high ? "bg-red-400" : "bg-splash"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function SystemCard() {
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [devices, setDevices] = useState<SystemDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const caps = useComfyCapabilities();

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/comfy/system", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setSystem(data.system as SystemInfo);
      setDevices((data.devices as SystemDevice[]) ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ComfyUI unreachable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = async (action: "free" | "interrupt") => {
    try {
      setBusyAction(action);
      const res = await fetch("/api/comfy/system", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      showToast(
        action === "free"
          ? "Models unloaded, VRAM freed"
          : "Generation interrupted",
        "info",
      );
      void load();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : `Failed to ${action}`,
        "error",
      );
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <SettingCard
      title="System"
      defaultOpen={false}
      headerSummary={
        system?.comfyuiVersion ? `ComfyUI ${system.comfyuiVersion}` : undefined
      }
    >
      {loading && !system ? (
        <div className="flex items-center gap-2 py-1 text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Loading system info...</span>
        </div>
      ) : error ? (
        <div className="space-y-2 py-1" data-testid="system-card-error">
          <p className="text-sm text-[var(--text-primary)]">
            {systemErrorText(error)}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => openOnboarding("connect")}
              className="min-h-8 rounded-lg bg-splash px-3 text-[12px] font-semibold text-white transition-opacity hover:opacity-90"
            >
              Set up connection
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="flex min-h-8 items-center gap-1 rounded-lg px-2 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <RefreshCw className="h-3 w-3" />
              Try again
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
              <Cpu className="h-4 w-4 text-[var(--text-muted)]" />
              <span>ComfyUI {system?.comfyuiVersion ?? "?"}</span>
            </div>
            <button
              type="button"
              onClick={() => void load()}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              aria-label="Refresh system info"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              />
            </button>
          </div>
          {caps?.reachable && (
            <div className="text-[11px] text-[var(--text-muted)]">
              Job cancel:{" "}
              {caps.interruptPromptId
                ? "per-job"
                : "global only (ComfyUI < 0.3.57, asks first)"}
              {" · "}Preview metadata: {caps.previewMetadata ? "yes" : "no"}
            </div>
          )}

          {/* Per-device VRAM (multi-GPU aware) */}
          {devices.length > 0 && (
            <div className="space-y-2">
              {devices.map((d, i) => (
                <VramBar key={d.index ?? i} device={d} />
              ))}
            </div>
          )}

          {system?.ramTotal !== undefined && (
            <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
              <span>System RAM</span>
              <span className="font-mono tabular-nums">
                {formatGiB((system.ramTotal ?? 0) - (system.ramFree ?? 0))} /{" "}
                {formatGiB(system.ramTotal)}
              </span>
            </div>
          )}

          {system && system.packageVersions.length > 0 && (
            <details className="text-[11px] text-[var(--text-muted)]">
              <summary className="cursor-pointer select-none">
                Core packages ({system.packageVersions.length})
              </summary>
              <ul className="mt-1 space-y-0.5 font-mono">
                {system.packageVersions.map((p) => (
                  <li key={p.name} className="flex justify-between gap-2">
                    <span className="truncate">{p.name}</span>
                    <span
                      className={
                        p.installed === p.required
                          ? ""
                          : "text-amber-500"
                      }
                    >
                      {p.installed}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              type="button"
              onClick={() => void runAction("free")}
              disabled={busyAction !== null}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-2 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busyAction === "free" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Free VRAM
            </button>
            <button
              type="button"
              onClick={() => void runAction("interrupt")}
              disabled={busyAction !== null}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-2 py-1.5 text-xs font-medium text-red-500 transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busyAction === "interrupt" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <OctagonX className="h-3.5 w-3.5" />
              )}
              Interrupt
            </button>
          </div>
        </>
      )}
    </SettingCard>
  );
}
