"use client";

/**
 * Client view of GET /api/comfy/workflows/missing-nodes: which pack/modes use
 * node classes the connected ComfyUI doesn't have. `refresh()` forces a fresh
 * /object_info server-side (e.g. after installing a custom node).
 */

import { useCallback, useEffect, useState } from "react";
import type {
  PackKindNodeStatus,
  PackNodeAvailability,
} from "@/lib/comfy/packNodeAvailability";

export function usePackNodeAvailability(): {
  availability: PackNodeAvailability | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [availability, setAvailability] =
    useState<PackNodeAvailability | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (fresh: boolean) => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/comfy/workflows/missing-nodes${fresh ? "?fresh=1" : ""}`,
        { cache: "no-store" },
      );
      const data = (await res.json().catch(() => null)) as
        | (PackNodeAvailability & { ok?: boolean })
        | null;
      setAvailability(res.ok && data?.ok ? data : null);
    } catch {
      setAvailability(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);
  return { availability, loading, refresh };
}

/** Tooltip text for a pack/mode that can't run (missing nodes or model
 * files); null when runnable. */
export function describeMissingNodes(
  status: PackKindNodeStatus | undefined,
  candidates: PackNodeAvailability["candidates"] | undefined,
): string | null {
  if (!status) return null;
  const parts: string[] = [];
  if (status.missing.length > 0) {
    const lines = status.missing.map((ct) => {
      const repos = (candidates?.[ct] ?? []).map((c) => c.label);
      return repos.length ? `• ${ct} — ${repos.slice(0, 2).join(" / ")}` : `• ${ct}`;
    });
    parts.push(`Missing ComfyUI nodes:\n${lines.join("\n")}`);
  }
  if (status.missingAssets?.length) {
    parts.push(
      `Missing model files:\n${status.missingAssets.map((a) => `• ${a}`).join("\n")}`,
    );
  }
  return parts.length ? parts.join("\n") : null;
}

/** Missing nodes + missing model files: what blocks this pack/mode. */
export function blockerCount(status: PackKindNodeStatus | undefined): number {
  if (!status) return 0;
  return status.missing.length + (status.missingAssets?.length ?? 0);
}
