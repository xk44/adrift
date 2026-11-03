/**
 * Video editor (Edit tab, video mode): the open project's edit list with
 * undo/redo, transport (playhead, shuttle rate, in/out, loop), the smart
 * selection, and tool runs / results waiting to be compared. The edit list,
 * range and results persist, so a reload keeps the project.
 */

import { createWithEqualityFn } from "zustand/traditional";
import { persist } from "zustand/middleware";
import {
  addAudioClip,
  addClip,
  audioClipFromSource,
  clipFromSource,
  clipLength,
  clipStarts,
  emptyEditList,
  timelineDuration,
  type AudioSource,
  type EditList,
  type VideoSource,
} from "@/lib/videoEdit/editList";
import type { SelectionPick, VideoToolRun } from "@/lib/videoEdit/videoTools";
import {
  DEFAULT_EXPORT,
  parseExportSettings,
  type ExportSettings,
} from "@/lib/videoEdit/requests";
import { STORAGE_KEYS, legacyAwareJSONStorage } from "@/lib/storageKeys";
import { useEditorStore } from "@/store/editorStore";
import { installProjectRefsSync } from "@/lib/videoEdit/projectRefsSync";

export const UNDO_LIMIT = 100;
export const SPEEDS = [0.25, 0.5, 1, 1.5, 2] as const;
/** J / L shuttle steps (multiples of the chosen speed). */
export const SHUTTLE_MAX = 8;

/** A tool result waiting to be compared, accepted or discarded. */
export interface VideoResult {
  id: string;
  title: string;
  runId: string;
  jobIndex: number;
  /** Timeline range it was made from. */
  start: number;
  end: number;
  /** The cut that went in (compare "before"). */
  cutUrl: string;
  kind: "video" | "image";
  url: string;
  /** Probed source (videos only), ready to become a clip. */
  source: VideoSource | null;
  at: number;
  /** User's choice over the defaults (conformPlan) when placing it. */
  keepAudio?: boolean;
  matchFps?: boolean;
}

/** Tool opened from the panel whose run id is not known yet. */
export interface ToolLaunch {
  /** The hand-off's itemId: the runner reports it back with its run id. */
  itemId: string;
  title: string;
  start: number;
  end: number;
  cutUrl: string;
  at: number;
}

export type VideoPanel = "tools" | "clip" | "select" | "export" | "results";

/** Edits with the same merge key this close together are one undo step. */
export const MERGE_WINDOW_MS = 1500;

interface VideoEditState {
  /** null = no video project (the Edit tab shows the image editor / start). */
  edit: EditList | null;
  label: string;
  /** Video mode is on screen (false: an image was opened in the editor since). */
  active: boolean;
  /**
   * Random id for the open project. The server keeps the uploads a project
   * uses while it is registered under this id (see useProjectRefs).
   */
  projectId: string | null;
  /** Edits since the last full export (closing asks first). */
  dirty: boolean;
  past: EditList[];
  future: EditList[];
  /** Last coalescing edit (slider drags): key + time. */
  lastMerge: { key: string; at: number } | null;

  playhead: number;
  /** Signed playback rate; 0 = paused, negative = reverse (J). */
  rate: number;
  /** Speed chosen in the menu (Space / L start at this). */
  speed: number;
  /** Bumped on every user seek so a playing engine re-syncs its <video>. */
  seekSeq: number;
  inPoint: number | null;
  outPoint: number | null;
  loop: boolean;
  selectedClipId: string | null;
  /** Selected A2 lane clip (exclusive with selectedClipId). */
  selectedAudioId: string | null;
  /** Timeline drags snap to cuts, marks and the playhead. */
  snap: boolean;
  exportSettings: ExportSettings;

  /** Smart selection: subject clicks on frames (timeline time). */
  picks: SelectionPick[];
  /** Clicks on the picture add points (instead of play/pause). */
  selecting: boolean;

  /** Recent tool launches, newest last (a few, for runs not reported yet). */
  launches: ToolLaunch[];
  toolRuns: VideoToolRun[];
  results: VideoResult[];
  compareId: string | null;
  panel: VideoPanel;

  openProject: (source: VideoSource, label: string) => void;
  appendSource: (source: VideoSource, label: string) => void;
  closeProject: () => void;
  /** A full-timeline export landed: nothing unsaved now. */
  markSaved: () => void;
  setActive: (on: boolean) => void;
  /**
   * Apply an edit (undoable). No-op when `fn` returns the same list. Edits
   * sharing `mergeKey` within MERGE_WINDOW_MS fold into one undo step.
   */
  apply: (fn: (edit: EditList) => EditList, mergeKey?: string) => void;
  undo: () => void;
  redo: () => void;

