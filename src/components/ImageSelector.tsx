"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useUIStore } from "@/store";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import type { ImageAttachment, ImageMode } from "@/types";
import {
  X,
  Upload,
  Image as ImageIcon,
  Palette,
  User,
  Film,
  Lock,
  Unlock,
  Trash2,
} from "lucide-react";

const IMAGE_MODES: {
  mode: ImageMode;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  {
    mode: "starting_frame",
    label: "Starting Frame",
    description: "Animate an image",
    icon: Film,
  },
  {
    mode: "image_prompt",
    label: "Image Prompts",
    description: "Use the elements of an image",
    icon: ImageIcon,
  },
  {
    mode: "style_ref",
    label: "Style References",
    description: "Use the style of an image",
    icon: Palette,
  },
  {
    mode: "char_ref",
    label: "Omni Reference",
    description: "Use a person's likeness, or an object's form",
    icon: User,
  },
];

export function ImageSelector() {
  const imageSelectorOpen = useUIStore((s) => s.imageSelectorOpen);
  const setImageSelectorOpen = useUIStore((s) => s.setImageSelectorOpen);
  const imageAttachments = useUIStore((s) => s.imageAttachments);
  const addImageAttachment = useUIStore((s) => s.addImageAttachment);
  const removeImageAttachment = useUIStore((s) => s.removeImageAttachment);
  const clearImageAttachments = useUIStore((s) => s.clearImageAttachments);
  const imageAttachmentsLocked = useUIStore((s) => s.imageAttachmentsLocked);
  const setImageAttachmentsLocked = useUIStore(
    (s) => s.setImageAttachmentsLocked,
  );
  const imageSelectorDefaultMode = useUIStore(
    (s) => s.imageSelectorDefaultMode,
  );
  const setImageSelectorDefaultMode = useUIStore(
    (s) => s.setImageSelectorDefaultMode,
  );

  const [dragOver, setDragOver] = useState<ImageMode | null>(null);
  const [selectedMode, setSelectedMode] = useState<ImageMode>("image_prompt");
  const latestAttachmentsRef = useRef<ImageAttachment[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, imageSelectorOpen);

  // Open on the tab the caller asked for (e.g. the prompt bar's "Style
  // References" section), then consume the request so later opens default
  // back to the last-used tab.
  useEffect(() => {
    if (imageSelectorOpen && imageSelectorDefaultMode) {
      setSelectedMode(imageSelectorDefaultMode);
      setImageSelectorDefaultMode(null);
    }
  }, [
    imageSelectorOpen,
    imageSelectorDefaultMode,
    setImageSelectorDefaultMode,
  ]);

  // Escape closes the modal (backdrop click already does for pointer users)
  useEffect(() => {
    if (!imageSelectorOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setImageSelectorOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [imageSelectorOpen, setImageSelectorOpen]);

  const revokeAttachmentUrl = useCallback((attachment: ImageAttachment) => {
    if (attachment.url.startsWith("blob:")) {
      URL.revokeObjectURL(attachment.url);
    }
  }, []);

  latestAttachmentsRef.current = imageAttachments;

  useEffect(() => {
    return () => {
      latestAttachmentsRef.current.forEach(revokeAttachmentUrl);
    };
  }, [revokeAttachmentUrl]);

  const handleRemoveAttachment = useCallback(
    (attachment: ImageAttachment) => {
      revokeAttachmentUrl(attachment);
      removeImageAttachment(attachment.id);
    },
    [removeImageAttachment, revokeAttachmentUrl],
  );

  const handleClearAttachments = useCallback(() => {
    imageAttachments.forEach(revokeAttachmentUrl);
    clearImageAttachments();
  }, [clearImageAttachments, imageAttachments, revokeAttachmentUrl]);

  const handleDrop = useCallback(
    (e: React.DragEvent, mode: ImageMode) => {
      e.preventDefault();
      setDragOver(null);

      const files = Array.from(e.dataTransfer.files).filter((f) =>
        f.type.startsWith("image/"),
      );

      for (const file of files) {
        const url = URL.createObjectURL(file);
        addImageAttachment({
          id: crypto.randomUUID(),
          url,
          file,
          filename: file.name,
          mode,
          weight: 1.0,
        });
      }
    },
    [addImageAttachment],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>, mode: ImageMode) => {
      const files = e.target.files;
      if (!files) return;

      for (const file of Array.from(files)) {
        if (file.type.startsWith("image/")) {
          const url = URL.createObjectURL(file);
          addImageAttachment({
            id: crypto.randomUUID(),
            url,
            file,
            filename: file.name,
            mode,
            weight: 1.0,
          });
        }
      }

      e.target.value = "";
    },
    [addImageAttachment],
  );

  if (!imageSelectorOpen) return null;

  const attachmentsByMode = IMAGE_MODES.map((m) => ({
    ...m,
    attachments: imageAttachments.filter((a) => a.mode === m.mode),
  }));

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => setImageSelectorOpen(false)}
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Select images"
        className="relative z-10 w-full max-w-5xl mx-4 bg-[var(--bg-secondary)] rounded-2xl border border-[var(--border-primary)] shadow-2xl overflow-hidden animate-scale-in"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-primary)]">
          <div className="flex items-center gap-6">
            {IMAGE_MODES.map((m) => {
              const Icon = m.icon;
              const isSelected = selectedMode === m.mode;
              const count = imageAttachments.filter(
                (a) => a.mode === m.mode,
              ).length;
              return (
                <button
                  key={m.mode}
                  onClick={() => setSelectedMode(m.mode)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors ${
                    isSelected
                      ? "bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]"
                      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span className="text-sm font-medium">{m.label}</span>
                  {count > 0 && (
                    <span className="px-1.5 py-0.5 text-xs bg-[var(--accent-primary)] text-white rounded-full">
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setImageAttachmentsLocked(!imageAttachmentsLocked)}
              className={`p-2 rounded-lg transition-colors ${
                imageAttachmentsLocked
                  ? "bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              }`}
              title={
                imageAttachmentsLocked
                  ? "Unlock (clear after generation)"
                  : "Lock (keep after generation)"
              }
            >
              {imageAttachmentsLocked ? (
                <Lock className="w-5 h-5" />
              ) : (
                <Unlock className="w-5 h-5" />
              )}
            </button>

            <button
              onClick={handleClearAttachments}
              className="p-2 text-[var(--text-tertiary)] hover:text-[var(--error)] rounded-lg"
              title="Clear all images"
            >
              <Trash2 className="w-5 h-5" />
            </button>

            <button
              onClick={() => setImageSelectorOpen(false)}
              className="p-2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] rounded-lg"
              title="Close"
              aria-label="Close image selector"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex h-[500px]">
          {/* Drop zone */}
          <div className="w-64 p-4 border-r border-[var(--border-primary)]">
            <div
              onDrop={(e) => handleDrop(e, selectedMode)}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(selectedMode);
              }}
              onDragLeave={() => setDragOver(null)}
              className={`h-full flex flex-col items-center justify-center rounded-xl border-2 border-dashed transition-colors ${
                dragOver === selectedMode
                  ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]/5"
                  : "border-[var(--border-primary)]"
              }`}
            >
              <Upload className="w-8 h-8 text-[var(--text-muted)] mb-3" />
              <p className="text-sm text-[var(--text-secondary)] text-center mb-3">
                Upload a file or
                <br />
                drop it here
              </p>
              <label className="btn btn-secondary cursor-pointer">
                <span>Browse</span>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => handleFileSelect(e, selectedMode)}
                  className="hidden"
                />
              </label>
            </div>
          </div>

          {/* Selected images grid */}
          <div className="flex-1 p-4 overflow-y-auto">
            {attachmentsByMode.find((m) => m.mode === selectedMode)?.attachments
              .length === 0 ? (
              <div className="h-full flex items-center justify-center text-[var(--text-muted)]">
                <p className="text-sm">
                  No images selected for{" "}
                  {IMAGE_MODES.find((m) => m.mode === selectedMode)?.label}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-4 gap-3">
                {attachmentsByMode
                  .find((m) => m.mode === selectedMode)
                  ?.attachments.map((attachment) => (
                    <ImageCard
                      key={attachment.id}
                      attachment={attachment}
                      onRemove={() => handleRemoveAttachment(attachment)}
                    />
                  ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer info */}
        <div className="px-6 py-3 bg-[var(--bg-tertiary)] border-t border-[var(--border-primary)]">
          <p className="text-xs text-[var(--text-muted)]">
            {IMAGE_MODES.find((m) => m.mode === selectedMode)?.description}
          </p>
        </div>
      </div>
    </div>
  );
}

interface ImageCardProps {
  attachment: ImageAttachment;
  onRemove: () => void;
}

function ImageCard({ attachment, onRemove }: ImageCardProps) {
  return (
    <div className="relative group aspect-square rounded-lg overflow-hidden bg-[var(--bg-tertiary)]">
      <img
        src={attachment.url}
        alt={attachment.filename ?? "Uploaded image"}
        className="w-full h-full object-cover"
      />
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors">
        <button
          onClick={onRemove}
          className="absolute top-2 right-2 p-1.5 bg-black/60 rounded-lg text-white opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity hover:bg-black/80"
          title="Remove image"
          aria-label={`Remove ${attachment.filename ?? "image"}`}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      {attachment.filename && (
        <div className="absolute bottom-0 left-0 right-0 px-2 py-1 bg-gradient-to-t from-black/60 to-transparent">
          <p className="text-xs text-white truncate">{attachment.filename}</p>
        </div>
      )}
    </div>
  );
}

export default ImageSelector;
