"use client";

import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { X, User } from "lucide-react";
import { useUIStore } from "@/store";
import { useStyleStore } from "@/store/styleStore";
import type { ImageAttachment, ImageMode } from "@/types";
import type { SREFItem } from "@/lib/sref/srefParser";
import {
  dragHasFiles,
  imageFilesToAttachments,
  pickImageFiles,
} from "@/lib/ui/imageDrop";

function PlayCircleIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
      <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function ImagePromptIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 22 22"
      fill="currentColor"
      stroke="none"
      strokeWidth="1"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M20 11C20 15.9706 15.9706 20 11 20C6.02944 20 2 15.9706 2 11C2 6.02944 6.02944 2 11 2C15.9706 2 20 6.02944 20 11ZM18.334 11C18.334 6.94954 15.0505 3.66602 11 3.66602C6.94954 3.66602 3.66602 6.94954 3.66602 11C3.66602 15.0505 6.94954 18.334 11 18.334C15.0505 18.334 18.334 15.0505 18.334 11Z"
      />
      <path
        d="M3 12.9998C6.00024 11 9 10.9998 11 12.5C13 14.0002 17 14.0001 19 12.0001"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <circle cx="13.5" cy="8.5" r="1.5" />
    </svg>
  );
}

function StyleReferenceIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 22 22"
      fill="currentColor"
      stroke="none"
      strokeWidth="1"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M20 11C20 15.9706 15.9706 20 11 20C6.02944 20 2 15.9706 2 11C2 6.02944 6.02944 2 11 2C15.9706 2 20 6.02944 20 11ZM12.5029 3.82031C12.0178 3.71928 11.5151 3.66602 11 3.66602C10.6286 3.66602 10.2638 3.69381 9.90723 3.74707C9.79126 4.65547 9.19795 6.21131 8.1377 7.66895C7.13309 9.05001 5.6575 10.4116 3.66797 11.0508C3.67275 11.7559 3.77829 12.4365 3.96875 13.0811C5.90442 12.808 7.10087 11.5311 8.31152 9.7207C9.47338 7.98323 10.6582 5.70147 12.5029 3.82031ZM8.46387 4.11719C6.09508 4.99031 4.30246 7.05083 3.80566 9.57715C5.18516 8.99154 6.26687 7.97451 7.05957 6.88477C7.80205 5.86402 8.25689 4.82808 8.46387 4.11719ZM16.6182 6.28613C15.8976 5.4282 14.9839 4.73852 13.9443 4.28223C11.9557 6.08471 10.8111 8.37899 9.41895 10.4609C8.20008 12.2836 6.78961 13.9034 4.47656 14.3486C4.95178 15.2725 5.61667 16.0816 6.4209 16.7256C7.97742 16.5377 9.0162 16.1029 9.72363 15.4502C10.5424 14.6948 11.0247 13.5501 11.2383 11.8232C11.4862 9.8187 12.4453 8.51236 13.7061 7.62891C14.5925 7.00777 15.622 6.60154 16.6182 6.28613ZM18.1768 9.4834C18.0238 8.75592 17.7632 8.0681 17.4121 7.4375C16.3355 7.75793 15.3096 8.13288 14.4707 8.7207C13.4935 9.40551 12.7594 10.3861 12.5615 11.9863C12.3294 13.8639 11.7754 15.3708 10.6279 16.4297C9.96229 17.0438 9.13252 17.4718 8.13086 17.75C9.01228 18.1251 9.98162 18.334 11 18.334C11.479 18.334 11.947 18.2859 12.4004 18.1982C12.4385 17.8235 12.5108 17.4268 12.6123 17.0244C12.8407 16.1194 13.2259 15.1126 13.7451 14.1279C14.7207 12.2778 16.2275 10.4029 18.1768 9.4834ZM18.332 10.9053C16.9338 11.7157 15.7553 13.1751 14.9248 14.75C14.4511 15.6483 14.1058 16.5561 13.9053 17.3506C13.8681 17.498 13.838 17.6396 13.8115 17.7744C16.4665 16.6713 18.334 14.0543 18.334 11C18.334 10.9684 18.3324 10.9368 18.332 10.9053Z"
      />
    </svg>
  );
}

function ControlNetIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  );
}

