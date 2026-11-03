/**
 * Runs "Upscale after" chains (lib/upscale/upscaleAfter.ts): when a chained
 * tool run finishes, queue Upscale / Upscale video on its result. Mounted
 * once on the app page so chains fire whichever view is open.
 */

import { useEffect, useRef, useState } from "react";
import { useGenerationStore } from "@/store";
import { useUpscaleAfterStore } from "@/store/upscaleAfterStore";
import { showToast } from "@/components/Toast";
import { STORAGE_KEYS } from "@/lib/storageKeys";
import { planUpscaleChain, chainLabel } from "@/lib/upscale/upscaleAfter";
import { queueUpscaleSteps } from "@/lib/upscale/upscaleAfterRunner";

const TICK_MS = 30_000;

export function useUpscaleAfter() {
  const runs = useGenerationStore((s) => s.runs);
  const chains = useUpscaleAfterStore((s) => s.chains);
  const inflight = useRef(new Set<string>());
  const [tick, setTick] = useState(0);

  // Another tab may own a chain: take its writes so both don't queue it.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.upscaleAfter)
        void useUpscaleAfterStore.persist.rehydrate();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const anyWaiting = Object.values(chains).some((c) => c.status === "waiting");
  // Re-check on a slow beat too: grace periods and expiry need no store change.
  useEffect(() => {
    if (!anyWaiting) return;
    const t = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(t);
  }, [anyWaiting]);

  useEffect(() => {
    const store = useUpscaleAfterStore.getState();
    for (const chain of Object.values(chains)) {
      const id = chain.parentRunId;
      if (chain.status !== "waiting" || inflight.current.has(id)) continue;
      const plan = planUpscaleChain(
        chain,
        runs.find((r) => r.run_id === id),
      );
      if (plan.kind === "wait") continue;
      if (plan.kind === "skip" || plan.kind === "fail") {
        store.patch(id, {
          status: plan.kind === "skip" ? "skipped" : "failed",
          note: plan.note,
        });
        showToast(
          `Upscale after skipped: ${plan.note}`,
          plan.kind === "skip" ? "info" : "error",
          6000,
        );
        continue;
      }
      inflight.current.add(id);
      store.patch(id, { status: "queued" });
      const { addRun, clientId } = useGenerationStore.getState();
      const children: string[] = [];
      void queueUpscaleSteps(id, plan.steps, {
        fetchImpl: fetch,
        clientId,
        onWarnings: (w) => w.forEach((m) => showToast(m, "info", 8000)),
        onRun: (run) => {
          children.push(run.run_id);
          useUpscaleAfterStore
            .getState()
            .patch(id, { children: [...children] });
          addRun(run);
          // Lazy: keeps the runner module out of the page's first bundle.
          if (chain.cardKey)
            void import("@/components/tools/RunnerStudio").then((m) =>
              m.useRecentRunsStore.getState().note(chain.cardKey, [run.run_id]),
            );
        },
      })
        .then(() =>
          showToast(
            `${chainLabel(chain.factor, plan.steps[0]?.toolId === "upscale_video" ? "video" : "image")} queued after ${chain.parentLabel}.`,
            "success",
          ),
        )
        .catch((e: unknown) => {
          const note = e instanceof Error ? e.message : String(e);
          useUpscaleAfterStore.getState().patch(id, {
            status: children.length ? "queued" : "failed",
            note,
          });
          showToast(`Upscale after failed: ${note}`, "error", 8000);
        })
        .finally(() => inflight.current.delete(id));
    }
  }, [runs, chains, tick]);
}
