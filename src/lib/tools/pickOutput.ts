/**
 * Pick the final file from one kind of ComfyUI history output.
 *
 * Graphs often emit the same media twice: a node's own UI preview (VibeVoice,
 * Chatterbox, PreviewAudio, VHS_VideoCombine with save_output off) lands in
 * ComfyUI's temp folder as "ComfyUI_temp_*" and is wiped on restart, while
 * the graph's Save node writes the real file to the output folder. History
 * lists them in node order, so taking files[0] can hand back the preview.
 *
 * Ranking, first difference wins (ties keep history order):
 *   1. the node id the caller names (opts.nodeId), if any
 *   2. type "output" (a missing type counts as output) over "temp"/"input"
 *   3. a Save* node (class or title) over anything else; Preview* last
 *   4. a filename that is not a ComfyUI_temp_ preview
 */
export interface OutputFileLike {
  filename: string;
  type?: string;
  nodeId?: string;
  nodeTitle?: string;
  classType?: string;
}

export interface PickOutputOptions {
  /** History node id of the graph's designated save node. */
  nodeId?: string;
}

const TEMP_NAME = /^ComfyUI_temp_/i;

function nodeRank(f: OutputFileLike): number {
  const names = [f.classType, f.nodeTitle].filter(
    (n): n is string => typeof n === "string" && !!n,
  );
  if (names.some((n) => /^save/i.test(n))) return 2;
  if (names.some((n) => /^preview/i.test(n))) return 0;
  return 1;
}

function score(f: OutputFileLike, opts: PickOutputOptions): number[] {
  return [
    opts.nodeId && f.nodeId === opts.nodeId ? 1 : 0,
    (f.type || "output") === "output" ? 1 : 0,
    nodeRank(f),
    TEMP_NAME.test(f.filename) ? 0 : 1,
  ];
}

export function pickFinalOutput<T extends OutputFileLike>(
  files: readonly T[] | null | undefined,
  opts: PickOutputOptions = {},
): T | undefined {
  let best: T | undefined;
  let bestScore: number[] = [];
  for (const f of files ?? []) {
    if (!f || typeof f.filename !== "string") continue;
    const s = score(f, opts);
    if (!best || isBetter(s, bestScore)) {
      best = f;
      bestScore = s;
    }
  }
  return best;
}

function isBetter(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}