  seek: (t: number) => void;
  /** Engine-only: follow playback without counting as a user seek. */
  tick: (t: number) => void;
  setRate: (rate: number) => void;
  togglePlay: () => void;
  shuttle: (dir: -1 | 0 | 1) => void;
  setSpeed: (speed: number) => void;
  setIn: (t: number | null) => void;
  setOut: (t: number | null) => void;
  clearRange: () => void;
  toggleLoop: () => void;
  selectClip: (id: string | null) => void;
  selectAudio: (id: string | null) => void;
  /** Put an audio file on the A2 lane at `start` (default: the playhead). */
  addAudio: (source: AudioSource, label: string, start?: number) => void;
  toggleSnap: () => void;
  setExportSettings: (patch: Partial<ExportSettings>) => void;

  setPicks: (picks: SelectionPick[]) => void;
  setSelecting: (on: boolean) => void;

  addLaunch: (launch: ToolLaunch) => void;
  /** Pair a queued run with its launch (by hand-off itemId; else the newest). */
  trackToolRun: (runId: string, title: string, itemId?: string) => void;
  untrackToolRun: (runId: string) => void;
  addResult: (result: VideoResult) => void;
  removeResult: (id: string) => void;
  setResultOptions: (
    id: string,
    patch: Pick<VideoResult, "keepAudio" | "matchFps">,
  ) => void;
  setCompare: (id: string | null) => void;
  setPanel: (panel: VideoPanel) => void;
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));

/** Keep the transport inside a (possibly shorter) timeline. */
function fitTransport(
  s: Pick<VideoEditState, "playhead" | "inPoint" | "outPoint">,
  edit: EditList,
) {
  const total = timelineDuration(edit);
  const inPoint = s.inPoint === null || s.inPoint >= total ? null : s.inPoint;
  let outPoint = s.outPoint === null ? null : Math.min(s.outPoint, total);
  if (outPoint !== null && inPoint !== null && outPoint <= inPoint)
    outPoint = null;
  return { playhead: clamp(s.playhead, 0, total), inPoint, outPoint };
}

const FRESH = {
  past: [] as EditList[],
  future: [] as EditList[],
  lastMerge: null,
  playhead: 0,
  rate: 0,
  seekSeq: 0,
  inPoint: null,
  outPoint: null,
  selectedClipId: null,
  selectedAudioId: null,
  picks: [] as SelectionPick[],
  selecting: false,
  launches: [],
  compareId: null,
};

/** Id for a new project (URL-safe, 16 chars). */
export function newProjectId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "").slice(0, 16);
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  ).slice(0, 16);
}

