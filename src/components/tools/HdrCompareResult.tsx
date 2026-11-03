"use client";

import { CompareSlider } from "@/components/CompareSlider";
import { ExtraOutputs } from "@/components/ExtraOutputs";
import { compareSourceFor } from "@/lib/tools/compareSources";
import type { ReactNode } from "react";
import type { ImagineRun } from "@/types";

/**
 * SDR to HDR result: wipe compare of the input against the HLG AVIF, plus the
 * EXR master download. `fallback` (the stage's default view) covers progress,
 * failures, and runs whose input this session did not keep.
 */
export function HdrCompareResult({
  run,
  fallback,
}: {
  run: ImagineRun;
  fallback: ReactNode;
}) {
  const job = run.jobs[0];
  const after = job?.images?.[0];
  if (!job || job.status !== "done" || !after) return <>{fallback}</>;
  const before = compareSourceFor(run.run_id);
  const sized = before && before.width > 0 && before.height > 0;
  return (
    <div className="space-y-2" data-testid="hdr-compare-result">
      {before ? (
        <div
          className="mx-auto max-h-[34rem] w-full"
          style={
            sized
              ? {
                  aspectRatio: `${before.width} / ${before.height}`,
                  // Keep the box at the image's aspect when the height cap bites.
                  maxWidth: `min(100%, calc(34rem * ${before.width / before.height}))`,
                }
              : { aspectRatio: "4 / 3" }
          }
        >
          <CompareSlider
            leftUrl={before.url}
            rightUrl={after}
            leftAlt="SDR input"
            rightAlt="HDR result"
            leftLabel="SDR"
            rightLabel="HDR"
          />
        </div>
      ) : (
        fallback
      )}
      <p className="text-[11px] leading-snug text-light-500 dark:text-dark-400">
        The preview is a 10-bit HLG (Rec.2020) AVIF: it shows real HDR on an HDR
        display in an HDR-capable browser; elsewhere the browser tone-maps it
        back to SDR. The EXR master is scene-linear Rec.2020 float. Clipped
        highlights are expanded, not recovered.
      </p>
      {job.prompt_id && (
        <ExtraOutputs promptId={job.prompt_id} title="EXR master" />
      )}
    </div>
  );
}
