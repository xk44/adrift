"use client";

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import {
  H3_ATTRIBUTION,
  H3_LEGAL_PATH,
  H3_MODEL_NAME,
  H3_TERRITORY_NOTE,
  LIKENESS_CONSENT_TEXT,
  abuseReportUrl,
  browserStorage,
  readConsent,
  writeConsent,
} from "@/lib/tools/h3License";

/** Small "Powered by MiniMax H3" pill for hub cards. */
export function H3Badge() {
  return (
    <span
      className="rounded-md border border-splash/40 bg-splash/10 px-1.5 py-0.5 text-[10px] font-semibold text-splash"
      data-testid="h3-badge"
    >
      {H3_ATTRIBUTION}
    </span>
  );
}

/** Runner banner: attribution, license page and report-misuse links. */
export function H3Attribution() {
  const report = abuseReportUrl();
  const external = /^(https?:|mailto:)/i.test(report);
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-splash/30 bg-splash/5 px-3 py-2 text-xs"
      data-testid="h3-attribution"
    >
      <span className="font-semibold text-light-primary dark:text-dark-primary">
        Powered by <span className="text-splash">{H3_MODEL_NAME}</span>
      </span>
      <span className="text-light-500 dark:text-dark-400">
        MiniMax H3 Community License
      </span>
      <span className="ml-auto flex gap-3">
        <a
          href={H3_LEGAL_PATH}
          className="text-light-500 underline hover:text-splash dark:text-dark-400"
        >
          License terms
        </a>
        <a
          href={report}
          {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
          className="text-light-500 underline hover:text-splash dark:text-dark-400"
          data-testid="h3-report-misuse"
        >
          Report misuse
        </a>
      </span>
      <p
        className="w-full text-[11px] text-light-500 dark:text-dark-400"
        data-testid="h3-territory"
      >
        {H3_TERRITORY_NOTE}
      </p>
    </div>
  );
}

/** Per-tool likeness consent, remembered in localStorage when possible. */
export function useLikenessConsent(cardKey: string) {
  const [accepted, setAccepted] = useState(() =>
    readConsent(browserStorage(), cardKey),
  );
  const set = (v: boolean) => {
    setAccepted(v);
    writeConsent(browserStorage(), cardKey, v);
  };
  return [accepted, set] as const;
}

export function LikenessConsent({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className="flex items-start gap-2.5 rounded-xl border border-light-100 p-3 text-xs dark:border-dark-750"
      data-testid="likeness-consent"
    >
      <input
        type="checkbox"
        className="mt-0.5 accent-[var(--accent-primary)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="flex items-center gap-1 font-medium text-light-primary dark:text-dark-primary">
          <ShieldCheck className="h-3.5 w-3.5 text-splash" /> Likeness consent
        </span>
        <span className="mt-0.5 block text-light-500 dark:text-dark-400">
          {LIKENESS_CONSENT_TEXT}
        </span>
      </span>
    </label>
  );
}
