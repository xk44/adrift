"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useUIStore } from "@/store";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { openOnboarding } from "@/store/onboardingStore";
import { startTour } from "@/store/tourStore";
import {
  startCurrentPageTour,
  tourEntryHint,
} from "@/components/tour/tourEntry";
import type { NavKey } from "@/types";
import {
  Search,
  Settings,
  Keyboard,
  FileImage,
  Moon,
  Palette,
  Compass,
  MapPin,
} from "lucide-react";
import { THEME_PRESETS } from "@/lib/theme/themes";
import { useIntegrations } from "@/hooks/useIntegrations";
import { NAV_DESTINATIONS, navigateToDestination } from "@/lib/ui/navRegistry";

interface Command {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  action: () => void;
  keywords?: string[];
  /** Short line under the label (what the page is for). */
  hint?: string;
  /** Single-key shortcut shown on the right. */
  shortcut?: string;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onShowKeyboardHelp: () => void;
  /**
   * Opens the Describe Image dialog. The dialog lives in the page shell, not
   * here: the palette unmounts when it closes, which would take the dialog with it.
   */
  onDescribe: () => void;
}

export interface PaletteCommandDeps {
  setActiveNav: (nav: NavKey) => void;
  setStylesHubTab: Parameters<typeof navigateToDestination>[1]["setStylesHubTab"];
  toggleSettings: () => void;
  toggleTheme: () => void;
  /** Apply a theme preset by id ("Theme: <name>" commands). */
  setPalette?: (paletteId: string) => void;
  onClose: () => void;
  onShowKeyboardHelp: () => void;
  onDescribe: () => void;
  /** Describe needs StyleVault (STYLEVAULT_API_URL); false hides it. */
  describeAvailable?: boolean;
}

/** Every palette command, in display order. Pure so it can be unit-tested. */
export function buildPaletteCommands({
  setActiveNav,
  setStylesHubTab,
  toggleSettings,
  toggleTheme,
  setPalette,
  onClose,
  onShowKeyboardHelp,
  onDescribe,
  describeAvailable = true,
}: PaletteCommandDeps): Command[] {
  return [
    // Every page, from the shared nav registry (same labels as the sidebar).
    ...NAV_DESTINATIONS.map<Command>((dest) => ({
      id: `nav-${dest.key}`,
      label: `Go to ${dest.label}`,
      icon: dest.icon,
      hint: dest.hint,
      shortcut: dest.shortcut,
      keywords: dest.keywords,
      action: () => {
        navigateToDestination(dest.key, { setActiveNav, setStylesHubTab });
        onClose();
      },
    })),
    {
      id: "toggle-settings",
      label: "Toggle Settings",
      icon: Settings,
      action: () => {
        toggleSettings();
        onClose();
      },
      keywords: ["preferences", "options", "config"],
    },
    ...(describeAvailable
      ? [
          {
            id: "describe-image",
            label: "Describe Image",
            icon: FileImage,
            action: () => {
              onDescribe();
              onClose();
            },
            keywords: ["image", "caption", "prompt", "describe"],
          },
        ]
      : []),
    {
      id: "focus-prompt",
      label: "Focus Prompt Bar",
      icon: Search,
      action: () => {
        const textarea = document.querySelector(
          "#desktop_input_bar",
        ) as HTMLTextAreaElement | null;
        textarea?.focus();
        onClose();
      },
      keywords: ["type", "input", "write"],
      shortcut: "/",
    },
    {
      id: "setup-adrift",
      label: "Setup guide (connection & starter packs)",
      icon: Settings,
      action: () => {
        openOnboarding();
        onClose();
      },
      keywords: ["onboarding", "comfyui", "connect", "gpu", "models", "download"],
    },
    {
      id: "take-tour",
      label: "Take the tour",
      icon: Compass,
      hint: tourEntryHint(),
      action: () => {
        onClose();
        startTour();
      },
      keywords: ["tour", "intro", "walkthrough", "guide", "help", "features", "resume"],
    },
    {
      id: "page-tour",
      label: "What's on this page",
      icon: MapPin,
      hint: "A few stops on the page you are on",
      action: () => {
        onClose();
        startCurrentPageTour();
      },
      keywords: ["tour", "page", "explain", "guide", "help", "this"],
    },
    {
      id: "keyboard-help",
      label: "Keyboard Shortcuts",
      icon: Keyboard,
      action: () => {
        onShowKeyboardHelp();
        onClose();
      },
      keywords: ["hotkeys", "bindings"],
      shortcut: "?",
    },
    {
      id: "toggle-theme",
      label: "Switch light / dark theme",
      icon: Moon,
      action: () => {
        toggleTheme();
        onClose();
      },
      keywords: ["theme", "dark", "light", "mode"],
    },
    ...(setPalette
      ? THEME_PRESETS.map<Command>((preset) => ({
          id: `theme-${preset.id}`,
          label: `Theme: ${preset.name}`,
          icon: Palette,
          hint: preset.description,
          action: () => {
            setPalette(preset.id);
            onClose();
          },
          keywords: ["theme", "palette", "appearance", "colors", preset.mode],
        }))
      : []),
  ];
}

