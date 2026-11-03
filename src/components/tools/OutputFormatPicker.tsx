"use client";

/**
 * "Master file" picker: optionally save a 16-bit PNG / EXR (images) or
 * ProRes 4444 (video) copy next to the normal result. Hidden entirely when
 * the server can't write any of them. The choice sticks for later runs.
 */

import { useEffect, useState } from "react";
import {
  IMAGE_MASTER_LABELS,
  VIDEO_MASTER_LABELS,
  type ImageMasterFormat,
  type MasterAvailability,
  type MasterChoice,
  type VideoMasterFormat,
} from "@/lib/output/saveNodes";
import {
  fetchMasterFormats,
  readMasterChoice,
  writeMasterChoice,
} from "@/lib/output/masterChoiceClient";

const SELECT =
  "h-8 rounded-lg border border-light-100 bg-light-input px-2 text-xs text-light-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-splash dark:border-dark-750 dark:bg-dark-input dark:text-dark-primary";

export function OutputFormatPicker({
  media = "both",
}: {
  /** Which rows to show; "both" when the run may produce either. */
  media?: "image" | "video" | "both";
}) {
  const [avail, setAvail] = useState<MasterAvailability | null>(null);
  const [choice, setChoice] = useState<MasterChoice>({});

  useEffect(() => {
    let alive = true;
    setChoice(readMasterChoice());
    void fetchMasterFormats().then((a) => {
      if (alive) setAvail(a);
    });
    return () => {
      alive = false;
    };
  }, []);

  const showImage = media !== "video" && (avail?.image.length ?? 0) > 1;
  const showVideo = media !== "image" && (avail?.video.length ?? 0) > 1;
  if (!showImage && !showVideo) return null;

  const update = (next: MasterChoice) => {
    setChoice(next);
    writeMasterChoice(next);
  };

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-light-500 dark:text-dark-400"
      data-testid="output-format-picker"
    >
      <span title="Saves an extra high-quality copy for editing or compositing. It shows up under Other outputs in the viewer.">
        Master file
      </span>
      {showImage && (
        <label className="flex items-center gap-1.5">
          <span className="sr-only">Image master format</span>
          <select
            className={SELECT}
            value={choice.image ?? "png"}
            onChange={(e) =>
              update({ ...choice, image: e.target.value as ImageMasterFormat })
            }
          >
            {avail!.image.map((f) => (
              <option key={f} value={f}>
                {f === "png" ? "Image: none extra" : `Image: ${IMAGE_MASTER_LABELS[f]}`}
              </option>
            ))}
          </select>
        </label>
      )}
      {showVideo && (
        <label className="flex items-center gap-1.5">
          <span className="sr-only">Video master format</span>
          <select
            className={SELECT}
            value={choice.video ?? "h264"}
            onChange={(e) =>
              update({ ...choice, video: e.target.value as VideoMasterFormat })
            }
          >
            {avail!.video.map((f) => (
              <option key={f} value={f}>
                {f === "h264" ? "Video: none extra" : `Video: ${VIDEO_MASTER_LABELS[f]}`}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
