"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { Check, Clipboard, FileImage, Loader2, Upload, X } from "lucide-react";
import { showToast } from "@/components/Toast";
import { useUIStore } from "@/store";
import { useDialogFocus } from "@/hooks/useDialogFocus";

interface DescribeDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface DescribeResponse {
  ok: boolean;
  caption?: string;
  suggestions?: string[];
  error?: string;
}

export function DescribeDialog({ isOpen, onClose }: DescribeDialogProps) {
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [usedPrompt, setUsedPrompt] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Bumped whenever the image changes or the dialog resets/unmounts, so a
  // describe response for a previous image can't land under a new preview.
  const describeGen = useRef(0);
  useEffect(() => () => void describeGen.current++, []);
  const setPromptValue = useUIStore((s) => s.setPromptValue);
  const setActiveNav = useUIStore((s) => s.setActiveNav);

  // Declared before the focus effect below so it records the opener.
  useDialogFocus(dialogRef, isOpen, { initialFocus: "container" });

  // The palette that launches this dialog closes itself, leaving focus
  // nowhere — move focus into the dialog and close on Escape.
  useEffect(() => {
    if (!isOpen) return;
    dialogRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    describeGen.current++;
    setImageFile(null);
    setSuggestions([]);
    setUsedPrompt(null);
    setIsLoading(false);
  }, [isOpen]);

  useEffect(() => {
    if (!imageFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(imageFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  const selectFile = useCallback((file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("Choose an image file", "error");
      return;
    }
    describeGen.current++;
    setIsLoading(false);
    setImageFile(file);
    setSuggestions([]);
    setUsedPrompt(null);
  }, []);

  const describe = useCallback(async () => {
    if (!imageFile || isLoading) return;
    const gen = ++describeGen.current;
    setIsLoading(true);
    setSuggestions([]);
    setUsedPrompt(null);
    try {
      const form = new FormData();
      form.set("image", imageFile);
      const response = await fetch("/api/describe", {
        method: "POST",
        body: form,
      });
      const body = (await response.json().catch(() => ({}))) as DescribeResponse;
      if (gen !== describeGen.current) return;
      if (!response.ok || !body.ok || !body.suggestions?.length) {
        throw new Error(
          body.error ||
            "StyleVault must be running for image description. Start StyleVault and try again.",
        );
      }
      setSuggestions(body.suggestions.slice(0, 4));
    } catch (error) {
      if (gen !== describeGen.current) return;
      showToast(
        error instanceof Error
          ? error.message
          : "StyleVault must be running for image description.",
        "error",
        6000,
      );
    } finally {
      if (gen === describeGen.current) setIsLoading(false);
    }
  }, [imageFile, isLoading]);

  const usePrompt = useCallback(
    (prompt: string) => {
      setPromptValue(prompt);
      setActiveNav("create");
      setUsedPrompt(prompt);
      showToast("Prompt loaded", "success");
      onClose();
      setTimeout(() => {
        const input = document.querySelector(
          "#desktop_input_bar",
        ) as HTMLTextAreaElement | null;
        input?.focus();
      }, 0);
    },
    [onClose, setActiveNav, setPromptValue],
  );

  const copyPrompt = useCallback(async (prompt: string) => {
    if (!navigator.clipboard) {
      showToast("Clipboard unavailable", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(prompt);
      showToast("Prompt copied", "info");
    } catch {
      showToast("Copy failed", "error");
    }
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      selectFile(event.dataTransfer.files[0]);
    },
    [selectFile],
  );

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/60" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-label="Describe image"
        aria-modal="true"
        tabIndex={-1}
        className="fixed left-1/2 top-1/2 z-[61] flex max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-light-100 bg-light-input shadow-2xl outline-none dark:border-dark-750 dark:bg-dark-input"
      >
        <div className="flex items-center justify-between border-b border-light-100 px-4 py-3 dark:border-dark-750">
          <div className="flex items-center gap-2 text-sm font-medium text-light-primary dark:text-dark-primary">
            <FileImage className="h-4 w-4" />
            Describe
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-light-400 transition-colors hover:bg-light-100 hover:text-light-primary dark:text-dark-500 dark:hover:bg-dark-750 dark:hover:text-dark-primary"
            aria-label="Close describe dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 gap-4 overflow-y-auto p-4 md:grid-cols-[220px_1fr]">
          <div className="space-y-3">
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              className={`flex aspect-square items-center justify-center overflow-hidden rounded-xl border border-dashed ${
                isDragging
                  ? "border-splash bg-splash/10"
                  : "border-light-200 bg-light-50 dark:border-dark-700 dark:bg-dark-900"
              }`}
            >
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="flex h-full w-full flex-col items-center justify-center gap-3 text-light-400 transition-colors hover:text-light-primary dark:text-dark-500 dark:hover:text-dark-primary"
                >
                  <Upload className="h-7 w-7" />
                  <span className="text-xs">Drop image or browse</span>
                </button>
              )}
            </div>
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => selectFile(event.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="w-full rounded-lg border border-light-200 px-3 py-2 text-sm text-light-primary transition-colors hover:bg-light-100 dark:border-dark-700 dark:text-dark-primary dark:hover:bg-dark-750"
            >
              Choose Image
            </button>
            <button
              type="button"
              onClick={describe}
              disabled={!imageFile || isLoading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-splash px-3 py-2 text-sm font-medium text-white transition-[background-color,opacity,transform] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileImage className="h-4 w-4" />
              )}
              Describe
            </button>
          </div>

          <div className="min-w-0 space-y-3">
            {suggestions.length === 0 ? (
              <div className="flex min-h-48 items-center justify-center rounded-xl border border-light-100 bg-light-50 px-5 text-center text-sm text-light-400 dark:border-dark-750 dark:bg-dark-900 dark:text-dark-500">
                {isLoading
                  ? "Reading image..."
                  : "Upload an image to generate prompt suggestions."}
              </div>
            ) : (
              suggestions.map((prompt, index) => (
                <div
                  key={`${prompt}-${index}`}
                  className="rounded-xl border border-light-100 bg-light-50 p-3 dark:border-dark-750 dark:bg-dark-900"
                >
                  <p className="text-sm leading-6 text-light-primary dark:text-dark-primary">
                    {prompt}
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => usePrompt(prompt)}
                      className="flex items-center gap-2 rounded-lg bg-light-primary px-3 py-1.5 text-xs font-medium text-light-bg transition-[opacity,transform] hover:opacity-90 active:scale-[0.97] dark:bg-dark-primary dark:text-dark-bg"
                    >
                      {usedPrompt === prompt ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <FileImage className="h-3.5 w-3.5" />
                      )}
                      Use Prompt
                    </button>
                    <button
                      type="button"
                      onClick={() => copyPrompt(prompt)}
                      className="rounded-lg border border-light-200 p-1.5 text-light-500 transition-colors hover:bg-light-100 hover:text-light-primary dark:border-dark-700 dark:text-dark-400 dark:hover:bg-dark-750 dark:hover:text-dark-primary"
                      aria-label="Copy prompt"
                    >
                      <Clipboard className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export default DescribeDialog;
