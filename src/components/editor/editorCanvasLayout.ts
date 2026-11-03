/**
 * Edit-tab canvas sizing: fit the image inside the measured stage, never
 * upscaling past its natural size. Padding is min(80px, 4% of the stage
 * width) with a 16px floor so the edge handles stay visible; a fixed 80px
 * left nothing for the image on a 390px phone.
 */
export interface FitSize {
  width: number;
  height: number;
  scale: number;
}

export function canvasPadding(stageWidth: number): number {
  if (!(stageWidth > 0)) return 16;
  return Math.round(Math.max(16, Math.min(80, stageWidth * 0.04)));
}

export function fitCanvasDisplay(
  stage: { width: number; height: number },
  image: { width: number; height: number } | null,
): FitSize {
  if (!image || !(image.width > 0) || !(image.height > 0)) {
    return { width: 0, height: 0, scale: 1 };
  }
  const pad = canvasPadding(stage.width);
  const maxWidth = Math.max(0, stage.width - pad * 2);
  const maxHeight = Math.max(0, stage.height - pad * 2);
  if (maxWidth === 0 || maxHeight === 0) return { width: 0, height: 0, scale: 1 };
  const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
  return {
    width: image.width * scale,
    height: image.height * scale,
    scale,
  };
}

/** `[` / `]` brush step: ~15% of the current size, at least 1px. */
export function nextBrushSize(size: number, dir: -1 | 1): number {
  const step = Math.max(1, Math.round(size * 0.15));
  return Math.max(1, Math.min(500, size + dir * step));
}
