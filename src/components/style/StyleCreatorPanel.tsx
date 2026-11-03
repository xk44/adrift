"use client";

import { useMemo } from "react";
import { ImagePlus, Layers, X } from "lucide-react";
import { useGallerySelectionStore } from "@/store/gallerySelectionStore";
import { StyleCreatorHome } from "./StyleCreatorHome";
import { StyleSessionView } from "./StyleSessionView";
import type { StyleSession } from "./styleCreatorLogic";
import type { CreatorSeed } from "@/lib/stylesHub";

export interface StyleCreatorPanelProps {
  /** null = start screen; otherwise the open session id. */
  sessionId: string | null;
  sessions: readonly StyleSession[];
  seed: CreatorSeed | null;
  onClose: () => void;
  /** Create a session (from the start screen) and open it. */
  onStart: (prompt: string, imageIds: readonly string[]) => void;
  onOpenSession: (id: string | null) => void;
  updateSession: (id: string, update: Partial<StyleSession>) => void;
  deleteSession: (id: string) => void;
}

/**
 * The style creator as a side panel of the Styles page. Static column on
 * wide screens, full-screen sheet on small ones. Seeded from style cards,
 * the blend tray, a LoRA, or images selected in the Create feed.
 */
export function StyleCreatorPanel({
  sessionId,
  sessions,
  seed,
  onClose,
  onStart,
  onOpenSession,
  updateSession,
  deleteSession,
}: StyleCreatorPanelProps) {
  const selected = useGallerySelectionStore((s) => s.selected);
  const selectedIds = useMemo(() => [...selected], [selected]);
  const seedImages = seed?.imageIds ?? [];

  return (
    <aside
      aria-label="Style creator"
      data-testid="style-creator-panel"
      className="fixed inset-0 z-40 flex flex-col bg-[var(--bg-primary)] lg:static lg:z-auto lg:w-[440px] lg:flex-shrink-0 lg:border-l lg:border-[var(--border-primary)] xl:w-[500px]"
    >
      <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--border-primary)] px-4 py-3">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">
          {sessionId ? "Style session" : "New style"}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close creator"
          className="rounded-md p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="microScrollbar min-h-0 flex-1 overflow-y-auto">
        {sessionId ? (
          <StyleSessionView
            sessionId={sessionId}
            sessions={sessions}
            compact
            backLabel="New style"
            onBack={() => onOpenSession(null)}
            onCreateSession={() => onStart("", [])}
            updateSession={updateSession}
            deleteSession={(id) => {
              deleteSession(id);
              onOpenSession(null);
            }}
          />
        ) : (
          <div className="px-4 pb-6">
            <StyleCreatorHome
              variant="panel"
              sessions={sessions}
              seed={
                seed ? { prompt: seed.prompt, nonce: seed.nonce } : undefined
              }
              onStart={(prompt) => onStart(prompt, seedImages)}
              extra={
                <div className="mt-4 space-y-4">
                  {seedImages.length > 0 && (
                    <p className="text-xs text-[var(--text-muted)]">
                      {seedImages.length} image
                      {seedImages.length === 1 ? "" : "s"} will be pre-selected
                      in the new session.
                    </p>
                  )}
                  {selectedIds.length > 0 && (
                    <button
                      type="button"
                      onClick={() => onStart("", selectedIds)}
                      data-testid="style-creator-from-selection"
                      className="flex w-full items-center gap-2 rounded-lg border border-[var(--border-primary)] px-3 py-2 text-left text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--accent-primary)] hover:text-[var(--text-primary)]"
                    >
                      <ImagePlus className="h-4 w-4 flex-shrink-0" />
                      Start from the {selectedIds.length} image
                      {selectedIds.length === 1 ? "" : "s"} selected in Create
                    </button>
                  )}
                  {sessions.length > 0 && (
                    <div>
                      <p className="mb-2 text-[11px] font-medium text-[var(--text-muted)]">
                        Sessions
                      </p>
                      <ul className="space-y-1">
                        {sessions.map((session) => (
                          <li key={session.id}>
                            <button
                              type="button"
                              onClick={() => onOpenSession(session.id)}
                              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--bg-hover)]"
                            >
                              <Layers className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
                              <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
                                {session.name}
                              </span>
                              <span className="text-[10px] text-[var(--text-muted)]">
                                {session.selectedImageIds.length} img ·{" "}
                                {session.status}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              }
            />
          </div>
        )}
      </div>
    </aside>
  );
}

export default StyleCreatorPanel;
