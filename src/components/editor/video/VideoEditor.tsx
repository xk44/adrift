"use client";

/**
 * Edit tab, video mode: viewer (or before / after compare), side panel
 * (Tools / Select / Export / Results), transport and timeline. On phones the
 * panel moves under the timeline and the controls get simpler.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Crosshair,
  Download,
  Film,
  Music,
  Plus,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { showToast } from "@/components/Toast";
import {
  firstAudioFile,
  firstVideoFile,
  uploadVideo,
} from "@/lib/videoEdit/client";
import { useGenerationStore } from "@/store";
import { selectEditorAudio } from "../editorStartScreen";
import { addAudioFile, addAudioUrl, videoLabel } from "./openVideo";
import { timelineDuration, type EditList } from "@/lib/videoEdit/editList";
import { useVideoEditStore, type VideoPanel } from "@/store/videoEditStore";
import { VideoPlayer } from "./VideoPlayer";
import { VideoTimeline } from "./VideoTimeline";
import { VideoTransport } from "./VideoTransport";
import { VideoCompare } from "./VideoCompare";
import {
  VideoExportPanel,
  VideoResultsPanel,
  VideoSelectPanel,
  VideoToolsPanel,
} from "./VideoPanels";
import { VideoClipPanel } from "./VideoClipPanel";
import { useVideoKeys } from "./useVideoKeys";
import { useVideoToolReturns } from "./useVideoToolReturns";
import { useConfirm, type ConfirmOptions } from "@/components/ui/ConfirmDialog";

/**
 * Close the open project. With edits since the last full export, ask first
 * (false = the user kept it open).
 */
export async function closeVideoProject(
  confirm: (opts: ConfirmOptions) => Promise<boolean>,
): Promise<boolean> {
  if (
    useVideoEditStore.getState().dirty &&
    !(await confirm({
      title: "Close this video project?",
      message:
        "Edits since the last export are lost. Exports stay in the gallery.",
      confirmLabel: "Close project",
      cancelLabel: "Keep editing",
      danger: true,
    }))
  )
    return false;
  useVideoEditStore.getState().closeProject();
  return true;
}

const TABS: { id: VideoPanel; label: string; icon: typeof Film }[] = [
  { id: "tools", label: "Tools", icon: Sparkles },
  { id: "clip", label: "Clip", icon: SlidersHorizontal },
  { id: "select", label: "Select", icon: Crosshair },
  { id: "export", label: "Export", icon: Download },
  { id: "results", label: "Results", icon: Film },
];