const SECTION_DEFS: Array<{
  mode: ImageMode;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  {
    mode: "starting_frame",
    label: "Start Frame",
    description: "Animate an image",
    icon: PlayCircleIcon,
  },
  {
    mode: "image_prompt",
    label: "Image Prompts",
    description: "Use the elements of an image",
    icon: ImagePromptIcon,
  },
  {
    mode: "style_ref",
    label: "Style References",
    description: "Use the style of an image",
    icon: StyleReferenceIcon,
  },
  {
    mode: "char_ref",
    label: "Character References",
    description: "Use a character likeness",
    icon: User,
  },
  {
    mode: "control",
    label: "Control",
    description: "Structure, pose, depth map",
    icon: ControlNetIcon,
  },
];

export function PromptAttachmentSections() {
  const imageAttachments = useUIStore((s) => s.imageAttachments);
  const imageAttachmentsLocked = useUIStore((s) => s.imageAttachmentsLocked);
  const setImageAttachmentsLocked = useUIStore(
    (s) => s.setImageAttachmentsLocked,
  );
  const clearImageAttachments = useUIStore((s) => s.clearImageAttachments);
  const setImageSelectorOpen = useUIStore((s) => s.setImageSelectorOpen);
  const setImageSelectorDefaultMode = useUIStore(
    (s) => s.setImageSelectorDefaultMode,
  );
  const expanded = useUIStore((s) => s.attachmentSectionsExpanded);
  const addImageAttachment = useUIStore((s) => s.addImageAttachment);
  // Column under a file drag: dropping an image adds it in that mode.
  const [dropMode, setDropMode] = useState<ImageMode | null>(null);
  // Collapsed (0fr) content is still in the DOM: make it inert so Tab and
  // screen readers skip it. React 18 has no `inert` prop, so set it directly.
  const collapsedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    collapsedRef.current?.toggleAttribute("inert", !expanded);
  }, [expanded]);

  const sref = useStyleStore((s) => s.sref);
  const srefItems = sref?.items ?? [];
  const hasAnySref = srefItems.length > 0;

  const grouped = useMemo(
    () =>
      SECTION_DEFS.map((section) => ({
        ...section,
        attachments: imageAttachments.filter(
          (attachment) => attachment.mode === section.mode,
        ),
      })),
    [imageAttachments],
  );

  const hasAttachments = imageAttachments.length > 0;

  return (
    <div
      className="grid transition-[grid-template-rows] duration-200 ease-out"
      style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
    >
      <div className="overflow-hidden" ref={collapsedRef}>
        <div className="flex flex-col">
          {/* Separator line — h-px between textarea and sections */}
          <div className="w-full h-px bg-[var(--border-primary)]" />

          {/* Three-column layout + Lock/Trash buttons — always visible */}
          <div className="flex flex-row">
            {grouped.map((section, i) => {
              const isStyleRef = section.mode === "style_ref";
              const isActive =
                section.attachments.length > 0 || (isStyleRef && hasAnySref);

              return (
                <div
                  key={section.mode}
                  onClick={() => {
                    setImageSelectorDefaultMode(section.mode);
                    setImageSelectorOpen(true);
                  }}
                  onDragOver={(e) => {
                    if (!dragHasFiles(e.dataTransfer?.types)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                    if (dropMode !== section.mode) setDropMode(section.mode);
                  }}
                  onDragLeave={(e) => {
                    if (
                      !e.currentTarget.contains(e.relatedTarget as Node | null)
                    ) {
                      setDropMode(null);
                    }
                  }}
                  onDrop={(e) => {
                    if (!dragHasFiles(e.dataTransfer?.types)) return;
                    // Claimed here so the window-level workflow import skips it.
                    e.preventDefault();
                    setDropMode(null);
                    for (const attachment of imageFilesToAttachments(
                      pickImageFiles(e.dataTransfer.files),
                      section.mode,
                    )) {
                      addImageAttachment(attachment);
                    }
                  }}
                  data-drop-target={dropMode === section.mode ? "" : undefined}
                  className={[
                    "relative cursor-pointer flex flex-row px-1 py-1 min-h-[80px] transition-colors duration-75",
                    i < grouped.length - 1
                      ? "border-r border-[var(--border-primary)]"
                      : "",
                    i === 0 ? "rounded-bl-xl" : "",
                    dropMode === section.mode
                      ? "bg-[var(--accent-primary)]/10 shadow-[inset_0_0_0_1px_var(--accent-primary)]"
                      : isActive
                        ? "shadow-[inset_0px_5px_15px_rgba(0,0,0,0.39)] bg-[var(--bg-primary)]"
                        : "hover:bg-[var(--bg-hover)]",
                  ].join(" ")}
                  style={{
                    flex: "1 1 160px",
                    transition: "flex-basis 0.2s ease-out",
                  }}
                  role="button"
                  tabIndex={0}
                  title={`${section.label}: ${section.description}`}
                  aria-label={`${section.label}: ${section.description}`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setImageSelectorDefaultMode(section.mode);
                      setImageSelectorOpen(true);
                    }
                  }}
                >
                  {/* Label — absolute positioned top-left */}
                  <div
                    className={[
                      "absolute top-2 left-3 right-1 z-10 pointer-events-none",
                      "flex items-center justify-start font-medium gap-2 w-auto",
                      isActive && isStyleRef
                        ? "text-[var(--accent-primary)]"
                        : "text-[var(--text-muted)]",
                    ].join(" ")}
                  >
                    <div className="flex min-w-0 max-w-full flex-col items-start gap-0.5">
                      <div className="flex min-w-0 max-w-full items-center justify-between relative">
                        <div className="flex min-w-0 items-center gap-1">
                          <span className="min-h-6 flex-shrink-0 mt-0 flex items-center">
                            <section.icon className="h-4 w-4" />
                          </span>
                          {/* Up to two lines ("Character / References") instead of an ellipsis mid-word. */}
                          <div
                            className="hidden sm:block min-w-0 line-clamp-2 break-words text-sm leading-tight transition-opacity duration-200 mr-2"
                            data-testid="attachment-section-label"
                          >
                            {section.label}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Thumbnails area — right-justified */}
                  <div className="flex flex-wrap gap-1 overflow-y-auto max-h-40 microScrollbar p-1 flex-grow justify-end relative pl-9">
                    <div className="flex flex-wrap gap-1 justify-end ml-auto">
                      <SectionThumbnails
                        section={section}
                        isStyleRef={isStyleRef}
                        srefItems={srefItems}
                      />
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Lock + Trash column — flex-col on the right */}
            <div className="flex flex-col justify-start ml-auto items-end p-1">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setImageAttachmentsLocked(!imageAttachmentsLocked);
                }}
                className="flex items-center justify-center rounded size-6 p-0 mb-1 bg-[var(--bg-hover)] text-[var(--text-primary)] transition-colors hover:opacity-80"
                title="Keep Image Prompts"
                aria-label="Keep image prompts after sending"
                aria-pressed={imageAttachmentsLocked}
              >
                {imageAttachmentsLocked ? (
                  <LockClosedIcon className="h-4 w-4" />
                ) : (
                  <LockOpenIcon className="h-4 w-4" />
                )}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  clearImageAttachments();
                }}
                disabled={!hasAttachments && !hasAnySref}
                className="flex items-center justify-center rounded size-6 p-0 bg-[var(--bg-hover)] text-[var(--text-primary)] transition-colors hover:opacity-80 disabled:pointer-events-none disabled:opacity-20"
                title="Clear Image Prompts"
                aria-label="Clear image prompts"
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionThumbnails({
  section,
  isStyleRef,
  srefItems,
}: {
  section: {
    mode: ImageMode;
    label: string;
    attachments: ImageAttachment[];
  };
  isStyleRef: boolean;
  srefItems: SREFItem[];
}) {
  const removeImageAttachment = useUIStore((s) => s.removeImageAttachment);
  const updateImageAttachment = useUIStore((s) => s.updateImageAttachment);
  const reorderImageAttachment = useUIStore((s) => s.reorderImageAttachment);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const isCharacterRef = section.mode === "char_ref";
  const usesAttachmentWeight =
    section.mode === "style_ref" ||
    section.mode === "image_prompt" ||
    section.mode === "char_ref";
  const weightMax = isCharacterRef ? 100 : 2;
  const weightStep = isCharacterRef ? 1 : 0.05;
  const weightLabel = isCharacterRef ? "CW" : "Weight";

  if (section.attachments.length > 0) {
    return (
      <>
        {section.attachments.map((attachment) => (
          <div
            key={attachment.id}
            draggable
            className={[
              "group/thumb relative shrink-0 overflow-hidden rounded-md border border-[var(--border-primary)] object-cover",
              draggedId === attachment.id ? "opacity-50" : "",
            ].join(" ")}
            style={{
              width: 64,
              height: isStyleRef || isCharacterRef ? 80 : 64,
            }}
            onClick={(e) => e.stopPropagation()}
            onDragStart={(e) => {
              e.stopPropagation();
              setDraggedId(attachment.id);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", attachment.id);
            }}
            onDragOver={(e) => {
              if (!draggedId || draggedId === attachment.id) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const id = e.dataTransfer.getData("text/plain") || draggedId;
              if (id && id !== attachment.id) {
                reorderImageAttachment(id, attachment.id);
              }
              setDraggedId(null);
            }}
            onDragEnd={() => setDraggedId(null)}
          >
            <img
              src={attachment.url}
              alt={attachment.filename ?? section.label}
              className="h-full w-full object-cover outline outline-1 -outline-offset-1 outline-black/10"
            />
            <button
              type="button"
              onClick={() => removeImageAttachment(attachment.id)}
              className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity duration-150 group-hover/thumb:opacity-100"
              title="Remove image"
            >
              <X className="h-2.5 w-2.5" />
            </button>
            {usesAttachmentWeight && (
              <div className="absolute bottom-0 left-0 right-0 bg-black/60 backdrop-blur-sm px-1 opacity-0 group-hover/thumb:opacity-100 transition-opacity">
                <input
                  type="range"
                  min={0}
                  max={weightMax}
                  step={weightStep}
                  value={attachment.weight}
                  onChange={(e) =>
                    updateImageAttachment(attachment.id, {
                      weight: parseFloat(e.target.value),
                    })
                  }
                  className="w-full h-1 accent-[var(--accent-primary)] cursor-pointer"
                  title={`${weightLabel}: ${attachment.weight.toFixed(
                    isCharacterRef ? 0 : 2,
                  )}`}
                />
                <div className="text-[9px] text-white text-center leading-none pb-0.5">
                  {isCharacterRef
                    ? `cw${attachment.weight.toFixed(0)}`
                    : attachment.weight.toFixed(2)}
                </div>
              </div>
            )}
          </div>
        ))}
      </>
    );
  }

  if (isStyleRef && srefItems.length > 0) {
    return (
      <>
        {srefItems.map((item, i) => (
          <SREFThumbnailItem key={i} item={item} index={i} />
        ))}
      </>
    );
  }

  // Empty columns stay empty: the whole column is the "add image" target
  // and its name/description live in the column's tooltip.
  return null;
}

