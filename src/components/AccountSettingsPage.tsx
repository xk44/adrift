"use client";

import { STORAGE_KEYS, readLocalStorage } from "@/lib/storageKeys";
import { PageHeader } from "@/components/PageHeader";
import { showToast } from "@/components/Toast";
import { useCallback, useEffect, useState } from "react";
import { useUIStore, useGenerationStore } from "@/store";
import { navigateTo } from "@/hooks";
import { SettingCard } from "@/components/settings";
import { DevicesSettings } from "@/components/settings/DevicesSettings";
import { AppearanceSettings } from "@/components/settings/AppearanceSettings";
import { VideoEditStorageSettings } from "@/components/settings/VideoEditStorageSettings";
import { VideoQcSettingsCard } from "@/components/settings/VideoQcSettings";
import { LivePreviewSettings } from "@/components/settings/LivePreviewSettings";
import { UpscalerSettings } from "@/components/settings/UpscalerSettings";
import { RecipeEmbedSettings } from "@/components/settings/RecipeEmbedSettings";
import { BlenderSettings } from "@/components/settings/BlenderSettings";
import { ComfyInstancesSettings } from "@/components/settings/ComfyInstancesSettings";
import { TrainingSettings } from "@/components/settings/TrainingSettings";
import { OverlayInstallCard } from "@/components/settings/OverlayInstallCard";
import {
  Link2,
  Download,
  User,
  Zap,
  RefreshCw,
  CheckCircle,
  AlertTriangle,
  Edit3,
  X,
  Check,
  Key,
  Eye,
  EyeOff,
  Loader2,
} from "lucide-react";

// localStorage helpers

const PROFILE_KEY = STORAGE_KEYS.profile;

interface ProfileData {
  username: string;
  displayName: string;
  bio: string;
}

const DEFAULT_PROFILE: ProfileData = {
  username: "user",
  displayName: "User",
  bio: "",
};

function loadProfile(): ProfileData {
  if (typeof window === "undefined") return DEFAULT_PROFILE;
  try {
    const raw = readLocalStorage(PROFILE_KEY);
    return raw ? { ...DEFAULT_PROFILE, ...JSON.parse(raw) } : DEFAULT_PROFILE;
  } catch {
    return DEFAULT_PROFILE;
  }
}

function saveProfile(data: ProfileData) {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(data));
  } catch {
    /* quota / private browsing */
  }
}

// Editable field

function EditableField({
  label,
  value,
  onSave,
  placeholder,
  monospace,
}: {
  label: string;
  value: string;
  onSave: (v: string) => void;
  placeholder?: string;
  monospace?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(false);

  const handleSave = useCallback(() => {
    onSave(draft.trim());
    setEditing(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }, [draft, onSave]);

  const handleCancel = useCallback(() => {
    setDraft(value);
    setEditing(false);
  }, [value]);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-light-500 dark:text-dark-400 flex-shrink-0">
        {label}
      </span>
      {editing ? (
        <div className="flex items-center gap-1.5 min-w-0 flex-1 justify-end">
          <input
            aria-label={label}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
              if (e.key === "Escape") handleCancel();
            }}
            placeholder={placeholder}
            className={`min-w-0 flex-1 max-w-[200px] rounded-lg border border-light-200 dark:border-dark-600 bg-white dark:bg-dark-800 px-2.5 py-1 text-xs text-light-primary dark:text-dark-primary placeholder:text-light-400 dark:placeholder:text-dark-500 focus:outline-none focus:ring-1 focus:ring-splash ${monospace ? "font-mono" : ""}`}
          />
          <button
            onClick={handleSave}
            className="p-1 rounded-md bg-splash/10 text-splash hover:bg-splash/20 transition-colors"
            title="Save"
          >
            <Check className="h-3 w-3" />
          </button>
          <button
            onClick={handleCancel}
            className="p-1 rounded-md hover:bg-light-100 dark:hover:bg-dark-700 transition-colors"
            title="Cancel"
          >
            <X className="h-3 w-3 text-light-400 dark:text-dark-500" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-shrink-0">
          {saved ? (
            <span className="flex items-center gap-1 text-xs text-emerald-500">
              <Check className="h-3 w-3" /> Saved
            </span>
          ) : (
            <span
              className={`text-sm font-medium text-light-primary dark:text-dark-primary ${monospace ? "font-mono" : ""}`}
            >
              {value || (
                <span className="text-light-400 dark:text-dark-500 font-normal italic">
                  {placeholder ?? "—"}
                </span>
              )}
            </span>
          )}
          <button
            onClick={() => setEditing(true)}
            className="p-1 rounded-md opacity-0 hover:opacity-100 group-hover:opacity-60 hover:bg-light-100 dark:hover:bg-dark-700 transition-[opacity,background-color] duration-150"
            title={`Edit ${label}`}
          >
            <Edit3 className="h-3 w-3 text-light-400 dark:text-dark-500" />
          </button>
        </div>
      )}
    </div>
  );
}