export const useVideoEditStore = createWithEqualityFn<VideoEditState>()(
  persist(
    (set, get) => ({
      edit: null,
      label: "",
      active: false,
      projectId: null,
      dirty: false,
      ...FRESH,
      speed: 1,
      loop: false,
      snap: true,
      exportSettings: DEFAULT_EXPORT,
      toolRuns: [],
      results: [],
      panel: "tools",

      openProject: (source, label) => {
        const clip = clipFromSource(source, label || "Clip");
        set({
          ...FRESH,
          edit: addClip(emptyEditList(), clip),
          label: label || "Untitled video",
          active: true,
          projectId: newProjectId(),
          dirty: false,
          selectedClipId: clip.id,
          results: [],
          toolRuns: [],
          panel: "tools",
        });
      },
      appendSource: (source, label) => {
        const s = get();
        if (!s.edit) {
          s.openProject(source, label);
          return;
        }
        const clip = clipFromSource(source, label || "Clip");
        s.apply((e) => addClip(e, clip));
        set({ selectedClipId: clip.id, selectedAudioId: null, active: true });
      },
      closeProject: () =>
        set({
          ...FRESH,
          edit: null,
          label: "",
          active: false,
          projectId: null,
          dirty: false,
          results: [],
          toolRuns: [],
        }),
      markSaved: () => set({ dirty: false }),
      setActive: (on) => set({ active: on && get().edit !== null, rate: 0 }),

      apply: (fn, mergeKey) => {
        const s = get();
        if (!s.edit) return;
        const next = fn(s.edit);
        if (next === s.edit) return;
        const now = Date.now();
        const merge =
          mergeKey !== undefined &&
          s.lastMerge?.key === mergeKey &&
          now - s.lastMerge.at < MERGE_WINDOW_MS &&
          s.past.length > 0 &&
          s.future.length === 0;
        set({
          edit: next,
          past: merge ? s.past : [...s.past, s.edit].slice(-UNDO_LIMIT),
          future: [],
          lastMerge: mergeKey !== undefined ? { key: mergeKey, at: now } : null,
          dirty: true,
          ...fitTransport(s, next),
          selectedClipId: next.clips.some((c) => c.id === s.selectedClipId)
            ? s.selectedClipId
            : null,
          selectedAudioId: next.audio?.some((c) => c.id === s.selectedAudioId)
            ? s.selectedAudioId
            : null,
        });
      },
      undo: () => {
        const s = get();
        const prev = s.past[s.past.length - 1];
        if (!prev || !s.edit) return;
        set({
          edit: prev,
          past: s.past.slice(0, -1),
          future: [s.edit, ...s.future].slice(0, UNDO_LIMIT),
          lastMerge: null,
          dirty: true,
          ...fitTransport(s, prev),
          seekSeq: s.seekSeq + 1,
        });
      },
      redo: () => {
        const s = get();
        const next = s.future[0];
        if (!next || !s.edit) return;
        set({
          edit: next,
          past: [...s.past, s.edit].slice(-UNDO_LIMIT),
          future: s.future.slice(1),
          lastMerge: null,
          dirty: true,
          ...fitTransport(s, next),
          seekSeq: s.seekSeq + 1,
        });
      },

      seek: (t) => {
        const s = get();
        const total = s.edit ? timelineDuration(s.edit) : 0;
        set({ playhead: clamp(t, 0, total), seekSeq: s.seekSeq + 1 });
      },
      tick: (t) => {
        if (get().playhead !== t) set({ playhead: t });
      },
      setRate: (rate) => set({ rate: clamp(rate, -SHUTTLE_MAX, SHUTTLE_MAX) }),
      togglePlay: () => {
        const s = get();
        if (s.rate !== 0) {
          set({ rate: 0 });
          return;
        }
        // Play from the start again when parked at the end.
        const total = s.edit ? timelineDuration(s.edit) : 0;
        const end = s.loop && s.outPoint !== null ? s.outPoint : total;
        if (s.playhead >= end - 1e-3) {
          const from = s.loop && s.inPoint !== null ? s.inPoint : 0;
          set({ playhead: from, seekSeq: s.seekSeq + 1 });
        }
        set({ rate: s.speed });
      },
      shuttle: (dir) => {
        const s = get();
        if (dir === 0) {
          set({ rate: 0 });
          return;
        }
        const base = s.speed * dir;
        const same = Math.sign(s.rate) === dir;
        const next = same ? s.rate * 2 : base;
        set({
          rate: clamp(next, -SHUTTLE_MAX * s.speed, SHUTTLE_MAX * s.speed),
        });
      },
      setSpeed: (speed) => {
        const s = get();
        const v = clamp(speed, 0.1, 4);
        set({ speed: v, rate: s.rate > 0 ? v : s.rate < 0 ? -v : 0 });
      },
      setIn: (t) => {
        const s = get();
        if (t === null) {
          set({ inPoint: null });
          return;
        }
        const out = s.outPoint !== null && s.outPoint <= t ? null : s.outPoint;
        set({ inPoint: Math.max(0, t), outPoint: out });
      },
      setOut: (t) => {
        const s = get();
        if (t === null) {
          set({ outPoint: null });
          return;
        }
        const inP = s.inPoint !== null && s.inPoint >= t ? null : s.inPoint;
        set({ outPoint: t, inPoint: inP });
      },
      clearRange: () => set({ inPoint: null, outPoint: null }),
      toggleLoop: () => set({ loop: !get().loop }),
      selectClip: (id) =>
        set(id ? { selectedClipId: id, selectedAudioId: null } : { selectedClipId: null }),
      selectAudio: (id) =>
        set(id ? { selectedAudioId: id, selectedClipId: null } : { selectedAudioId: null }),
      addAudio: (source, label, start) => {
        const s = get();
        if (!s.edit) return;
        const clip = audioClipFromSource(source, label || "Audio", start ?? s.playhead);
        const before = s.edit;
        s.apply((e) => addAudioClip(e, clip));
        if (get().edit !== before)
          set({ selectedAudioId: clip.id, selectedClipId: null, panel: "clip" });
      },
      toggleSnap: () => set({ snap: !get().snap }),
      setExportSettings: (patch) =>
        set({ exportSettings: { ...get().exportSettings, ...patch } }),

      setPicks: (picks) => set({ picks }),
      setSelecting: (on) => set({ selecting: on, rate: on ? 0 : get().rate }),

      addLaunch: (launch) =>
        set({
          launches: [
            ...get().launches.filter((l) => l.itemId !== launch.itemId),
            launch,
          ].slice(-8),
        }),
      trackToolRun: (runId, title, itemId) => {
        const s = get();
        if (s.toolRuns.some((r) => r.runId === runId)) return;
        const l = itemId
          ? s.launches.find((x) => x.itemId === itemId)
          : s.launches[s.launches.length - 1];
        if (!l) return;
        set({
          toolRuns: [
            ...s.toolRuns,
            {
              runId,
              title: title || l.title,
              start: l.start,
              end: l.end,
              cutUrl: l.cutUrl,
              at: Date.now(),
            },
          ],
        });
      },
      untrackToolRun: (runId) =>
        set({ toolRuns: get().toolRuns.filter((r) => r.runId !== runId) }),
      addResult: (result) => {
        const s = get();
        if (s.results.some((r) => r.id === result.id)) return;
        set({
          results: [result, ...s.results].slice(0, 24),
          compareId: result.kind === "video" ? result.id : s.compareId,
          panel: "results",
        });
      },
      removeResult: (id) => {
        const s = get();
        set({
          results: s.results.filter((r) => r.id !== id),
          compareId: s.compareId === id ? null : s.compareId,
        });
      },
      setResultOptions: (id, patch) =>
        set({
          results: get().results.map((r) =>
            r.id === id ? { ...r, ...patch } : r,
          ),
        }),
      setCompare: (id) => set({ compareId: id }),
      setPanel: (panel) => set({ panel }),
    }),
    {
      name: STORAGE_KEYS.videoEdit,
      storage: legacyAwareJSONStorage(),
      version: 2,
      // v1 projects had no id and no saved flag: give them an id and ask
      // before closing (their edit history is unknown).
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Partial<VideoEditState>;
        if (version < 2 && p.edit)
          return { ...p, projectId: newProjectId(), dirty: true };
        return p;
      },
      // Saved export settings from an older build may name options that no
      // longer exist; the render route would reject them.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<VideoEditState>;
        const ex = parseExportSettings(p.exportSettings);
        return {
          ...current,
          ...p,
          exportSettings: ex.ok ? ex.value : { ...DEFAULT_EXPORT },
        };
      },
      partialize: (s) => ({
        edit: s.edit,
        label: s.label,
        active: s.active,
        projectId: s.projectId,
        dirty: s.dirty,
        inPoint: s.inPoint,
        outPoint: s.outPoint,
        loop: s.loop,
        speed: s.speed,
        snap: s.snap,
        exportSettings: s.exportSettings,
        picks: s.picks,
        toolRuns: s.toolRuns,
        results: s.results,
      }),
    },
  ),
);

