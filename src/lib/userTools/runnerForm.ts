/**
 * Form logic for the user-tool runner (pure, tested): starting values from
 * the imported graph, which values to send, and the first missing input.
 */

import { MEDIA_PARAM_KINDS, type UserToolParam } from "./types";

export type FormValue = string | number | "";

export function exposedParams(params: UserToolParam[]): UserToolParam[] {
  return params.filter((p) => p.exposed);
}

export function isMediaParam(p: UserToolParam): boolean {
  return MEDIA_PARAM_KINDS.has(p.kind);
}

/** Field values to start with: the graph's own, seeds blank (= random). */
export function initialFormValues(
  params: UserToolParam[],
): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  for (const p of exposedParams(params)) {
    if (isMediaParam(p)) continue;
    if (p.kind === "seed") out[p.key] = "";
    else if (typeof p.default === "number" || typeof p.default === "string")
      out[p.key] = p.default;
    else out[p.key] = "";
  }
  return out;
}

/** Values for the run request: blank numbers are left out (graph / random). */
export function formValuesToSend(
  params: UserToolParam[],
  values: Record<string, FormValue>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const p of exposedParams(params)) {
    if (isMediaParam(p)) continue;
    const v = values[p.key];
    if (v === undefined) continue;
    if (p.kind === "prompt" || p.kind === "negative") {
      out[p.key] = String(v);
      continue;
    }
    if (v === "") continue;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) out[p.key] = n;
  }
  return out;
}

/** Plain "Add …" message for the first exposed media input left empty. */
export function missingMediaMessage(
  params: UserToolParam[],
  has: (key: string) => boolean,
): string | null {
  for (const p of exposedParams(params)) {
    if (!isMediaParam(p) || has(p.key)) continue;
    return `Add ${p.label.charAt(0).toLowerCase()}${p.label.slice(1)}.`;
  }
  return null;
}
