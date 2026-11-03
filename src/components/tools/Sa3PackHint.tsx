"use client";

import { useEffect, useState } from "react";
import {
  STARTER_PACKS,
  formatGb,
  slotOptions,
} from "@/lib/onboarding/starterPacks";
import { openOnboarding } from "@/store/onboardingStore";
import {
  SA3_PACK_BYTES,
  SA3_PACK_ID,
  sa3PackCommand,
} from "@/lib/tools/sa3Setup";
import { BTN, CommandBox, useCopy } from "@/components/onboarding/ui";
import { getPacks } from "@/components/onboarding/api";

const muted = "text-xs text-light-500 dark:text-dark-400";

/** Required download size of the SA3 pack, read from the pack definition. */
export function sa3PackRequiredBytes(): number {
  const pack = STARTER_PACKS.packs.find((p) => p.id === SA3_PACK_ID);
  if (!pack) return SA3_PACK_BYTES;
  return pack.files.reduce((sum, slot) => {
    const f = slotOptions(slot)[0];
    return f && !f.optional ? sum + f.bytes : sum;
  }, 0);
}

/**
 * Shown under a Stable Audio 3 card's "needs a model" notice: the starter
 * pack that installs it, as a link into the setup wizard and as the command.
 * When Adrift can see the ComfyUI folder on this machine, the command uses it.
 */
export function Sa3PackHint({ comfyDir: initialDir }: { comfyDir?: string } = {}) {
  const [copied, copy] = useCopy();
  const [comfyDir, setComfyDir] = useState<string | null>(initialDir ?? null);
  useEffect(() => {
    if (initialDir) return;
    let alive = true;
    void getPacks().then((r) => {
      if (alive && r?.comfyDirKnown && r.comfyDir) setComfyDir(r.comfyDir);
    });
    return () => {
      alive = false;
    };
  }, [initialDir]);
  return (
    <div className="space-y-2" data-testid="sa3-pack-hint">
      <p className={muted}>
        These audio tools use Stable Audio 3 Medium. The &quot;Audio: music
        &amp; sound&quot; starter pack installs it (
        {formatGb(sa3PackRequiredBytes())}).
      </p>
      <button
        type="button"
        onClick={() => openOnboarding("packs", { focus: "audio-sa3" })}
        className={BTN.secondary}
      >
        Open starter packs
      </button>
      <p className={muted}>Or run this in the Adrift folder:</p>
      <CommandBox
        id="sa3-pack"
        text={sa3PackCommand(comfyDir ? { comfyDir } : {})}
        copied={copied}
        onCopy={copy}
        label="Copy download command"
      />
      <p className={muted}>
        {comfyDir
          ? "Then restart ComfyUI."
          : "Use your ComfyUI folder in place of the example path, then restart ComfyUI."}
      </p>
    </div>
  );
}
