"use client";

import { useState, useRef, useCallback, useEffect, KeyboardEvent } from "react";
import type { SpeedSetting } from "@/lib/oj/speedTier";
import { useEditorStore } from "@/store/editorStore";
import { useUIStore } from "@/store";
import {
  Send,
  Settings2,
  Loader2,
  Grid3X3,
  Plus,
  ChevronDown,
  Check,
} from "lucide-react";

interface EditorPromptBarProps {
  onSubmit: (prompt: string) => Promise<void>;
  isLoading?: boolean;
}

// Parameter presets for the P dropdown

interface EditorPreset {
  id: string;
  name: string;
  description: string;
  aspect: string;
  stylize: number;
  modelMode: "Standard" | "Raw";
  quality: number;
  speed: SpeedSetting;
}

const EDITOR_PRESETS: EditorPreset[] = [
  {
    id: "default",
    name: "Default",
    description: "1:1 · Standard · Stylize 100",
    aspect: "1:1",
    stylize: 100,
    modelMode: "Standard",
    quality: 1,
    speed: "Standard",
  },
  {
    id: "wide",
    name: "Wide",
    description: "16:9 · Standard · Stylize 100",
    aspect: "16:9",
    stylize: 100,
    modelMode: "Standard",
    quality: 1,
    speed: "Standard",
  },
  {
    id: "portrait",
    name: "Portrait",
    description: "9:16 · Standard · Stylize 100",
    aspect: "9:16",
    stylize: 100,
    modelMode: "Standard",
    quality: 1,
    speed: "Standard",
  },
  {
    id: "high-stylize",
    name: "High Stylize",
    description: "1:1 · Standard · Stylize 500",
    aspect: "1:1",
    stylize: 500,
    modelMode: "Standard",
    quality: 1,
    speed: "Standard",
  },
  {
    id: "raw",
    name: "Raw Mode",
    description: "1:1 · Raw · Stylize 100",
    aspect: "1:1",
    stylize: 100,
    modelMode: "Raw",
    quality: 1,
    speed: "Standard",
  },
  {
    id: "quality",
    name: "High Quality",
    description: "1:1 · Standard · Quality 2 · Quality speed",
    aspect: "1:1",
    stylize: 100,
    modelMode: "Standard",
    quality: 2,
    speed: "Quality",
  },
  {
    id: "cinematic",
    name: "Cinematic",
    description: "21:9 · Raw · Stylize 250",
    aspect: "21:9",
    stylize: 250,
    modelMode: "Raw",
    quality: 1,
    speed: "Standard",
  },
  {
    id: "creative",
    name: "Creative",
    description: "1:1 · Standard · Stylize 750",
    aspect: "1:1",
    stylize: 750,
    modelMode: "Standard",
    quality: 1,
    speed: "Standard",
  },
];