function PanelTabs() {
  const panel = useVideoEditStore((s) => s.panel);
  const resultCount = useVideoEditStore(
    (s) => s.results.length + s.toolRuns.length,
  );
  const picks = useVideoEditStore((s) => s.picks.length);
  return (
    <div
      role="tablist"
      aria-label="Video editor panels"
      className="grid grid-cols-5 gap-1 rounded-lg bg-[var(--bg-secondary)] p-1"
    >
      {TABS.map(({ id, label, icon: Icon }) => {
        const count =
          id === "results" ? resultCount : id === "select" ? picks : 0;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={`vtab-${id}`}
            aria-selected={panel === id}
            aria-controls="video-panel"
            onClick={() => useVideoEditStore.getState().setPanel(id)}
            className={`flex h-8 items-center justify-center gap-1 rounded-md text-xs transition-colors ${
              panel === id
                ? "bg-[var(--bg-primary)] font-medium text-[var(--text-primary)] shadow-sm"
                : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {label}
            {count > 0 && (
              <span className="rounded-full bg-[var(--accent-primary)] px-1.5 text-[10px] leading-4 text-white">
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function PanelBody() {
  const panel = useVideoEditStore((s) => s.panel);
  return (
    <div
      id="video-panel"
      role="tabpanel"
      aria-labelledby={`vtab-${panel}`}
      className="flex min-h-0 flex-1 flex-col"
    >
      {panel === "tools" && <VideoToolsPanel />}
      {panel === "clip" && <VideoClipPanel />}
      {panel === "select" && <VideoSelectPanel />}
      {panel === "export" && <VideoExportPanel />}
      {panel === "results" && <VideoResultsPanel />}
    </div>
  );
}

export function VideoEditor() {
  const edit = useVideoEditStore((s) => s.edit) as EditList;
  const label = useVideoEditStore((s) => s.label);
  const compare = useVideoEditStore((s) =>
    s.results.find((r) => r.id === s.compareId && r.kind === "video"),
  );
  const phone = useMediaQuery("(max-width: 767px)");
  const fileRef = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<number | null>(null);

  const [confirm, confirmDialog] = useConfirm();

  useVideoKeys(true);
  useVideoToolReturns(true);

  const addFile = async (file: File | null) => {
    if (!file) return;
    setUpload(0);
    try {
      const src = await uploadVideo(file, setUpload);
      useVideoEditStore
        .getState()
        .appendSource(src, file.name.replace(/\.[^.]+$/, ""));
      showToast("Clip added to the end of the timeline.", "success");
    } catch (e) {
      showToast(
        `Could not add that video: ${e instanceof Error ? e.message : String(e)}`,
        "error",
        8000,
      );
    } finally {
      setUpload(null);
    }
  };

  const total = timelineDuration(edit);

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto bg-[var(--bg-primary)] p-2 md:overflow-hidden md:p-3"
      data-testid="video-editor"
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files"))
          e.preventDefault();
      }}
      onDrop={(e) => {
        const f = firstVideoFile(e.dataTransfer.files);
        if (f) {
          e.preventDefault();
          void addFile(f);
          return;
        }
        const a = firstAudioFile(e.dataTransfer.files);
        if (!a) return;
        e.preventDefault();
        void addAudioFile(a);
      }}
    >
      {confirmDialog}
      <header className="flex items-center gap-2">
        <Film
          className="h-4 w-4 shrink-0 text-[var(--text-muted)]"
          aria-hidden
        />
        <h2
          className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-primary)]"
          title={label}
        >
          {label}
          <span className="ml-2 font-normal text-[var(--text-muted)]">
            {edit.clips.length} clip{edit.clips.length === 1 ? "" : "s"} ·{" "}
            {total.toFixed(1)} s
          </span>
        </h2>
        <input
          ref={fileRef}
          type="file"
          accept="video/*"
          className="hidden"
          aria-label="Add a video file"
          onChange={(e) => {
            void addFile(firstVideoFile(e.target.files));
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={upload !== null}
          className="flex h-8 items-center gap-1 rounded-lg border border-[var(--border-secondary)] px-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
          title="Add a clip to the end (or drop a video file here)"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {upload !== null
            ? `Uploading ${Math.round(upload * 100)}%`
            : "Add clip"}
        </button>
        <AddAudioButton />
        <button
          type="button"
          aria-label="Close video"
          title="Close video (exports stay in the gallery)"
          onClick={() => void closeVideoProject(confirm)}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex shrink-0 flex-col gap-2 md:min-h-0 md:flex-1 md:shrink md:flex-row">
        <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded-lg md:aspect-auto md:h-auto md:min-h-0 md:flex-1">
          {compare ? <VideoCompare result={compare} /> : <VideoPlayer />}
        </div>
        {!phone && (
          <aside
            className="flex w-80 shrink-0 flex-col gap-2 overflow-hidden lg:w-96"
            aria-label="Video tools and export"
          >
            <PanelTabs />
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-1">
              <PanelBody />
            </div>
          </aside>
        )}
      </div>

      {!compare && <VideoTransport compact={phone} />}
      <VideoTimeline compact={phone} />

      {phone && (
        <section
          className="flex flex-col gap-2 pb-4"
          aria-label="Video tools and export"
        >
          <PanelTabs />
          <PanelBody />
        </section>
      )}
    </div>
  );
}

/** "Add audio": a file, or recent gallery audio, onto the A2 lane. */
function AddAudioButton() {
  const gallery = useGenerationStore((s) => s.gallery);
  const recent = useMemo(() => selectEditorAudio(gallery, 8), [gallery]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof PointerEvent && boxRef.current?.contains(e.target as Node))
        return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  const run = async (op: () => Promise<boolean>) => {
    setOpen(false);
    setBusy(0);
    await op();
    setBusy(null);
  };

  return (
    <div className="relative" ref={boxRef}>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,.mp3,.wav,.flac,.ogg,.opus,.m4a,.aac"
        className="hidden"
        aria-label="Add an audio file"
        onChange={(e) => {
          const f = firstAudioFile(e.target.files);
          e.target.value = "";
          if (f) void run(() => addAudioFile(f, undefined, setBusy));
        }}
      />
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy !== null}
        onClick={() =>
          recent.length ? setOpen((o) => !o) : fileRef.current?.click()
        }
        className="flex h-8 items-center gap-1 rounded-lg border border-[var(--border-secondary)] px-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
        title="Music or voice-over on the audio lane, at the playhead (or drop an audio file)"
      >
        <Music className="h-3.5 w-3.5" aria-hidden />
        {busy !== null ? `Uploading ${Math.round(busy * 100)}%` : "Add audio"}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Add audio"
          className="absolute right-0 top-9 z-50 flex w-64 flex-col rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] p-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            className="rounded-md px-2 py-1.5 text-left text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
            onClick={() => {
              setOpen(false);
              fileRef.current?.click();
            }}
          >
            From a file...
          </button>
          <p className="px-2 pt-1.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
            Recent audio
          </p>
          {recent.map((a) => (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              title={a.prompt}
              className="truncate rounded-md px-2 py-1.5 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              onClick={() =>
                void run(() => addAudioUrl(a.url, a.prompt))
              }
            >
              {videoLabel(a.prompt)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
