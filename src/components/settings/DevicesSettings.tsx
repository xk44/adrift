"use client";

/**
 * "Devices" card on Account Settings: every browser or app signed in to this
 * Adrift, with Unpair per device, "Unpair all other devices" and "Sign out".
 * Backed by /api/auth/devices (lib/sessionRegistry.ts). Hidden when sign-in
 * is off (no ADMIN_API_KEY) or the list can't be loaded.
 */

import { useCallback, useEffect, useState } from "react";
import { LogOut, Monitor, Smartphone, Loader2 } from "lucide-react";
import { SettingCard } from "./SettingCard";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { showToast } from "@/components/Toast";

export interface DeviceRow {
  sid: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
}

const MUTATE_HEADERS = { "X-Requested-With": "XMLHttpRequest" };

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago", else a date. */
export function formatRelativeTime(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return formatDate(ms);
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function isPhone(label: string): boolean {
  return /iPhone|iPad|Android|iOS app/.test(label);
}

/** Reload so the sign-in prompt shows on the next request. */
function afterSignOut() {
  if (typeof window !== "undefined") window.location.reload();
}

const btn =
  "flex min-h-8 items-center gap-1.5 rounded-xl border border-light-100 bg-light-50 px-3 py-1.5 text-xs font-medium text-light-600 transition-[color,background-color,border-color,transform] duration-150 hover:bg-light-100 active:scale-[0.96] disabled:opacity-40 dark:border-dark-750 dark:bg-dark-700 dark:text-dark-300 dark:hover:bg-dark-750";

export function DevicesSettings() {
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/devices", { cache: "no-store" });
      if (!res.ok) {
        setHidden(true);
        return;
      }
      const data = (await res.json()) as {
        enabled?: boolean;
        devices?: DeviceRow[];
      };
      if (!data.enabled) {
        setHidden(true);
        return;
      }
      setHidden(false);
      setDevices(Array.isArray(data.devices) ? data.devices : []);
    } catch {
      setHidden(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (hidden) return null;

  const others = (devices ?? []).filter((d) => !d.current);

  const unpair = async (d: DeviceRow) => {
    const ok = await confirm(
      d.current
        ? {
            title: "Sign out of this device?",
            message: "You'll need the admin key to sign in again here.",
            confirmLabel: "Sign out",
            danger: true,
          }
        : {
            title: `Unpair ${d.label}?`,
            message:
              "That device is signed out right away and needs the admin key to sign in again.",
            confirmLabel: "Unpair",
            danger: true,
          },
    );
    if (!ok) return;
    setBusy(d.sid);
    try {
      const res = await fetch(
        `/api/auth/devices/${encodeURIComponent(d.sid)}`,
        { method: "DELETE", headers: MUTATE_HEADERS },
      );
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      if (d.current) {
        afterSignOut();
        return;
      }
      await load();
    } catch {
      showToast("Couldn't unpair that device. Try again.", "error");
    } finally {
      setBusy(null);
    }
  };

  const unpairOthers = async () => {
    const ok = await confirm({
      title: "Unpair all other devices?",
      message:
        "Every other browser and app is signed out right away. This device stays signed in.",
      confirmLabel: "Unpair all",
      danger: true,
    });
    if (!ok) return;
    setBusy("others");
    try {
      const res = await fetch("/api/auth/devices/unpair-others", {
        method: "POST",
        headers: MUTATE_HEADERS,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast("Other devices were signed out.", "success");
      await load();
    } catch {
      showToast("Couldn't unpair the other devices. Try again.", "error");
    } finally {
      setBusy(null);
    }
  };

  const signOut = async () => {
    const ok = await confirm({
      title: "Sign out of this device?",
      message: "You'll need the admin key to sign in again here.",
      confirmLabel: "Sign out",
    });
    if (!ok) return;
    setBusy("signout");
    try {
      const res = await fetch("/api/auth/logout", {
        method: "POST",
        headers: MUTATE_HEADERS,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      afterSignOut();
    } catch {
      showToast("Couldn't sign out. Try again.", "error");
      setBusy(null);
    }
  };

  return (
    <SettingCard title="Devices">
      <p className="mb-3 text-xs text-pretty text-light-500 dark:text-dark-400">
        Browsers and apps signed in to Adrift. Unpair one you don&apos;t
        recognize or no longer use.
      </p>
      {devices === null ? (
        <div className="flex items-center gap-2 text-xs text-light-400 dark:text-dark-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : devices.length === 0 ? (
        <p className="text-xs text-light-400 dark:text-dark-500">
          No signed-in devices.
        </p>
      ) : (
        <ul className="space-y-2" aria-label="Signed-in devices">
          {devices.map((d) => {
            const Icon = isPhone(d.label) ? Smartphone : Monitor;
            return (
              <li
                key={d.sid}
                className="flex items-center justify-between gap-3 rounded-xl border border-light-100 px-3 py-2 dark:border-dark-750"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <Icon className="h-4 w-4 flex-shrink-0 text-light-400 dark:text-dark-500" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm text-light-primary dark:text-dark-primary">
                        {d.label}
                      </span>
                      {d.current && (
                        <span className="flex-shrink-0 rounded-full bg-splash/10 px-2 py-0.5 text-[10px] font-medium text-splash">
                          This device
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-light-400 dark:text-dark-500">
                      Signed in {formatDate(d.createdAt)} · Last active{" "}
                      {formatRelativeTime(d.lastSeenAt)}
                    </p>
                  </div>
                </div>
                {!d.current && (
                  <button
                    type="button"
                    onClick={() => unpair(d)}
                    disabled={busy !== null}
                    className="flex-shrink-0 rounded-full bg-light-100 px-3 py-1.5 text-xs font-medium text-light-500 transition-[color,background-color] duration-150 hover:bg-red-50 hover:text-red-500 disabled:opacity-40 dark:bg-dark-700 dark:text-dark-400 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                  >
                    {busy === d.sid ? "Unpairing…" : "Unpair"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={signOut}
          disabled={busy !== null}
          className={btn}
        >
          <LogOut className="h-3.5 w-3.5" />
          {busy === "signout" ? "Signing out…" : "Sign out"}
        </button>
        {others.length > 0 && (
          <button
            type="button"
            onClick={unpairOthers}
            disabled={busy !== null}
            className={btn}
          >
            {busy === "others" ? "Unpairing…" : "Unpair all other devices"}
          </button>
        )}
      </div>
      {confirmDialog}
    </SettingCard>
  );
}