function SREFThumbnailItem({
  item,
  index,
}: {
  item: SREFItem;
  index: number;
}) {
  const updateSREFItem = useStyleStore((s) => s.updateSREFItem);
  const removeSREFItem = useStyleStore((s) => s.removeSREFItem);
  const [editing, setEditing] = useState(false);
  const displayValue =
    item.type === "random"
      ? "random"
      : item.value.length > 6
        ? `${item.value.slice(0, 5)}…`
        : item.value;

  return (
    <div
      className="group/sref shrink-0 flex flex-col items-center"
      style={{ width: 64, height: 80 }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="relative w-16 h-12 font-medium flex items-center justify-center p-1.5 text-center text-xs text-[var(--text-secondary)] leading-tight tracking-wide rounded-t-md bg-[var(--bg-hover)] border border-[var(--accent-primary)]/40 border-b-0">
        {displayValue}
        <button
          type="button"
          onClick={() => removeSREFItem(index)}
          className="absolute right-0.5 top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity duration-150 group-hover/sref:opacity-100"
          title="Remove style ref"
        >
          <X className="h-2 w-2" />
        </button>
      </div>
      {/* Per-item weight: inline click-to-edit value + range slider */}
      <div className="w-16 rounded-b-md bg-[var(--bg-hover)] border border-[var(--accent-primary)]/40 border-t-0 overflow-hidden flex flex-col items-center">
        <button
          type="button"
          onClick={() => setEditing(!editing)}
          className="text-[10px] text-[var(--accent-primary)] hover:underline cursor-pointer leading-tight py-0.5"
          title="Click to toggle weight edit"
        >
          w{item.weight.toFixed(2)}
        </button>
        {editing && (
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={item.weight}
            onChange={(e) =>
              updateSREFItem(index, {
                weight: parseFloat(e.target.value),
              })
            }
            className="w-14 h-1 accent-[var(--accent-primary)] cursor-pointer mb-0.5"
          />
        )}
      </div>
    </div>
  );
}

function LockOpenIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

function LockClosedIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

export default PromptAttachmentSections;
