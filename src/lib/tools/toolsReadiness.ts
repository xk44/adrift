/**
 * Tools hub header numbers. "Ready" only counts tools whose models were
 * actually checked on the server; tools with no model check are "not
 * checked" (they may still fail on run), and a failed model check is
 * labelled offline instead of quietly reading as "0 ready".
 *
 * Pure so the counts are unit-tested; ToolsPage renders readinessLine().
 */

export interface ReadinessCard {
  available: boolean;
  kind: string;
  /** Available, but no model check backs it (actionAvailability). */
  unverified?: boolean;
}

export interface ToolsReadiness {
  /** Available and verified. */
  ready: number;
  /** Available but never checked (no modelCheck). */
  notChecked: number;
  /** Every listed card (placeholders excluded). */
  total: number;
  /** The model check or the whole tools load failed. */
  offline: boolean;
}

export function toolsReadiness(
  cards: ReadinessCard[],
  offline: boolean,
): ToolsReadiness {
  let ready = 0;
  let notChecked = 0;
  let total = 0;
  for (const c of cards) {
    if (c.kind === "placeholder") continue;
    total++;
    if (!c.available) continue;
    if (c.unverified) notChecked++;
    else ready++;
  }
  return { ready, notChecked, total, offline };
}

/**
 * One short header line: "12 of 40 tools ready" (offline: "Server offline,
 * can't check models · 40 tools"). The breakdown lives in readinessDetail().
 */
export function readinessLine(r: ToolsReadiness): string {
  if (r.offline)
    return `Server offline, can't check models · ${r.total} tools`;
  return `${r.ready} of ${r.total} tools ready`;
}

/** Tooltip breakdown: "12 ready · 6 beta · 22 need setup". */
export function readinessDetail(r: ToolsReadiness): string {
  if (r.offline) return "Start the Adrift server and ComfyUI, then reload.";
  const needSetup = Math.max(0, r.total - r.ready - r.notChecked);
  const parts = [`${r.ready} ready`];
  if (r.notChecked > 0) parts.push(`${r.notChecked} beta`);
  if (needSetup > 0) parts.push(`${needSetup} need setup`);
  const line = parts.join(" · ");
  return r.notChecked > 0 ? `${line}\n\nBeta: ${NOT_CHECKED_HINT}` : line;
}

/** Tooltip for the "beta" count and the card's Beta chip. */
export const NOT_CHECKED_HINT =
  "Adrift has no model check for this tool, so it can't confirm the models are installed. It may fail when you run it.";

/** A card as the readiness panel lists it (a HubCard fits). */
export interface ReadinessListCard extends ReadinessCard {
  key: string;
  id: string;
  title: string;
  checking?: boolean;
  unavailableReason?: string | null;
  model?: string | null;
}

export interface ReadinessGroup<C> {
  /** Short "what's missing" label ("Needs custom nodes"). */
  hint: string;
  cards: C[];
}

export interface ReadinessBreakdown<C> {
  /** Not ready, grouped by what is missing, biggest group first. */
  needSetup: ReadinessGroup<C>[];
  /** Available but unverified ("beta"), by title. */
  beta: C[];
}

const FALLBACK_HINT = "Needs setup";

/**
 * Info panel lists: tools that need setup grouped by the short hint
 * (setupHint) so one fix (a node pack, a shared base model) reads as one
 * row of tools, plus the beta tools. Placeholders and tools still being
 * checked are left out.
 */
export function readinessBreakdown<C extends ReadinessListCard>(
  cards: C[],
  hintOf: (c: C) => string | null,
): ReadinessBreakdown<C> {
  const byHint = new Map<string, C[]>();
  const beta: C[] = [];
  for (const c of cards) {
    if (c.kind === "placeholder" || c.checking) continue;
    if (c.available) {
      if (c.unverified) beta.push(c);
      continue;
    }
    const hint = hintOf(c)?.trim() || FALLBACK_HINT;
    const list = byHint.get(hint);
    if (list) list.push(c);
    else byHint.set(hint, [c]);
  }
  const byTitle = (a: C, b: C) => a.title.localeCompare(b.title);
  const needSetup = [...byHint.entries()]
    .map(([hint, list]) => ({ hint, cards: list.sort(byTitle) }))
    .sort(
      (a, b) =>
        b.cards.length - a.cards.length ||
        (a.hint === FALLBACK_HINT ? 1 : 0) - (b.hint === FALLBACK_HINT ? 1 : 0) ||
        a.hint.localeCompare(b.hint),
    );
  return { needSetup, beta: beta.sort(byTitle) };
}
