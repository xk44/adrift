"use client";

import { navigateTo } from "@/lib/navUrlSync";

export function openTrainingSettings(): void {
  navigateTo("account-settings");
  let tries = 0;
  const scroll = () => {
    const el = document.getElementById("settings-training");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    else if (++tries < 20) setTimeout(scroll, 50);
  };
  setTimeout(scroll, 0);
}

export function TrainerSetupLink({ className = "" }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={openTrainingSettings}
      className={`text-splash underline underline-offset-2 hover:opacity-80 ${className}`}
      data-testid="trainer-setup-link"
    >
      Set up a trainer in Settings → Training
    </button>
  );
}