// derived (pure)

export interface TimeRange {
  start: number;
  end: number;
  /** What the range is, for labels. */
  source: "marks" | "clip" | "all";
}

/**
 * The range tools and range exports work on: the in/out marks when set,
 * else the selected clip, else the whole timeline.
 */
export function activeRange(
  edit: EditList,
  inPoint: number | null,
  outPoint: number | null,
  selectedClipId: string | null,
): TimeRange {
  const total = timelineDuration(edit);
  if (inPoint !== null || outPoint !== null) {
    const start = clamp(inPoint ?? 0, 0, total);
    const end = clamp(outPoint ?? total, 0, total);
    if (end > start) return { start, end, source: "marks" };
  }
  const i = edit.clips.findIndex((c) => c.id === selectedClipId);
  if (i !== -1) {
    const start = clipStarts(edit)[i];
    return { start, end: start + clipLength(edit.clips[i]), source: "clip" };
  }
  return { start: 0, end: total, source: "all" };
}

/** Frame rate the transport steps in: the clip under the playhead's. */
export function playheadFps(edit: EditList, t: number): number {
  const starts = clipStarts(edit);
  for (let i = edit.clips.length - 1; i >= 0; i -= 1) {
    if (t >= starts[i] - 1e-9) return edit.clips[i].src.fps || 24;
  }
  return edit.clips[0]?.src.fps || 24;
}

// Opening an image in the editor (lightbox "Edit", start screen) brings the
// image editor forward; the video project stays and can be resumed.
useEditorStore.subscribe((next, prev) => {
  if (next.sourceImage && next.sourceImage !== prev.sourceImage)
    useVideoEditStore.getState().setActive(false);
});

// Keep the server told which uploads the project uses (housekeeping never
// removes those). Browser only; rehydration registers a saved project.
if (typeof window !== "undefined")
  installProjectRefsSync(
    (fn) => useVideoEditStore.subscribe(fn),
    useVideoEditStore.getState(),
  );
