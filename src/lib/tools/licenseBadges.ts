/**
 * User-facing license badges for Tools cards, engine pickers and runners.
 * One badge per tool, picked from the licenses of the models it loads:
 *
 *   open    permissive / open licenses: commercial use OK
 *   cap     open weights with a revenue cap on commercial use (Krea 2,
 *           FLUX.3 Klein, LTX-2, LTXV 0.9.8, Stable Audio 3)
 *   nc      non-commercial weights
 *   region  MiniMax H3: not licensed in some territories
 *   check   no license stated by the model's author: read the model page
 *
 * Within one tool the most limiting badge wins (WORST_ORDER); a merged card
 * that can run several engines shows the most permissive one (BEST_ORDER).
 * Pure (no React), client safe.
 */

import { H3_MODEL_NAME } from "./h3License";
import { licenseUrlFor } from "@/lib/models/licenseLinks";

export type LicenseBadge = "open" | "cap" | "nc" | "region" | "check";

export const BADGE_LABEL: Record<LicenseBadge, string> = {
  open: "Open",
  cap: "Revenue cap",
  nc: "Non-commercial",
  region: "Region-limited",
  check: "Check license",
};

/** Most permissive first: the order a merged card picks its best engine by. */
export const BEST_ORDER: readonly LicenseBadge[] = [
  "open",
  "cap",
  "nc",
  "region",
  "check",
];

/** Most limiting first: the badge one tool shows when its models differ. */
export const WORST_ORDER: readonly LicenseBadge[] = [
  "nc",
  "region",
  "check",
  "cap",
  "open",
];

export function bestBadge(list: LicenseBadge[]): LicenseBadge {
  return list.reduce<LicenseBadge>(
    (a, b) => (BEST_ORDER.indexOf(b) < BEST_ORDER.indexOf(a) ? b : a),
    list[0] ?? "check",
  );
}

export function worstBadge(list: LicenseBadge[]): LicenseBadge {
  return list.reduce<LicenseBadge>(
    (a, b) => (WORST_ORDER.indexOf(b) < WORST_ORDER.indexOf(a) ? b : a),
    "open",
  );
}

/** Rank for sorting merged-card engines: lower is more permissive. */
export function badgeRank(b: LicenseBadge): number {
  return BEST_ORDER.indexOf(b);
}

/** Badges the "Commercial use OK" filter keeps (cap: under its threshold). */
export function isOpenWeightsBadge(b: LicenseBadge): boolean {
  return b === "open" || b === "cap";
}

/**
 * Real terms of the conditional licenses, read from each license text.
 * Sources:
 *   Krea 2: https://huggingface.co/krea/Krea-2-Turbo/blob/main/LICENSE.pdf
 *     (Krea 2 Community License v.1, §2.3 commercial use, §4.2 filtering)
 *   FLUX: https://huggingface.co/black-forest-labs/flux-3-image-klein/blob/main/LICENSE.md
 *     (FLUX Kommunity License v1.0, "Qualifying User" definition)
 *   LTX-2: https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x
 *   LTXV: https://huggingface.co/Lightricks/LTX-Video/blob/main/LTX-Video-Open-Weights-License-0.X.txt
 *   Stability: https://stability.ai/community-license-agreement
 *   MiniMax H3: https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE
 *     (§I.5 Excluded Territories)
 */
interface LicenseTerms {
  match: RegExp;
  badge: LicenseBadge;
  summary: string;
}

const TERMS: LicenseTerms[] = [
  {
    match: /Krea 2 Community License/,
    badge: "cap",
    summary:
      "Krea 2 Community License: commercial use only while you and your affiliates have under US$1M total annual revenue (trailing 12 months), with content filtering. Above that, Krea's enterprise license.",
  },
  {
    match: /FLUX Kommunity License/,
    badge: "cap",
    summary:
      "FLUX Kommunity License v1.0: commercial use of outputs only for Qualifying Users (under US$5M gross annual revenue, affiliates included), with content filters or output review. Otherwise non-commercial unless licensed from Black Forest Labs.",
  },
  {
    match: /LTX-2 Community License/,
    badge: "cap",
    summary:
      "LTX-2 Community License: free, commercial use included, for entities under US$10M annual revenue (affiliates included). Larger entities need a paid license from Lightricks.",
  },
  {
    match: /LTXV Open Weights License/,
    badge: "cap",
    summary:
      "LTXV Open Weights License: entities with US$10M or more annual revenue need a paid commercial agreement from Lightricks.",
  },
  {
    match: /Stability AI Community License/,
    badge: "cap",
    summary:
      "Stability AI Community License: free commercial use under US$1M annual revenue (affiliates included) after registering with Stability AI. Above that, an enterprise license.",
  },
  {
    match: new RegExp(H3_MODEL_NAME),
    badge: "region",
    summary: `${H3_MODEL_NAME} Community License: not licensed in the European Union, the United Kingdom, the Republic of Korea or the United States of America without a separate MiniMax license. Products over US$20M yearly revenue also need MiniMax's authorization.`,
  },
];

/** Terms entry for a license name (null for plain open / nc licenses). */
export function licenseTerms(name: string): LicenseTerms | null {
  return TERMS.find((t) => t.match.test(name)) ?? null;
}

/** Revenue-capped license names are "restricted" in the docs, but a cap. */
export function isRevenueCapLicense(name: string): boolean {
  return licenseTerms(name)?.badge === "cap";
}

export function isRegionLicense(name: string): boolean {
  return licenseTerms(name)?.badge === "region";
}

/** One license behind a badge: its name and the page to read. */
export interface BadgeSource {
  license: string;
  url: string | null;
}

export function sourceFor(license: string, url?: string | null): BadgeSource {
  return { license, url: url ?? licenseUrlFor(license) };
}

const FALLBACK: Record<LicenseBadge, string> = {
  open: "Open: every model this tool loads ships under an open license that allows commercial use.",
  cap: "Revenue cap: open weights, but commercial use is limited by company revenue.",
  nc: "Non-commercial: personal and research use only.",
  region: `Region-limited: the ${H3_MODEL_NAME} license excludes the European Union, the United Kingdom, the Republic of Korea and the United States of America.`,
  check:
    "Check license: the terms of a model this tool uses could not be confirmed. Read the model page before commercial use.",
};

/**
 * Plain-text tooltip (title attributes cannot hold links, so URLs are spelled
 * out; the runner renders them as real links via badgeLinks).
 */
export function badgeTooltip(
  badge: LicenseBadge,
  sources: BadgeSource[] = [],
): string {
  const lines: string[] = [];
  if (badge === "cap" || badge === "region") {
    for (const s of sources) {
      const t = licenseTerms(s.license);
      if (t && t.badge === badge && !lines.includes(t.summary))
        lines.push(t.summary);
    }
  } else if (badge === "nc" && sources.length) {
    lines.push(
      `Non-commercial: personal and research use only (${uniq(sources.map((s) => s.license)).join("; ")}).`,
    );
  } else if (badge === "check" && sources.length) {
    lines.push(
      `Check license: the terms of ${uniq(sources.map((s) => s.license)).join("; ")} could not be confirmed. Read the model page before commercial use.`,
    );
  }
  if (!lines.length) lines.push(FALLBACK[badge]);
  const urls = uniq(sources.map((s) => s.url).filter((u): u is string => !!u));
  if (urls.length) lines.push(urls.join("\n"));
  return lines.join("\n");
}

/** Linkable sources for a runner's license line. */
export function badgeLinks(sources: BadgeSource[]): BadgeSource[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    if (!s.url || seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

function uniq(list: string[]): string[] {
  return [...new Set(list)];
}
