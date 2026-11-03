/**
 * Edit-tab Smart Select: canvas clicks become SAM3 include/exclude points
 * sent to POST /api/tools/smart-mask (same contract as the Tools page
 * MaskPainter). The first request uploads the image as a data URL; later
 * clicks reuse the returned input ref, and fall back to a fresh upload once
 * if that ref has gone stale (ComfyUI restart / input cleanup).
 */
export interface SmartPoint {
  x: number;
  y: number;
}

export interface SmartMaskRequest {
  imageUrl: string;
  include: SmartPoint[];
  exclude: SmartPoint[];
  width?: number;
  height?: number;
  /** Uploaded ref from an earlier call for this same imageUrl. */
  cachedRef?: string | null;
}

export interface SmartMaskResult {
  /** data:image/png mask, white = subject. */
  mask: string;
  /** Input ref to reuse for the next click on this image. */
  ref: string | null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function imageUrlToDataUrl(
  url: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  if (url.startsWith("data:")) return url;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Couldn't read the image (${res.status})`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read the image"));
    r.readAsDataURL(blob);
  });
}

export async function requestSmartMask(
  req: SmartMaskRequest,
  deps: {
    fetchImpl?: FetchLike;
    toDataUrl?: (url: string) => Promise<string>;
  } = {},
): Promise<SmartMaskResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const toDataUrl =
    deps.toDataUrl ?? ((u: string) => imageUrlToDataUrl(u, fetchImpl));
  if (req.include.length === 0) throw new Error("Click the subject first");

  const call = async (image: string): Promise<SmartMaskResult> => {
    const res = await fetchImpl("/api/tools/smart-mask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image,
        include: req.include,
        exclude: req.exclude,
        width: req.width,
        height: req.height,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      mask?: string;
      image?: string;
      error?: string;
    };
    if (!res.ok || !data.ok || !data.mask) {
      throw new Error(data.error || `Smart select failed (${res.status})`);
    }
    return { mask: data.mask, ref: data.image ?? null };
  };

  if (req.cachedRef) {
    try {
      return await call(req.cachedRef);
    } catch {
      // Stale ref: upload again below.
    }
  }
  return call(await toDataUrl(req.imageUrl));
}