// Toggle pill

function PillToggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-5 rounded-full transition-colors duration-200 flex-shrink-0 ${
        checked ? "bg-splash" : "bg-light-200 dark:bg-dark-600"
      }`}
      role="switch"
      aria-checked={checked}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? "translate-x-5" : ""
        }`}
      />
    </button>
  );
}

// Page

export function AccountSettingsPage() {
  const activeNav = useUIStore((s) => s.activeNav);

  const gallery = useGenerationStore((s) => s.gallery);
  const runs = useGenerationStore((s) => s.runs);
  const comfyReachable = useGenerationStore((s) => s.comfyReachable);
  const wsConnected = useGenerationStore((s) => s.wsConnected);

  const [profile, setProfile] = useState<ProfileData>(loadProfile);
  const [exportState, setExportState] = useState<"idle" | "exporting" | "done">(
    "idle",
  );

  // Persist profile on every change
  const updateProfile = useCallback((patch: Partial<ProfileData>) => {
    setProfile((prev) => {
      const next = { ...prev, ...patch };
      saveProfile(next);
      return next;
    });
  }, []);

  if (activeNav !== "account-settings") return null;

  const totalImages = gallery.length;
  const totalRuns = runs.length;
  const likedImages = gallery.filter((img) => img.liked).length;
  const completedRuns = runs.filter((r) => r.status === "done").length;
  const errorRuns = runs.filter((r) => r.status === "error").length;

  const handleExport = () => {
    setExportState("exporting");
    try {
      const exportData = {
        exportedAt: new Date().toISOString(),
        version: "0.1.0-alpha",
        profile: {
          username: profile.username,
          displayName: profile.displayName,
          bio: profile.bio,
        },
        stats: {
          totalImages,
          totalRuns,
          likedImages,
          hiddenImages: gallery.filter((img) => img.hidden).length,
        },
        gallery: gallery.map((img) => ({
          id: img.id,
          prompt: img.prompt,
          fullPrompt: img.fullPrompt,
          seed: img.seed,
          width: img.width,
          height: img.height,
          createdAt: img.createdAt,
          model: img.model,
          liked: img.liked,
        })),
        runs: runs.map((run) => ({
          run_id: run.run_id,
          prompt: run.prompt,
          status: run.status,
          createdAt: run.createdAt,
          jobCount: run.jobs.length,
        })),
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `adrift-data-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setExportState("done");
      setTimeout(() => setExportState("idle"), 3000);
    } catch {
      setExportState("idle");
      showToast("Couldn't export your data. Try again.", "error");
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div className="microScrollbar flex-1 overflow-y-auto px-4 pb-6 md:px-6">
        <PageHeader
          title="Settings"
          subtitle="Appearance, devices, connections and your data"
        />
        <div className="mx-auto max-w-2xl space-y-4">
          {/* Appearance: light/dark/system, theme presets, accent */}
          <SettingCard title="Appearance">
            <AppearanceSettings />
          </SettingCard>

          {/* Profile page details — local only, no account */}
          <SettingCard title="Profile page">
            <div className="space-y-3 group">
              <EditableField
                label="Username"
                value={profile.username}
                onSave={(v) => updateProfile({ username: v || "user" })}
                placeholder="username"
                monospace
              />
              <EditableField
                label="Display Name"
                value={profile.displayName}
                onSave={(v) => updateProfile({ displayName: v || "User" })}
                placeholder="Display name"
              />
              <EditableField
                label="Bio"
                value={profile.bio}
                onSave={(v) => updateProfile({ bio: v })}
                placeholder="A short bio..."
              />
              <div className="flex items-center justify-between pt-1">
                <span className="text-xs text-light-500 dark:text-dark-400">
                  Stays on this device
                </span>
                <button
                  onClick={() => navigateTo("profile")}
                  className="flex items-center gap-1.5 rounded-xl border border-light-100 bg-light-50 px-3 py-1.5 text-xs font-medium text-light-600 transition-[color,background-color,border-color,transform] duration-150 hover:bg-light-100 active:scale-[0.96] dark:border-dark-750 dark:bg-dark-700 dark:text-dark-300 dark:hover:bg-dark-750"
                >
                  <User className="h-3.5 w-3.5" /> Open page
                </button>
              </div>
            </div>
          </SettingCard>

          <SettingCard title="Civitai Integration">
            <CivitaiSettings />
          </SettingCard>

          {/* Devices — hidden when sign-in is off */}
          <DevicesSettings />
          {/* Live previews while images render (ComfyUI preview_method) */}
          <SettingCard title="Live Previews">
            <LivePreviewSettings />
          </SettingCard>

          {/* Upscaler of choice: default per content type + lock */}
          <div data-tour="settings-upscaler">
            <SettingCard title="Upscaler">
              <UpscalerSettings />
            </SettingCard>
          </div>

          {/* Adrift recipe in output files (PNG chunk / video comment) */}
          <SettingCard title="Recipes">
            <RecipeEmbedSettings />
          </SettingCard>

          {/* Blender for "Open in Blender" and USDZ export */}
          <div id="settings-blender" className="scroll-mt-4">
            <SettingCard title="Blender">
              <BlenderSettings />
            </SettingCard>
          </div>

          {/* Video editor: how long saved projects keep their uploads */}
          <SettingCard title="Video Editor Storage">
            <VideoEditStorageSettings />
          </SettingCard>

          {/* Post-render video QC: auto re-roll + thresholds */}
          <SettingCard title="Video QC">
            <VideoQcSettingsCard />
          </SettingCard>

          <div data-tour="settings-connection">
            <SettingCard title="Connection Status">
              <div className="space-y-3">
                <div className="flex items-center justify-between rounded-xl border border-light-100 px-3 py-2 dark:border-dark-750">
                  <div className="flex items-center gap-2 text-sm text-light-primary dark:text-dark-primary">
                    <Link2 className="h-4 w-4 text-light-400 dark:text-dark-500" />
                    ComfyUI Backend
                  </div>
                  <div className="flex items-center gap-1.5">
                    {comfyReachable ? (
                      <>
                        <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
                        <span className="text-xs font-medium text-emerald-600 dark:text-emerald-300">
                          Connected
                        </span>
                      </>
                    ) : (
                      <>
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                        <span className="text-xs font-medium text-amber-600 dark:text-amber-300">
                          Unreachable
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-light-100 px-3 py-2 dark:border-dark-750">
                  <div className="flex items-center gap-2 text-sm text-light-primary dark:text-dark-primary">
                    <Zap className="h-4 w-4 text-light-400 dark:text-dark-500" />
                    WebSocket
                  </div>
                  <div className="flex items-center gap-1.5">
                    {wsConnected ? (
                      <>
                        <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
                        <span className="text-xs font-medium text-emerald-600 dark:text-emerald-300">
                          Connected
                        </span>
                      </>
                    ) : (
                      <>
                        <RefreshCw className="h-3.5 w-3.5 text-light-400 dark:text-dark-500" />
                        <span className="text-xs font-medium text-light-400 dark:text-dark-500">
                          Disconnected
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </SettingCard>
          </div>

          <div data-tour="settings-machines">
            <SettingCard title="ComfyUI machines">
              <ComfyInstancesSettings />
            </SettingCard>
          </div>

          <SettingCard title="Adrift inside ComfyUI">
            <OverlayInstallCard />
          </SettingCard>

          <div id="settings-training" data-tour="settings-training" className="scroll-mt-4">
            <SettingCard title="Training">
              <TrainingSettings />
            </SettingCard>
          </div>

          <SettingCard title="Generation Statistics">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {[
                { label: "Images", value: totalImages, color: "" },
                { label: "Jobs", value: totalRuns, color: "" },
                {
                  label: "Completed",
                  value: completedRuns,
                  color: "text-emerald-600 dark:text-emerald-300",
                },
                { label: "Errors", value: errorRuns, color: "text-rose-500" },
                { label: "Liked", value: likedImages, color: "text-splash" },
              ].map(({ label, value, color }) => (
                <div
                  key={label}
                  className="flex flex-col items-center justify-center rounded-xl border border-light-100 dark:border-dark-750 py-3 px-2"
                >
                  <span
                    className={`text-xl font-bold tabular-nums ${color || "text-light-primary dark:text-dark-primary"}`}
                  >
                    {value}
                  </span>
                  <span className="text-[10px] text-light-400 dark:text-dark-500 mt-0.5">
                    {label}
                  </span>
                </div>
              ))}
            </div>
          </SettingCard>

          <SettingCard title="Privacy">
            <p className="text-xs text-pretty text-light-500 dark:text-dark-400">
              Adrift runs on your own computer. It has no analytics or
              advertising cookies and sends no usage data anywhere. Outside
              sites such as Civitai are contacted only when you browse or
              download from them. If you set an admin key, one session cookie
              keeps you signed in.
            </p>
          </SettingCard>

          <SettingCard title="Data Export">
            <p className="text-xs text-light-500 dark:text-dark-400 mb-3">
              Download your gallery data, job history, and profile as a JSON
              file.
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={handleExport}
                disabled={exportState === "exporting"}
                className="flex min-h-10 items-center gap-2 rounded-xl border border-light-100 bg-light-50 px-4 py-2 text-sm font-medium text-light-600 transition-[color,background-color,border-color,transform] duration-150 hover:bg-light-100 active:scale-[0.96] disabled:opacity-40 dark:border-dark-750 dark:bg-dark-700 dark:text-dark-300 dark:hover:bg-dark-750"
              >
                {exportState === "exporting" ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : exportState === "done" ? (
                  <CheckCircle className="h-4 w-4 text-emerald-500" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {exportState === "exporting"
                  ? "Exporting..."
                  : exportState === "done"
                    ? "Downloaded!"
                    : "Export Data"}
              </button>
              {totalImages > 0 && (
                <span className="text-xs text-light-400 dark:text-dark-500">
                  {totalImages} image{totalImages !== 1 ? "s" : ""}, {totalRuns}{" "}
                  job{totalRuns !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          </SettingCard>
        </div>
      </div>
    </div>
  );
}

// CivitaiSettings

function CivitaiSettings() {
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState<{
    hasKey: boolean;
    source: string;
    showNsfw: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/civitai/auth");
      if (res.ok) setStatus(await res.json());
      else showToast("Couldn't load your Civitai settings.", "error");
    } catch {
      showToast("Couldn't load your Civitai settings.", "error");
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const saveKey = async () => {
    if (!keyInput.trim()) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const res = await fetch("/api/civitai/auth", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: keyInput.trim() }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Failed to save");
        return;
      }
      setKeyInput("");
      setSaved(true);
      fetchStatus();
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  };

  const removeKey = async () => {
    try {
      const res = await fetch("/api/civitai/auth", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fetchStatus();
    } catch {
      showToast("Couldn't remove the Civitai key. Try again.", "error");
    }
  };

  const toggleNsfw = async () => {
    if (!status) return;
    try {
      const res = await fetch("/api/civitai/auth", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ showNsfw: !status.showNsfw }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fetchStatus();
    } catch {
      showToast("Couldn't change the NSFW setting. Try again.", "error");
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-medium text-light-primary dark:text-dark-primary mb-1.5">
          API Key
        </p>
        {status?.hasKey ? (
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 rounded-xl border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 px-3 py-2">
              <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
              <span className="text-xs font-medium text-emerald-600 dark:text-emerald-300">
                Key configured
                {status.source === "env" ? " (from environment)" : ""}
              </span>
            </div>
            {status.source === "config" && (
              <button
                onClick={removeKey}
                className="rounded-full px-3 py-1.5 text-xs font-medium bg-light-100 dark:bg-dark-700 text-light-500 dark:text-dark-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500 dark:hover:text-red-400 transition-[color,background-color] duration-150"
              >
                Remove
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <input
                  aria-label="Civitai API key"
                  type={showKey ? "text" : "password"}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveKey()}
                  placeholder="Paste your Civitai API key…"
                  className="w-full rounded-lg border border-light-200 dark:border-dark-600 bg-white dark:bg-dark-800 px-3 py-2 pr-8 text-xs text-light-primary dark:text-dark-primary placeholder:text-light-400 dark:placeholder:text-dark-500 focus:outline-none focus:ring-1 focus:ring-splash"
                />
                <button
                  aria-label={showKey ? "Hide key" : "Show key"}
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-light-400 dark:text-dark-500 hover:text-light-600 dark:hover:text-dark-300"
                >
                  {showKey ? (
                    <EyeOff className="w-3.5 h-3.5" />
                  ) : (
                    <Eye className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
              <button
                onClick={saveKey}
                disabled={saving || !keyInput.trim()}
                className="flex items-center gap-1.5 rounded-xl border border-light-100 bg-light-50 px-3 py-2 text-xs font-medium text-light-600 transition-[color,background-color,border-color,transform] duration-150 hover:bg-light-100 active:scale-[0.96] disabled:opacity-40 dark:border-dark-750 dark:bg-dark-700 dark:text-dark-300 dark:hover:bg-dark-750"
              >
                {saving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Key className="w-3.5 h-3.5" />
                )}
                Save
              </button>
            </div>
            <p className="text-[10px] text-light-400 dark:text-dark-500">
              Get your key at{" "}
              <span className="font-medium text-light-500 dark:text-dark-400">
                civitai.com/user/account
              </span>
              {" → "}API Keys
            </p>
          </div>
        )}
        {error && <p className="mt-1 text-[10px] text-red-500">{error}</p>}
        {saved && (
          <p className="mt-1 text-[10px] text-emerald-500">
            Key saved and verified
          </p>
        )}
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-light-primary dark:text-dark-primary">
            NSFW Content
          </p>
          <p className="mt-0.5 text-[10px] text-light-400 dark:text-dark-500">
            Show NSFW results when browsing Civitai
          </p>
        </div>
        <PillToggle
          checked={status?.showNsfw ?? false}
          onChange={toggleNsfw}
          label="Show NSFW results"
        />
      </div>
    </div>
  );
}

export default AccountSettingsPage;
