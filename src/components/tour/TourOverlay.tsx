"use client";

/**
 * One stop of the intro tour: a dim layer with a cutout around the target
 * element, plus a small card beside it (a docked sheet under 640px). The
 * layer swallows clicks so only the card is interactive. Each stop lists
 * fallback selectors; when none shows up (page still loading, feature hidden,
 * empty feed) the card is centered after FIND_TIMEOUT_MS instead of stalling.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import {
  placeTourCard,
  resolveTourTarget,
  sheetDock,
  spotlightRect,
  stepTargets,
  tourKeyAction,
  type Rect,
  type TourStep,
} from "@/lib/tour/tour";

const FIND_TIMEOUT_MS = 2000;
const POLL_MS = 100;
const TRACK_MS = 500;
const CARD_WIDTH = 340;
const SMALL_SCREEN = 640;

export interface TourOverlayProps {
  step: TourStep;
  /** All stops of this tour, for the progress dots. */
  steps: readonly Pick<TourStep, "id" | "title">[];
  index: number;
  onNext: () => void;
  onBack: () => void;
  onGoTo: (index: number) => void;
  onSkip: () => void;
  /** Secondary button on the last stop. */
  finishAction?: { label: string; onClick: () => void };
  skipLabel?: string;
}

function findTarget(selectors: readonly string[]): HTMLElement | null {
  return (
    resolveTourTarget(selectors, (sel) =>
      Array.from(document.querySelectorAll<HTMLElement>(sel)),
    )?.el ?? null
  );
}