export function CommandPalette({
  isOpen,
  onClose,
  onShowKeyboardHelp,
  onDescribe,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, isOpen, { onEscape: onClose });
  const setActiveNav = useUIStore((s) => s.setActiveNav);
  const toggleSettings = useUIStore((s) => s.toggleSettings);
  const setStylesHubTab = useUIStore((s) => s.setStylesHubTab);
  const toggleTheme = useUIStore((s) => s.toggleTheme);
  const setPalette = useUIStore((s) => s.setPalette);
  const describeAvailable = useIntegrations().styleVault;

  const commands = useMemo<Command[]>(
    () =>
      buildPaletteCommands({
        setActiveNav,
        setStylesHubTab,
        toggleSettings,
        toggleTheme,
        setPalette,
        onClose,
        onShowKeyboardHelp,
        onDescribe,
        describeAvailable,
      }),
    [
      setActiveNav,
      setStylesHubTab,
      toggleSettings,
      toggleTheme,
      setPalette,
      onClose,
      onShowKeyboardHelp,
      onDescribe,
      describeAvailable,
    ],
  );

  const filtered = useMemo(() => {
    if (!query) return commands;
    const q = query.toLowerCase();
    return commands.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(q) ||
        cmd.hint?.toLowerCase().includes(q) ||
        cmd.keywords?.some((k) => k.includes(q)),
    );
  }, [query, commands]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Keep the highlighted row visible while arrowing through the list.
  useEffect(() => {
    if (!isOpen) return;
    dialogRef.current
      ?.querySelector<HTMLElement>(`[data-cmd-index="${selectedIndex}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [isOpen, selectedIndex]);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && filtered[selectedIndex]) {
        e.preventDefault();
        filtered[selectedIndex].action();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Tab") {
        // Focus trap: keep focus within the dialog
        e.preventDefault();
      }
    },
    [filtered, selectedIndex, onClose],
  );

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-label="Command palette"
        aria-modal="true"
        className="fixed left-1/2 top-[10%] md:top-[20%] z-50 w-[calc(100%-2rem)] md:w-full max-w-lg -translate-x-1/2 rounded-2xl border border-light-100 bg-light-input shadow-2xl dark:border-dark-750 dark:bg-dark-input"
      >
        <div className="flex items-center gap-3 border-b border-light-100 px-4 dark:border-dark-750">
          <Search className="h-4 w-4 shrink-0 text-light-400 dark:text-dark-500" />
          <input
            aria-label="Search commands"
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            className="h-12 flex-1 bg-transparent text-sm text-light-primary outline-none placeholder:text-light-400 dark:text-dark-primary dark:placeholder:text-dark-500"
          />
          <kbd className="rounded border border-light-200 bg-light-50 px-1.5 py-0.5 text-[10px] font-medium text-light-500 dark:border-dark-600 dark:bg-dark-700 dark:text-dark-400">
            ESC
          </kbd>
        </div>
        <div
          className="max-h-80 overflow-y-auto p-2"
          role="listbox"
          aria-label="Commands"
        >
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-light-400 dark:text-dark-500">
              No matching commands
            </div>
          )}
          {filtered.map((cmd, i) => {
            const Icon = cmd.icon;
            return (
              <button
                key={cmd.id}
                role="option"
                data-cmd-index={i}
                aria-selected={i === selectedIndex}
                onClick={cmd.action}
                onMouseEnter={() => setSelectedIndex(i)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.96] ${
                  i === selectedIndex
                    ? "bg-light-100 text-light-primary dark:bg-dark-750 dark:text-dark-primary"
                    : "text-light-primary hover:bg-light-50 dark:text-dark-primary dark:hover:bg-dark-750"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{cmd.label}</span>
                  {cmd.hint && (
                    <span className="block truncate text-xs text-light-400 dark:text-dark-500">
                      {cmd.hint}
                    </span>
                  )}
                </span>
                {cmd.shortcut && (
                  <kbd className="shrink-0 rounded border border-light-200 bg-light-50 px-1.5 py-0.5 text-[10px] font-medium text-light-500 dark:border-dark-600 dark:bg-dark-700 dark:text-dark-400">
                    {cmd.shortcut}
                  </kbd>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

export default CommandPalette;
