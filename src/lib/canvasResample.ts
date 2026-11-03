/**
 * High-quality browser resampling.
 *
 * A 2D canvas defaults to imageSmoothingQuality "low", which aliases badly
 * on large downscales (moire on fabric, jagged hair). Every place that
 * resamples pixels the user will keep goes through these helpers instead.
 * Big reductions are done in halving steps (each step at most 2x) so the
 * result stays sharp without the shimmer a single huge jump leaves.
 */

/** Turn on the best smoothing the browser has for this context. */
export function smoothContext(ctx: CanvasRenderingContext2D): void {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
}

/**
 * Intermediate sizes from (w,h) down to (tw,th), each step at most halving
 * the long side; the last entry is the target. Upscales and small changes
 * are one step.
 */
export function resampleSteps(
  w: number,
  h: number,
  tw: number,
  th: number,
): { width: number; height: number }[] {
  const steps: { width: number; height: number }[] = [];
  let cw = w;
  let ch = h;
  while (cw / 2 > tw && ch / 2 > th) {
    cw = Math.round(cw / 2);
    ch = Math.round(ch / 2);
    steps.push({ width: cw, height: ch });
  }
  steps.push({ width: tw, height: th });
  return steps;
}

/** Draw `src` into a new canvas of (tw,th) with high-quality resampling. */
export function resampleToCanvas(
  src: CanvasImageSource & { width: number; height: number },
  srcWidth: number,
  srcHeight: number,
  tw: number,
  th: number,
  background?: string,
): HTMLCanvasElement {
  let from: CanvasImageSource = src;
  let fw = srcWidth;
  let fh = srcHeight;
  let out: HTMLCanvasElement | null = null;
  for (const step of resampleSteps(srcWidth, srcHeight, tw, th)) {
    const c = document.createElement("canvas");
    c.width = step.width;
    c.height = step.height;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is unavailable.");
    smoothContext(ctx);
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, step.width, step.height);
    }
    ctx.drawImage(from, 0, 0, fw, fh, 0, 0, step.width, step.height);
    from = c;
    fw = step.width;
    fh = step.height;
    out = c;
  }
  return out as HTMLCanvasElement;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not read that image."));
    img.src = src;
  });
}

/** Resample an image URL to (tw,th) and encode it as `mime` (data URL). */
export async function resampleDataUrl(
  src: string,
  tw: number,
  th: number,
  mime: string,
  quality?: number,
  background?: string,
): Promise<string> {
  const img = await loadImage(src);
  const canvas = resampleToCanvas(
    img,
    img.naturalWidth,
    img.naturalHeight,
    tw,
    th,
    background,
  );
  return canvas.toDataURL(mime, quality);
}