function toRect(r: DOMRect): Rect {
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

function readViewport() {
  return { width: window.innerWidth || 1280, height: window.innerHeight || 800 };
}

export function TourOverlay({
  step,
  steps,
  index,
  onNext,
  onBack,
  onGoTo,
  onSkip,
  finishAction,
  skipLabel = "Skip tour",
}: TourOverlayProps) {
  const count = steps.length;
  const selectorKey = stepTargets(step).join("\n");
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const isLast = index >= count - 1;

  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [searching, setSearching] = useState(selectorKey !== "");
  const [rect, setRect] = useState<Rect | null>(null);
  const [viewport, setViewport] = useState(() =>
    typeof window === "undefined"
      ? { width: 1280, height: 800 }
      : readViewport(),
  );
  const [cardSize, setCardSize] = useState({ width: CARD_WIDTH, height: 190 });

  // Find this stop's element (pages mount lazily, so poll briefly).
  useEffect(() => {
    setTarget(null);
    setRect(null);
    if (!selectorKey) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const selectors = selectorKey.split("\n");
    const started = Date.now();
    let done = false;
    const attempt = () => {
      if (done) return;
      const el = findTarget(selectors);
      if (el) {
        done = true;
        const r = el.getBoundingClientRect();
        if (r.top < 0 || r.bottom > window.innerHeight) {
          const reduce = window.matchMedia?.(
            "(prefers-reduced-motion: reduce)",
          ).matches;
          el.scrollIntoView({
            block: r.height > window.innerHeight * 0.7 ? "start" : "center",
            behavior: reduce ? "auto" : "smooth",
          });
        }
        setTarget(el);
        setSearching(false);
      } else if (Date.now() - started >= FIND_TIMEOUT_MS) {
        done = true;
        setSearching(false);
      }
    };
    attempt();
    const timer = window.setInterval(attempt, POLL_MS);
    return () => {
      done = true;
      window.clearInterval(timer);
    };
  }, [step.id, selectorKey]);

  // Keep the cutout on the element through resize, scroll and layout shifts.
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      setViewport((v) => {
        const next = readViewport();
        return v.width === next.width && v.height === next.height ? v : next;
      });
      if (!target) return;
      if (!target.isConnected) {
        // Page re-rendered under us: fall back to a centered card.
        setTarget(null);
        setRect(null);
        return;
      }
      const next = toRect(target.getBoundingClientRect());
      setRect((prev) => (sameRect(prev, next) ? prev : next));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const ro =
      target && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(schedule)
        : null;
    if (target) ro?.observe(target);
    const timer = window.setInterval(schedule, TRACK_MS);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      ro?.disconnect();
      window.clearInterval(timer);
    };
  }, [target]);

  // Card size for placement (before paint, so it never jumps).
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    setCardSize((s) =>
      s.width === width && s.height === height ? s : { width, height },
    );
  });

  // Modal contract: Tab stays in the card, focus returns to the opener.
  useDialogFocus(cardRef, true, { initialFocus: "none", restoreFocus: true });

  // Each stop focuses its main button, so Enter moves on.
  useEffect(() => {
    if (!searching) primaryRef.current?.focus({ preventScroll: true });
  }, [step.id, searching]);

  // ←/→/Esc; every other key except Tab stays out of the page underneath
  // (its own shortcuts would otherwise fire behind the overlay).
  const actions = useRef({ onNext, onBack, onGoTo, onSkip, index, count });
  actions.current = { onNext, onBack, onGoTo, onSkip, index, count };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      const act = tourKeyAction(e, actions.current.index);
      if (!act) return;
      e.preventDefault();
      if (act === "next") actions.current.onNext();
      else if (act === "back") actions.current.onBack();
      else if (act === "first") actions.current.onGoTo(0);
      else if (act === "last") actions.current.onGoTo(actions.current.count - 1);
      else actions.current.onSkip();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const spot = rect ? spotlightRect(rect, viewport) : null;
  const small = viewport.width < SMALL_SCREEN;
  const dock = sheetDock(spot, viewport.height);
  const placement = placeTourCard(spot, cardSize, viewport);
  const ready = !searching;

  const cardBase =
    "absolute border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-2xl outline-none";
  const cardClass = small
    ? `${cardBase} inset-x-0 px-4 ${
        dock === "top"
          ? "top-0 rounded-b-xl border-b pb-4 pt-[calc(1rem+env(safe-area-inset-top))]"
          : "bottom-0 rounded-t-xl border-t pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
      }`
    : `${cardBase} rounded-xl border p-4`;
  const cardStyle: React.CSSProperties | undefined = small
    ? undefined
    : {
        left: placement.left,
        top: placement.top,
        width: `min(${CARD_WIDTH}px, calc(100vw - 32px))`,
      };

  const secondaryBtn =
    "rounded-lg px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]";
  const primaryBtn =
    "rounded-lg bg-[var(--accent-primary)] px-3.5 py-1.5 text-sm font-medium text-white hover:bg-[var(--accent-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-primary)]";

  return (
    <div className="fixed inset-0 z-[1100]" data-testid="tour-overlay">
      {/* Click blocker; also the dim layer when there is no cutout. */}
      <div
        aria-hidden="true"
        className={`absolute inset-0 ${spot ? "" : "bg-black/60"}`}
        onMouseDown={(e) => e.preventDefault()}
      />
      {spot && (
        <div
          key={step.id}
          aria-hidden="true"
          data-testid="tour-spotlight"
          className="pointer-events-none absolute rounded-xl ring-1 ring-white/70 motion-safe:animate-fade-in"
          style={{
            left: spot.left,
            top: spot.top,
            width: spot.width,
            height: spot.height,
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.6)",
          }}
        />
      )}
      <div
        ref={cardRef}
        key={`card-${step.id}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        data-testid="tour-card"
        data-tour-step={step.id}
        className={`${cardClass} ${ready ? "motion-safe:animate-slide-up" : "invisible"}`}
        style={cardStyle}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs tabular-nums text-[var(--text-muted)]">
            {step.section && (
              <span className="font-medium text-[var(--text-secondary)]">
                {step.section}
                <span aria-hidden> · </span>
              </span>
            )}
            {index + 1} of {count}
          </span>
          {!isLast && (
            <button
              type="button"
              onClick={onSkip}
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)] rounded"
            >
              {skipLabel}
            </button>
          )}
        </div>
        <h2
          id={titleId}
          className="mt-2 text-[15px] font-semibold leading-snug text-[var(--text-primary)]"
        >
          {step.title}
        </h2>
        <p
          id={bodyId}
          className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]"
        >
          {step.body}
        </p>
        {count > 1 && (
          <div
            className="mt-3 flex flex-wrap items-center"
            role="group"
            aria-label="Tour progress"
            data-testid="tour-dots"
          >
            {steps.map((s, i) => (
              <button
                key={s.id}
                type="button"
                tabIndex={-1}
                onClick={() => onGoTo(i)}
                aria-label={`Stop ${i + 1}: ${s.title}`}
                aria-current={i === index ? "step" : undefined}
                className="group flex h-6 w-3.5 items-center justify-center"
              >
                <span
                  aria-hidden
                  className={`block h-1.5 rounded-full transition-[width,background-color] motion-reduce:transition-none ${
                    i === index
                      ? "w-3 bg-[var(--accent-primary)]"
                      : i < index
                        ? "w-1.5 bg-[var(--text-muted)] group-hover:bg-[var(--text-primary)]"
                        : "w-1.5 bg-[var(--border-primary)] group-hover:bg-[var(--text-muted)]"
                  }`}
                />
              </button>
            ))}
          </div>
        )}
        <div className="mt-3 flex items-center justify-end gap-2">
          {index > 0 && (
            <button type="button" onClick={onBack} className={secondaryBtn}>
              Back
            </button>
          )}
          {isLast ? (
            <>
              {finishAction && (
                <button
                  type="button"
                  onClick={finishAction.onClick}
                  className={secondaryBtn}
                >
                  {finishAction.label}
                </button>
              )}
              <button
                ref={primaryRef}
                type="button"
                onClick={onNext}
                className={primaryBtn}
              >
                Done
              </button>
            </>
          ) : (
            <button
              ref={primaryRef}
              type="button"
              onClick={onNext}
              className={primaryBtn}
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
