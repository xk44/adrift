"use client";

import { useState, useCallback } from "react";
import { useEditorStore } from "@/store/editorStore";
import { useGenerationStore } from "@/store";
import { showToast } from "@/components/Toast";
import { downloadName } from "@/lib/output/saveNodes";
import { editorMaskBinaryDataUrl } from "@/lib/editorMask";
import {
  Download,
  ArrowUpRight,
  Sparkles,
  Image as ImageIcon,
  Check,
  Loader2,
  Layers,
} from "lucide-react";

/** Save the selection as a black/white PNG (white = painted); false if empty. */
export function downloadEditorMask(
  canvas: HTMLCanvasElement | null | undefined,
): boolean {
  const url = editorMaskBinaryDataUrl(canvas);
  if (!url) return false;
  const a = document.createElement("a");
  a.href = url;
  a.download = downloadName({ tool: "mask", seed: Date.now(), ext: "png" });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  return true;
}

export function EditorExport() {
  const sourceImage = useEditorStore((s) => s.sourceImage);
  const sourceImageId = useEditorStore((s) => s.sourceImageId);
  const isProcessing = useEditorStore((s) => s.isProcessing);
  const processingMessage = useEditorStore((s) => s.processingMessage);
  const maskCanvas = useEditorStore((s) => s.maskCanvas);
  const sourceDimensions = useEditorStore((s) => s.sourceDimensions);

  const gallery = useGenerationStore((s) => s.gallery);
  const addToGallery = useGenerationStore((s) => s.addToGallery);
  const recentImages = gallery.slice(0, 10);

  const [isDownloading, setIsDownloading] = useState(false);
  const [isUpscaling, setIsUpscaling] = useState(false);
  const [downloadSuccess, setDownloadSuccess] = useState(false);

  const handleDownload = useCallback(async () => {
    if (!sourceImage || isDownloading) return;

    setIsDownloading(true);
    setDownloadSuccess(false);

    try {
      const response = await fetch(sourceImage);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // No seed for editor exports: a timestamp keeps names unique.
      a.download = downloadName({ tool: "edit", seed: Date.now(), ext: "png" });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setDownloadSuccess(true);
      setTimeout(() => setDownloadSuccess(false), 2000);
    } catch (error) {
      console.error("Download failed:", error);
      showToast("Couldn't download the image. Try again.", "error");
    } finally {
      setIsDownloading(false);
    }
  }, [sourceImage, isDownloading]);

  const handleUpscaleToGallery = useCallback(() => {
    if (!sourceImage || isUpscaling) return;

    setIsUpscaling(true);

    try {
      // Add the current editor source image to the gallery (the "save to
      // gallery" behavior the Upscale to Gallery button promises).
      const imageEntry = {
        id: sourceImageId ?? `editor-export-${Date.now()}`,
        url: sourceImage,
        prompt: "Editor export",
        fullPrompt: "Editor export",
        params: [] as string[],
        paramsMap: {} as Record<string, unknown>,
        seed: Math.floor(Math.random() * 2147483647),
        createdAt: new Date().toISOString(),
        runId: "editor-export",
        jobIndex: 0,
        width: sourceDimensions?.width ?? 0,
        height: sourceDimensions?.height ?? 0,
      };

      addToGallery([imageEntry]);
      showToast("Saved to your gallery.", "success");
    } catch (error) {
      console.error("Gallery export failed:", error);
      showToast("Couldn't add the image to your gallery.", "error");
    } finally {
      setIsUpscaling(false);
    }
  }, [sourceImage, sourceImageId, sourceDimensions, isUpscaling, addToGallery]);

  const handleDownloadMask = useCallback(() => {
    if (!downloadEditorMask(maskCanvas)) {
      showToast("Nothing is painted yet. Paint or Smart Select an area first.", "info");
    }
  }, [maskCanvas]);

  return (
    <div className="w-full md:w-64 min-h-0 flex-shrink-0 overflow-y-auto md:overflow-visible bg-[var(--bg-primary)] border-t md:border-t-0 md:border-l border-[var(--border-primary)] flex flex-col">
      {/* Original image thumbnail */}
      {sourceImage && (
        <div className="hidden md:block p-3 border-b border-[var(--border-primary)]">
          <div className="w-full aspect-square rounded-lg overflow-hidden bg-[var(--bg-tertiary)]">
            <img
              src={sourceImage}
              alt="Source"
              className="w-full h-full object-contain"
            />
          </div>
        </div>
      )}

      <div className="hidden md:block flex-1" />

      {/* Export section */}
      <div className="p-3 border-t border-[var(--border-primary)]">
        <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">
          Export Edit
        </h3>

        <div className="space-y-2">
          <button
            onClick={handleUpscaleToGallery}
            disabled={!sourceImage || isProcessing || isUpscaling}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-2">
              {isUpscaling ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4" />
              )}
              <span className="text-sm">{isUpscaling ? "Saving..." : "Save to Gallery"}</span>
            </div>
            <ArrowUpRight className="w-4 h-4" />
          </button>

          <button
            onClick={handleDownload}
            disabled={!sourceImage || isProcessing || isDownloading}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-2">
              {downloadSuccess ? (
                <Check className="w-4 h-4 text-green-500" />
              ) : isDownloading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              <span className="text-sm">
                {downloadSuccess ? "Downloaded!" : isDownloading ? "Downloading..." : "Download Image"}
              </span>
            </div>
            <ArrowUpRight className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={handleDownloadMask}
            disabled={!sourceImage}
            title="Black and white PNG at the image's size (white = painted), for compositing or other apps"
            data-testid="editor-download-mask"
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4" />
              <span className="text-sm">Download Mask</span>
            </div>
            <ArrowUpRight className="w-4 h-4" />
          </button>
        </div>

        {/* Processing indicator */}
        {isProcessing && (
          <div className="mt-3 p-2 rounded-lg bg-[var(--accent-primary)]/10 border border-[var(--accent-primary)]/20">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-[var(--accent-primary)] animate-pulse" />
              <span className="text-xs text-[var(--accent-primary)]">
                {processingMessage || "Processing..."}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Recent images */}
      {recentImages.length > 0 && (
        <div className="p-3 border-t border-[var(--border-primary)] max-h-64 overflow-y-auto">
          <h4 className="text-xs font-medium text-[var(--text-secondary)] mb-2">
            Recent Images
          </h4>
          <div className="grid grid-cols-3 gap-1">
            {recentImages.map((img) => (
              <button
                aria-label="Use this image"
                key={img.id}
                onClick={() =>
                  useEditorStore.getState().setSourceImage(img.url, img.id)
                }
                className="aspect-square rounded overflow-hidden bg-[var(--bg-tertiary)] hover:ring-2 hover:ring-[var(--accent-primary)] transition-all"
              >
                <img
                  src={img.url}
                  alt=""
                  className="w-full h-full object-cover"
                />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default EditorExport;
