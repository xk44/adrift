/**
 * setInterval that pauses while the tab is hidden. Runs `tick` once at
 * start, every `ms` while visible, and once more as soon as the tab becomes
 * visible again (so the UI is fresh without waiting a full period).
 * Returns a stop function.
 */
export interface VisibilityDoc {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  removeEventListener(type: "visibilitychange", fn: () => void): void;
}

export function startVisibleInterval(
  tick: () => void,
  ms: number,
  doc: VisibilityDoc | undefined = typeof document !== "undefined"
    ? document
    : undefined,
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const isVisible = () => !doc || doc.visibilityState !== "hidden";
  const arm = () => {
    if (timer === null) timer = setInterval(tick, ms);
  };
  const disarm = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const onVisibility = () => {
    if (isVisible()) {
      tick();
      arm();
    } else {
      disarm();
    }
  };

  tick();
  if (isVisible()) arm();
  doc?.addEventListener("visibilitychange", onVisibility);
  return () => {
    disarm();
    doc?.removeEventListener("visibilitychange", onVisibility);
  };
}
