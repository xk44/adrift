"use client";

import { useRef, useCallback, useState } from "react";
import { useEditorStore } from "@/store/editorStore";
import { Link, Upload, ArrowRight, ClipboardPaste } from "lucide-react";
import { EditorImagePicker } from "./EditorImagePicker";
import { useWindowImagePaste } from "./useWindowImagePaste";
import { showToast } from "@/components/Toast";
import { firstImageFile, normalizeImageLinkInput } from "./editorStartScreen";
import { VideoStartSection } from "./video/VideoStartSection";
import { openVideoFile } from "./video/openVideo";
import { firstVideoFile } from "@/lib/videoEdit/client";

/**
 * Editor start screen, shown until an image is loaded: drop/paste/upload,
 * an image-link field, and pickers over the user's uploads and generations.
 * Every path ends in `setSourceImage`, which hands off to the canvas editor.
 */
export function EditorEmptyState() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastBlobUrlRef = useRef<string | null>(null);
  const dragDepthRef = useRef(0);
  const setSourceImage = useEditorStore((s) => s.setSourceImage);

  const [isDragging, setIsDragging] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);

  const setSourceImageFromFile = useCallback(
    (file: File) => {
      const previousUrl = lastBlobUrlRef.current;
      const url = URL.createObjectURL(file);
      lastBlobUrlRef.current = url;
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      setSourceImage(url);
    },
    [setSourceImage],
  );

  useWindowImagePaste(setSourceImageFromFile);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Let the same file be picked again after the editor is cleared.
      e.target.value = "";
      if (!file) return;

      // A video opens the video editor instead.
      if (firstVideoFile([file])) {
        void openVideoFile(file);
        return;
      }

      if (!file.type.startsWith("image/")) {
        console.error("Invalid file type");
        showToast("That file isn't an image. Pick a PNG, JPEG or WebP.", "error");
        return;
      }

      setSourceImageFromFile(file);
    },
    [setSourceImageFromFile],
  );

  const handleLinkSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const url = normalizeImageLinkInput(linkValue);
      if (!url) {
        setLinkError("That doesn't look like an image link.");
        return;
      }
      setLinkError(null);
      setSourceImage(url);
    },
    [linkValue, setSourceImage],
  );

  const handleClipboardButton = useCallback(async () => {
    setPasteNotice(null);
    const clipboard =
      typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.read !== "function") {
      setPasteNotice("Press Ctrl+V (or ⌘V) to paste an image.");
      return;
    }
    try {
      const items = await clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (!type) continue;
        const blob = await item.getType(type);
        setSourceImageFromFile(
          new File([blob], "pasted-image", { type: blob.type || type }),
        );
        return;
      }
      setPasteNotice("No image on your clipboard yet. Copy one and try again.");
    } catch {
      setPasteNotice(
        "Clipboard access was blocked. Try Ctrl+V (or ⌘V) instead.",
      );
    }
  }, [setSourceImageFromFile]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current = 0;
      setIsDragging(false);

      const video = firstVideoFile(e.dataTransfer.files);
      if (video && !firstImageFile(e.dataTransfer.files)) {
        void openVideoFile(video);
        return;
      }

      const file = firstImageFile(e.dataTransfer.files);
      if (file) {
        setSourceImageFromFile(file);
        return;
      }

      // Images dragged in from another tab arrive as a link, not a file.
      const dropped =
        e.dataTransfer
          .getData("text/uri-list")
          .split(/\r?\n/)
          .find((line) => line && !line.startsWith("#")) ??
        e.dataTransfer.getData("text/plain");
      const url = dropped ? normalizeImageLinkInput(dropped) : null;
      if (url) setSourceImage(url);
    },
    [setSourceImageFromFile, setSourceImage],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  }, []);

  return (
    <div
      className="flex-1 min-h-0 overflow-y-auto"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      data-testid="editor-start-screen"
    >
      <div className="mx-auto w-full max-w-6xl space-y-8 px-4 py-6 md:px-8 md:py-10">
        <header className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--text-primary)] md:text-3xl">
            What do you want to change?
          </h1>
          <p className="text-sm text-[var(--text-secondary)] md:text-base">
            Bring in a picture to repaint or enhance, or pick up something you
            already made.
          </p>
        </header>

        <div className="grid gap-3 md:grid-cols-2 md:gap-4">
          {/* Drop zone */}
          <div
            className={`flex flex-col justify-between gap-4 rounded-2xl border-2 border-dashed p-5 transition-colors sm:flex-row sm:items-center ${
              isDragging
                ? "border-[var(--accent-primary)] bg-[var(--bg-hover)]"
                : "border-[var(--border-secondary)] bg-transparent"
            }`}
          >
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--bg-tertiary)]">
                <Upload className="h-5 w-5 text-[var(--text-secondary)]" />
              </span>
              <div className="min-w-0">
                <p className="font-medium text-[var(--text-primary)]">
                  {isDragging
                    ? "Let go to start editing"
                    : "Drop an image or video here"}
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  Or paste it from your clipboard.
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={handleClipboardButton}
                title="Paste from clipboard"
                aria-label="Paste from clipboard"
                className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <ClipboardPaste className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="rounded-full bg-[var(--text-primary)] px-4 py-2 text-sm font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90"
              >
                Upload image
              </button>
            </div>
          </div>

          {/* Image link */}
          <form
            onSubmit={handleLinkSubmit}
            className="flex flex-col justify-center gap-3 rounded-2xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-5"
          >
            <label
              htmlFor="editor-image-link"
              className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]"
            >
              <Link className="h-4 w-4 text-[var(--text-secondary)]" />
              Paste an image link
            </label>
            <div className="flex items-center gap-2">
              <input
                id="editor-image-link"
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={linkValue}
                onChange={(e) => {
                  setLinkValue(e.target.value);
                  if (linkError) setLinkError(null);
                }}
                placeholder="https://"
                aria-invalid={linkError ? true : undefined}
                aria-describedby={
                  linkError ? "editor-image-link-error" : undefined
                }
                className="min-w-0 flex-1 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none transition-colors focus:border-[var(--border-accent)]"
              />
              <button
                type="submit"
                disabled={!linkValue.trim()}
                className="group flex shrink-0 items-center gap-1 rounded-lg px-3 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:text-[var(--text-tertiary)] disabled:hover:bg-transparent"
              >
                Add image
                <ArrowRight className="h-4 w-4 transition-transform group-enabled:group-hover:translate-x-0.5" />
              </button>
            </div>
            {linkError && (
              <p
                id="editor-image-link-error"
                role="alert"
                className="text-xs text-[var(--error)]"
              >
                {linkError}
              </p>
            )}
          </form>
        </div>

        {pasteNotice && (
          <p
            role="status"
            className="-mt-4 text-sm text-[var(--text-secondary)]"
          >
            {pasteNotice}
          </p>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          onChange={handleFileSelect}
          className="hidden"
        />

        <VideoStartSection />

        <EditorImagePicker onSelect={setSourceImage} />
      </div>
    </div>
  );
}

export default EditorEmptyState;
