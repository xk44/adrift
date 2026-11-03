"use client";

import { useRef } from "react";
import { X, Keyboard } from "lucide-react";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { destinationForNav, navShortcutMap } from "@/lib/ui/navRegistry";
import { EDITOR_SHORTCUTS } from "@/components/editor/editorKeys";
import { VIDEO_SHORTCUTS } from "@/lib/videoEdit/keys";

export interface ShortcutItem {
  keys: string[];
  description: string;
}

export interface ShortcutSection {
  title: string;
  items: ShortcutItem[];
}

/** App-wide keys handled in app/page.tsx. */
const GENERAL: ShortcutItem[] = [
  { keys: ["Ctrl/Cmd", "K"], description: "Open command palette (find any page)" },
  { keys: ["/"], description: "Jump to the prompt bar" },
  { keys: ["Enter"], description: "Submit prompt" },
  { keys: ["Shift+Enter"], description: "New line in prompt" },
  { keys: ["Ctrl/Cmd", "S"], description: "Show or hide the settings panel" },
  { keys: ["Esc"], description: "Close modal / Cancel" },
  { keys: ["?"], description: "Show this help" },
];

/** Keys handled by the image viewer (Lightbox.tsx). */
const LIGHTBOX: ShortcutItem[] = [
  { keys: ["←", "→"], description: "Navigate images (in lightbox)" },
  { keys: ["C"], description: "Compare images (in lightbox)" },
  { keys: ["E"], description: "Quick edit (in lightbox)" },
  { keys: ["T"], description: "Tools panel (in lightbox; Esc closes it)" },
];

/** Keys handled while painting a mask (QuickEditOverlay.tsx). */
const QUICK_EDIT: ShortcutItem[] = [
  { keys: ["[", "]"], description: "Brush size (quick edit)" },
  { keys: ["Ctrl/Cmd", "Z"], description: "Undo stroke (quick edit)" },
];

/** Keys on the Edit page image canvas (editorKeys.ts drives the handler). */
const EDITOR: ShortcutItem[] = EDITOR_SHORTCUTS.map(([keys, description]) => ({
  keys: [keys],
  description,
}));

/** Keys in the video editor (useVideoKeys.ts). */
const VIDEO: ShortcutItem[] = VIDEO_SHORTCUTS.map(([keys, description]) => ({
  keys: [keys],
  description,
}));

/**
 * Every section shown in the dialog. The "Go to" list is generated from the
 * nav registry, so it always matches the number keys app/page.tsx handles.
 */
export function shortcutSections(): ShortcutSection[] {
  const goTo = Object.entries(navShortcutMap())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nav]) => ({
      keys: [key],
      description: `Go to ${destinationForNav(nav)?.label ?? nav}`,
    }));
  return [
    { title: "General", items: GENERAL },
    { title: "Go to", items: goTo },
    { title: "Image viewer", items: LIGHTBOX },
    { title: "Quick edit", items: QUICK_EDIT },
    { title: "Edit page (image)", items: EDITOR },
    { title: "Edit page (video)", items: VIDEO },
  ];
}

interface KeyboardHelpProps {
  isOpen: boolean;
  onClose: () => void;
}

export function KeyboardHelp({ isOpen, onClose }: KeyboardHelpProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Escape goes through the dialog stack (topmost layer only) and is marked
  // handled, so the page's global Escape doesn't also close a lightbox or
  // settings underneath.
  useDialogFocus(dialogRef, isOpen, { onEscape: onClose });

  if (!isOpen) return null;

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div
        className="bg-[var(--bg-secondary)] rounded-lg shadow-xl p-6 max-w-md w-full mx-4 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-medium text-[var(--text-primary)] flex items-center gap-2">
            <Keyboard className="w-5 h-5" />
            Keyboard Shortcuts
          </h2>
          <button
            onClick={onClose}
            className="btn-ghost btn-icon"
            aria-label="Close keyboard shortcuts"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          {shortcutSections().map((section) => (
            <section key={section.title}>
              <h3 className="mb-1.5 text-[11px] font-medium text-[var(--text-tertiary)]">
                {section.title}
              </h3>
              <div className="space-y-2">
                {section.items.map((shortcut) => (
                  <div
                    key={shortcut.description}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="text-sm text-[var(--text-secondary)]">
                      {shortcut.description}
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      {shortcut.keys.map((key, j) => (
                        <kbd
                          key={j}
                          className="px-2 py-0.5 text-xs font-mono bg-[var(--bg-tertiary)] border border-[var(--border-primary)] rounded"
                        >
                          {key}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        <p className="mt-4 text-xs text-[var(--text-muted)] text-center">
          Press{" "}
          <kbd className="px-1 py-0.5 text-xs font-mono bg-[var(--bg-tertiary)] border border-[var(--border-primary)] rounded">
            Esc
          </kbd>{" "}
          to close
        </p>
      </div>
    </div>
  );
}

export default KeyboardHelp;
