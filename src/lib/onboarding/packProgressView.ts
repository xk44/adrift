/**
 * What the wizard's download-progress panel shows for a progress snapshot.
 * Pure and client-safe (type-only import), so the honest states are tested
 * without a browser: no data or no ComfyUI -> "progress unavailable", a
 * remote ComfyUI before the first file lands -> an indeterminate bar, never a
 * bar stuck at 0%.
 */
import type { PackProgress } from "./packProgress";

/** Nothing new for this long: say so instead of looking frozen. */
export const QUIET_AFTER_MS = 3 * 60_000;

export interface ProgressView {
  tone: "working" | "unknown" | "done";
  /** 0..100, or null for an indeterminate (moving) bar. */
  percent: number | null;
  title: string;
  detail: string;
}

function gb(bytes: number): string {
  const g = bytes / 1024 ** 3;
  return `${g >= 10 ? Math.round(g) : g.toFixed(1)} GB`;
}

export function progressView(
  snap: PackProgress | null,
  opts: { lostContact?: boolean; quietForMs?: number } = {},
): ProgressView {
  if (!snap || !snap.connected) {
    return {
      tone: "unknown",
      percent: null,
      title: "Progress unavailable - still downloading?",
      detail: opts.lostContact
        ? "Adrift can't check right now. If the command is still running, let it finish; we'll keep checking."
        : "Adrift can't see ComfyUI's models right now. If the command is still running, let it finish; we'll keep checking.",
    };
  }
  if (snap.complete) {
    return {
      tone: "done",
      percent: 100,
      title: "All files are in ComfyUI",
      detail:
        snap.totalFiles === 1
          ? "The file is ready to use."
          : `All ${snap.totalFiles} files are ready to use.`,
    };
  }
  const files = `${snap.doneFiles} of ${snap.totalFiles} file${snap.totalFiles === 1 ? "" : "s"} ready`;
  const quiet = (opts.quietForMs ?? 0) >= QUIET_AFTER_MS;
  const quietNote = quiet
    ? " Nothing new for a few minutes: big files take a while, so that's fine while the command is still running."
    : "";
  // Bytes only once some arrived: the `hf` CLI path writes no .part file, so
  // a byte bar would sit at 0% until the first whole file lands.
  if (snap.bytesKnown && snap.totalBytes > 0 && snap.doneBytes > 0) {
    const pct = Math.min(
      99,
      Math.floor((snap.doneBytes / snap.totalBytes) * 100),
    );
    return {
      tone: "working",
      percent: pct,
      title: `Downloading: ${gb(snap.doneBytes)} of ${gb(snap.totalBytes)}`,
      detail: `${files}.${quietNote}`,
    };
  }
  // Remote ComfyUI: only whole files are visible. Show file steps once one
  // has landed, a moving bar before that.
  return {
    tone: "working",
    percent:
      snap.doneFiles > 0
        ? Math.min(99, Math.floor((snap.doneFiles / snap.totalFiles) * 100))
        : null,
    title: snap.bytesKnown ? "Downloading" : "Downloading on the ComfyUI computer",
    detail: snap.bytesKnown
      ? `${files}. Each file ticks off here when it finishes.${quietNote}`
      : `${files}. Each file ticks off here when it finishes; live byte counts only show when ComfyUI runs on this computer.${quietNote}`,
  };
}
