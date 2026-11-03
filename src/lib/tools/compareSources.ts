/**
 * Session memory of the input image behind a tool run, for runners that show
 * a before/after compare (SDR to HDR). Keyed by run id; bounded so data: URL
 * uploads cannot pile up.
 */
export interface CompareSource {
  url: string;
  width: number;
  height: number;
}

const MAX_SOURCES = 24;
const sources = new Map<string, CompareSource>();

export function rememberCompareSource(runId: string, source: CompareSource) {
  if (!runId || !source.url) return;
  sources.delete(runId);
  sources.set(runId, source);
  while (sources.size > MAX_SOURCES) {
    const oldest = sources.keys().next().value;
    if (oldest === undefined) break;
    sources.delete(oldest);
  }
}

export function compareSourceFor(runId: string): CompareSource | undefined {
  return sources.get(runId);
}

/** Tools whose runner stage compares the result against its input. */
export const COMPARE_SOURCE_TOOLS: ReadonlySet<string> = new Set([
  "sdr_to_hdr",
]);