export function EditorPromptBar({
  onSubmit,
  isLoading = false,
}: EditorPromptBarProps) {
  // Use Zustand store so prompt text persists across nav changes
  const promptValue = useUIStore((s) => s.promptValue);
  const setPromptValueStore = useUIStore((s) => s.setPromptValue);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [presetDropdownOpen, setPresetDropdownOpen] = useState(false);
  const presetDropdownRef = useRef<HTMLDivElement | null>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!presetDropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (
        presetDropdownRef.current &&
        !presetDropdownRef.current.contains(e.target as Node)
      ) {
        setPresetDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [presetDropdownOpen]);

  const sourceImage = useEditorStore((s) => s.sourceImage);
  const toggleSettings = useUIStore((s) => s.toggleSettings);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const clearSourceImage = useEditorStore((s) => s.clearSourceImage);
  const closeEditor = useEditorStore((s) => s.closeEditor);
  const setActiveNav = useUIStore((s) => s.setActiveNav);
  const settings = useUIStore((s) => s.settings);
  const updateSettings = useUIStore((s) => s.updateSettings);

  const isPresetActive = useCallback(
    (preset: EditorPreset) => {
      return (
        settings.aspect === preset.aspect &&
        settings.stylize === preset.stylize &&
        settings.modelMode === preset.modelMode &&
        settings.quality === preset.quality &&
        settings.speed === preset.speed
      );
    },
    [settings],
  );

  const handleApplyPreset = useCallback(
    (preset: EditorPreset) => {
      updateSettings({
        aspect: preset.aspect,
        stylize: preset.stylize,
        modelMode: preset.modelMode,
        quality: preset.quality,
        speed: preset.speed,
      });
      setPresetDropdownOpen(false);
    },
    [updateSettings],
  );

  // Why Submit is off, in the button's tooltip (null = ready).
  const submitHint = !sourceImage
    ? "Load an image first"
    : isLoading
      ? "Sending the edit…"
      : !promptValue.trim()
        ? "Describe the change first"
        : null;

  const handleSubmit = useCallback(async () => {
    if (!promptValue.trim() || isLoading || !sourceImage) return;
    await onSubmit(promptValue);
  }, [promptValue, isLoading, sourceImage, onSubmit]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setPromptValueStore(e.target.value);
      const textarea = e.target;
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    },
    [setPromptValueStore],
  );

  return (
    <div className="flex flex-wrap items-center gap-2 sm:gap-3 sm:flex-nowrap px-4 py-3 border-b border-[var(--border-primary)] bg-[var(--bg-primary)]">
      {/* Left: Icon */}
      <div className="hidden sm:flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-[var(--bg-tertiary)] flex items-center justify-center">
          <Grid3X3 className="w-4 h-4 text-[var(--text-secondary)]" />
        </div>
      </div>

      {/* Prompt input */}
      <div
        className={`min-w-0 basis-full sm:basis-auto flex-1 flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-primary)] transition-colors ${
          isFocused
            ? "border-[var(--accent-primary)] ring-1 ring-[var(--accent-primary)]"
            : ""
        }`}
      >
        <textarea
          aria-label="Prompt"
          ref={inputRef}
          value={promptValue}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          placeholder="Describe the change…"
          className="flex-1 bg-transparent border-none outline-none resize-none text-[var(--text-primary)] placeholder:text-[var(--text-muted)] min-h-[24px] max-h-[120px] text-sm"
          rows={1}
          disabled={isLoading || !sourceImage}
        />
      </div>

      {/* Right actions */}
      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
        <button
          onClick={toggleSettings}
          className={`btn-ghost btn-icon ${
            settingsOpen
              ? "bg-[var(--bg-hover)] text-[var(--text-primary)]"
              : ""
          }`}
          title="Settings"
          aria-label="Settings"
        >
          <Settings2 className="w-5 h-5" />
        </button>

        {/* P dropdown — parameter presets */}
        <div
          className="relative"
          ref={(el) => {
            presetDropdownRef.current = el;
          }}
        >
          <button
            onClick={() => setPresetDropdownOpen((v) => !v)}
            className="btn-ghost btn-icon flex items-center gap-1 px-2"
            title="Presets"
            aria-label="Presets"
          >
            <span className="text-sm font-medium">Presets</span>
            <ChevronDown
              className={`w-3 h-3 text-[var(--text-muted)] transition-transform ${presetDropdownOpen ? "rotate-180" : ""}`}
            />
          </button>
          {presetDropdownOpen && (
            <div className="absolute right-0 top-full mt-2 w-64 bg-[var(--bg-secondary)] border border-[var(--border-primary)] rounded-lg shadow-xl z-50 py-1 max-h-80 overflow-y-auto micro-scrollbar">
              {EDITOR_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => handleApplyPreset(preset)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-hover)] transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-[var(--text-primary)] truncate">
                      {preset.name}
                    </div>
                    <div className="text-xs text-[var(--text-muted)] truncate">
                      {preset.description}
                    </div>
                  </div>
                  {isPresetActive(preset) && (
                    <Check className="w-4 h-4 text-[var(--accent-primary)] shrink-0" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          aria-label={isLoading ? "Submitting edit…" : "Submit edit"}
          title={submitHint ?? "Send the edit (Enter)"}
          data-testid="editor-submit"
          onClick={handleSubmit}
          disabled={submitHint !== null}
          className="btn btn-primary text-sm"
        >
          {isLoading ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <>
              <span className="sm:hidden">Submit</span>
              <span className="hidden sm:inline">Submit Edit</span>
            </>
          )}
        </button>

        {/* View All — back to the gallery grid */}
        <button
          onClick={() => {
            closeEditor();
            setActiveNav("create");
          }}
          className="btn btn-secondary flex items-center gap-2 text-sm"
          title="View all images"
          aria-label="View all images"
        >
          <Grid3X3 className="w-4 h-4" />
          <span className="hidden sm:inline">View All</span>
        </button>

        {/* Nothing to start over from until an image is open */}
        {sourceImage && (
          <button
            type="button"
            onClick={() => {
              clearSourceImage();
            }}
            className="btn btn-secondary flex items-center gap-2 text-sm"
            title="Start over with another image"
            aria-label="New image"
            data-testid="editor-new"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">New</span>
          </button>
        )}
      </div>
    </div>
  );
}

export default EditorPromptBar;
