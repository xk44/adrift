/**
 * Server-side VLM probe for the auto-detail action. Fetches the source image
 * from ComfyUI's /view endpoint and asks StyleVault's Qwen-VL captioner the
 * structured PROBE_INSTRUCTION. Failures degrade to plan defaults — the
 * refine action must never block on the probe.
 */
import { env } from "@/lib/env";
import {
  buildAutoDetailPlan,
  parseProbeResponse,
  PROBE_INSTRUCTION,
  type AutoDetailPlan,
} from "./autoDetail";
import { comfyFetch } from "@/lib/comfy/comfyFetch";

const IMAGE_FETCH_TIMEOUT_MS = 15000;
const PROBE_TIMEOUT_MS = 90000;

export async function planAutoDetail(
  sourceViewUrl: string | undefined,
): Promise<AutoDetailPlan> {
  try {
    if (!sourceViewUrl) return buildAutoDetailPlan(null);

    // Source images are ComfyUI /view URLs; comfyFetch only attaches the
    // ComfyUI bearer when the URL is on the configured ComfyUI origin.
    const imageRes = await comfyFetch(sourceViewUrl, {
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    });
    if (!imageRes.ok) return buildAutoDetailPlan(null);
    const bytes = Buffer.from(await imageRes.arrayBuffer());

    const params = new URLSearchParams({
      filename: "auto-detail-probe.png",
      prompt: PROBE_INSTRUCTION,
    });
    const svRes = await fetch(
      `${env.STYLEVAULT_API_URL}/caption/image?${params.toString()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
    );
    if (!svRes.ok) return buildAutoDetailPlan(null);
    const body = await svRes.json();
    const probe =
      typeof body?.caption === "string"
        ? parseProbeResponse(body.caption)
        : null;
    return buildAutoDetailPlan(probe);
  } catch {
    return buildAutoDetailPlan(null);
  }
}
