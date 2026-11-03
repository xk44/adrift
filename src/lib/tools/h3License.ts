/**
 * MiniMax H3 Community License obligations surfaced in the Tools UI:
 * prominent "MiniMax H3" attribution (§IV.2), a likeness-consent safeguard
 * and an abuse-report link for hosted services (§V.5). Pure (no React) so
 * the rules are unit-tested; storage access is injected and never throws.
 */

/** Model name the license requires to be displayed prominently. */
export const H3_MODEL_NAME = "MiniMax H3";
export const H3_ATTRIBUTION = `Powered by ${H3_MODEL_NAME}`;

/**
 * License §I.5: open-weight use is not licensed in these territories without a
 * separate MiniMax authorization. H3 ships as an optional pack for that reason.
 */
export const H3_EXCLUDED_TERRITORIES =
  "the EU, the UK, South Korea and the United States";
export const H3_TERRITORY_NOTE = `Optional pack. The open-weight license does not cover ${H3_EXCLUDED_TERRITORIES}; there you need a separate MiniMax license first.`;

/** Static operator/user summary page (src/app/legal/h3/page.tsx). */
export const H3_LEGAL_PATH = "/legal/h3";

/** Where users report misuse when NEXT_PUBLIC_ABUSE_REPORT_URL is unset. */
export const REPO_ISSUES_URL =
  "https://github.com/xk44/adrift/issues/new?labels=abuse-report";

/** Any card/runner whose open model is (or stacks on) MiniMax H3. */
export function isH3Model(model: string | null | undefined): boolean {
  return typeof model === "string" && model.includes(H3_MODEL_NAME);
}

/**
 * Hub card keys that put a real person's face or body into a video. These
 * require the likeness-consent checkbox before Run.
 */
export const LIKENESS_TOOL_KEYS: readonly string[] = [
  "action:character_swap",
  "action:cast_swap",
  "action:face_swap",
  "action:ref_video",
  "action:multiframe_ref",
  "action:h3_charsheet",
  // Character refs can be real people (likeness put into a whole video).
  "special:music_video",
];

export function needsLikenessConsent(cardKey: string): boolean {
  return LIKENESS_TOOL_KEYS.includes(cardKey);
}

export const LIKENESS_CONSENT_TEXT =
  "I have the rights to this image and consent from anyone depicted; " +
  "no sexual or deceptive content of real people.";

/** Bump the version when the consent wording changes (re-asks everyone). */
const CONSENT_PREFIX = "adrift.h3.likenessConsent.v1:";

export function consentStorageKey(cardKey: string): string {
  return `${CONSENT_PREFIX}${cardKey}`;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** window.localStorage when reachable (private mode / SSR → null). */
export function browserStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readConsent(
  storage: StorageLike | null,
  cardKey: string,
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(consentStorageKey(cardKey)) === "1";
  } catch {
    return false;
  }
}

export function writeConsent(
  storage: StorageLike | null,
  cardKey: string,
  accepted: boolean,
): void {
  if (!storage) return;
  try {
    if (accepted) storage.setItem(consentStorageKey(cardKey), "1");
    else storage.removeItem(consentStorageKey(cardKey));
  } catch {
    // Storage full/blocked: consent then lasts only for this view.
  }
}

/**
 * Report-misuse link. NEXT_PUBLIC_ABUSE_REPORT_URL wins when it is an
 * http(s) URL, a mailto: address or a site-relative path; anything else
 * (empty, javascript:, garbage) falls back to the legal page's report
 * section. The default argument must reference process.env literally so
 * Next.js inlines it into the client bundle.
 */
export function abuseReportUrl(
  raw: string | undefined = process.env.NEXT_PUBLIC_ABUSE_REPORT_URL,
): string {
  const v = (raw ?? "").trim();
  if (/^(https?:\/\/|mailto:)\S+$/i.test(v)) return v;
  if (/^\/(?!\/)\S*$/.test(v)) return v;
  return `${H3_LEGAL_PATH}#report`;
}
