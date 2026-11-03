/**
 * useDraftUpscale — auto-fires upscale actions for completed draft runs.
 *
 * When a `--draft` run completes, the generation store queues a
 * DraftUpscaleRequest. This hook consumes those requests and POSTs to
 * /api/jobs/action with the appropriate refiner slot (default: upscale_subtle).
 *
 * Mount this hook once in the Gallery or App component. It is idempotent:
 * each request is consumed atomically via consumeDraftUpscale().
 */

import { useEffect, useRef } from "react";
import { useGenerationStore } from "@/store";
import { toastNodeWarnings } from "@/components/Toast";

export function useDraftUpscale() {
  const pendingCount = useGenerationStore((s) => s.pendingDraftUpscales.length);
  const consumeDraftUpscale = useGenerationStore((s) => s.consumeDraftUpscale);
  const addRun = useGenerationStore((s) => s.addRun);
  const clientId = useGenerationStore((s) => s.clientId);
  const processingRef = useRef(false);

  useEffect(() => {
    if (pendingCount === 0 || processingRef.current) return;

    processingRef.current = true;

    (async () => {
      // Drain the queue one at a time to avoid duplicate upscales
      let req = consumeDraftUpscale();
      while (req) {
        try {
          const response = await fetch("/api/jobs/action", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              run_id: req.runId,
              job_index: req.jobIndex,
              action: req.refinerSlot,
              client_id: clientId,
            }),
          });
          const data = await response.json();
          if (data.ok && data.run) {
            addRun(data.run);
            toastNodeWarnings(data);
          } else {
            console.warn(
              `[DraftUpscale] Failed to auto-upscale run=${req.runId} job=${req.jobIndex}:`,
              data.error ?? "unknown",
            );
          }
        } catch (err) {
          console.warn("[DraftUpscale] Network error:", err);
        }
        req = consumeDraftUpscale();
      }

      processingRef.current = false;
    })();
  }, [pendingCount, consumeDraftUpscale, addRun, clientId]);
}
