"use client";

import {
  useRef,
  useCallback,
  useEffect,
  KeyboardEvent,
  useMemo,
  useState,
} from "react";
import {
  useUIStore,
  useGenerationStore,
  useStyleStore,
  selectSREFString,
} from "@/store";
import { useDownloadStore } from "@/store/downloadStore";
import {
  Send,
  Loader2,
  X,
  Dice5,
  Sparkles,
  MoreHorizontal,
  Palette,
  ImageIcon,
  SlidersHorizontal,
  History,
  FileUp,
  Library,
  ListStart,
  Check,
  UserRound,
} from "lucide-react";
import { PromptAttachmentSections } from "@/components/PromptAttachmentSections";
import { MossLayoutEditor } from "@/components/MossLayoutEditor";
import { NevoMenu } from "@/components/nevo/NevoMenu";
import { useNevoStore } from "@/store/nevoStore";
import { usePromptPreviewStore } from "@/store/promptPreviewStore";
import { showToast } from "@/components/Toast";
import {
  PromptQueueTools,
  type PromptQueueToolsHandle,
} from "@/components/PromptQueueTools";
import { ConnectionStatusPill } from "@/components/ConnectionStatusPill";
import { ComfyLibraryPicker } from "@/components/ComfyLibraryPicker";
import { CharacterPicker } from "@/components/characters/CharacterPicker";
import { CharacterChips } from "@/components/characters/CharacterChips";
import { useCharacterLoraStore } from "@/store/characterLoraStore";
import { currentCharacterFamily } from "@/lib/characters/activeFamily";
import { STYLE_CODES_ENABLED } from "@/lib/features";
import { applyCharactersToPrompt } from "@/lib/characters/characterLoras";
import { useAnimaRefStore } from "@/store/animaRefStore";
import { submitAnimaRef } from "@/lib/characters/animaRefSubmit";
import {
  HISTORY_ROW_ACTION_CLASS,
  PROMPT_CARD_WIDTH_CLASS,
  PROMPT_CONTROLS_CLASS,
  PROMPT_OVERFLOW_LABEL_CLASS,
  PROMPT_OVERFLOW_TRIGGER_SIZE_CLASS,
  PROMPT_PILL_COUNT_CLASS,
  PROMPT_PILL_ICON_CLASS,
  PROMPT_PILL_LABEL_CLASS,
  PROMPT_PILL_SIZE_CLASS,
  PROMPT_ROW_CLASS,
} from "@/lib/ui/promptBarLayout";
import registry from "@/lib/oj/registry.json";
import { useIntegrations } from "@/hooks/useIntegrations";
import {
  applyPromptControl,
  buildPromptOverflowItems,
  formatControlCount,
  isPromptControlActive,
  overflowHasActiveMode,
  usePromptDrawerStore,
  type PromptControl,
  type PromptControlState,
  type PromptOverflowItemId,
} from "@/components/settings/promptControls";
import {
  buildSuggestions,
  getAutocompleteContext,
  type PromptSuggestion,
} from "@/lib/promptAutocomplete";
import {
  EXAMPLE_PROMPTS,
  HISTORY_RECALL_IDLE,
  normalizeSmartDashes,
  recallPromptHistory,
  type HistoryRecallState,
} from "@/lib/ui/promptKeys";
import { imageFilesToAttachments, pickImageFiles } from "@/lib/ui/imageDrop";

type SubmitResult = void | { ok?: boolean; error?: string };

interface PromptBarProps {
  onSubmit: (prompt: string) => Promise<SubmitResult>;
  isLoading?: boolean;
  isConnected?: boolean;
}

export function PromptBar({
  onSubmit,
  isLoading = false,
  isConnected = true,
}: PromptBarProps) {
  const promptValue = useUIStore((s) => s.promptValue);
  // Thumbnails-view hover preview of a run, shown only as the placeholder.
  const hoverPreview = usePromptPreviewStore((s) => s.preview);
  const setPromptValue = useUIStore((s) => s.setPromptValue);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const drawerTab = usePromptDrawerStore((s) => s.tab);
  const setDrawerTab = usePromptDrawerStore((s) => s.setTab);
  const toggleNevoMenu = useNevoStore((s) => s.toggleMenu);
  const nevoAvailable = useIntegrations().nevo;
  // A mode left on from a session with NEvo configured stays inert without it.
  const nevoEnabled = useNevoStore((s) => s.enabled) && nevoAvailable;
  const nevoRunning = useNevoStore((s) => s.running);
  const runNext = useUIStore((s) => s.runNext);
  const setRunNext = useUIStore((s) => s.setRunNext);
  const imageAttachmentCount = useUIStore((s) => s.imageAttachments.length);
  const srefCount = useStyleStore((s) => s.sref?.items.length ?? 0);
  const characterCount =
    useCharacterLoraStore((s) => s.selected.length) +
    (useAnimaRefStore((s) => s.reference) ? 1 : 0) +
    (useAnimaRefStore((s) => s.second) ? 1 : 0);
  const characterPickerOpen = useCharacterLoraStore((s) => s.pickerOpen);
  const setCharacterPickerOpen = useCharacterLoraStore((s) => s.setPickerOpen);
  const hasHistory = useGenerationStore(
    (s) => s.promptHistory.length > 0 || s.favoritePrompts.length > 0,
  );
  const attachmentSectionsExpanded = useUIStore(
    (s) => s.attachmentSectionsExpanded,
  );
  const setAttachmentSectionsExpanded = useUIStore(
    (s) => s.setAttachmentSectionsExpanded,
  );

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const queueToolsRef = useRef<PromptQueueToolsHandle>(null);
  // "…" overflow menu and the popovers it opens (all anchored under the
  // control group so they never render off the top of the viewport).
  const [menuOpen, setMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);

  const controlState: PromptControlState = {
    drawerOpen: settingsOpen,
    drawerTab,
    imagesOpen: attachmentSectionsExpanded,
  };

  const handleControl = (control: PromptControl) => {
    const next = applyPromptControl(controlState, control);
    if (next.drawerTab !== drawerTab) setDrawerTab(next.drawerTab);
    if (next.drawerOpen !== settingsOpen) setSettingsOpen(next.drawerOpen);
    if (next.imagesOpen !== attachmentSectionsExpanded) {
      setAttachmentSectionsExpanded(next.imagesOpen);
    }
  };

  const closeCharacterPicker = useCallback(
    () => setCharacterPickerOpen(false),
    [setCharacterPickerOpen],
  );

  const handleOverflow = (id: PromptOverflowItemId) => {
    setMenuOpen(false);
    switch (id) {
      case "history":
        setHistoryOpen(true);
        break;
      case "import":
        queueToolsRef.current?.openImport();
        break;
      case "library":
        setLibraryOpen(true);
        break;
      case "run-next":
        setRunNext(!runNext);
        break;
      case "nevo":
        toggleNevoMenu();
        break;
    }
  };

  const overflowItems = buildPromptOverflowItems({
    hasHistory,
    runNext,
    nevoEnabled,
    nevoAvailable,
  });
  const overflowDot = overflowHasActiveMode({ runNext, nevoEnabled });

  const submittingRef = useRef(false);
  // Up/Down arrow history recall (shell style); reset by typing or sending.
  const recallRef = useRef<HistoryRecallState>(HISTORY_RECALL_IDLE);
  // Empty-prompt placeholder cycles through example prompts while the bar
  // is idle. Starts on the plain line so server and client markup match.
  const [exampleIndex, setExampleIndex] = useState(0);
  const [inputFocused, setInputFocused] = useState(false);
  const promptEmpty = promptValue === "";
  useEffect(() => {
    if (!promptEmpty || inputFocused) return;
    // Phones: the examples don't fit one line, keep the plain placeholder.
    if (!window.matchMedia?.("(min-width: 640px)").matches) {
      setExampleIndex(0);
      return;
    }
    const id = window.setInterval(
      () => setExampleIndex((i) => (i + 1) % EXAMPLE_PROMPTS.length),
      5000,
    );
    return () => window.clearInterval(id);
  }, [promptEmpty, inputFocused]);
  const downloads = useDownloadStore((s) => s.downloads);
  const loraShortcodes = useStyleStore((s) => s.loraShortcodes);
  const [caretPosition, setCaretPosition] = useState(0);
  const [wildcardList, setWildcardList] = useState<
    { name: string; count?: number }[]
  >([]);
  const wildcardsFetched = useRef(false);
  const [highlightedSuggestion, setHighlightedSuggestion] = useState(0);
  const [autocompleteDismissedFor, setAutocompleteDismissedFor] = useState<
    string | null
  >(null);

  const autocompleteContext = useMemo(
    () => getAutocompleteContext(promptValue, caretPosition),
    [promptValue, caretPosition],
  );
  const wildcardContextActive = autocompleteContext?.type === "wildcard";
  useEffect(() => {
    if (!wildcardContextActive || wildcardsFetched.current) return;
    wildcardsFetched.current = true;
    fetch("/api/wildcards")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.ok && Array.isArray(d.wildcards)) setWildcardList(d.wildcards);
      })
      .catch(() => {
        wildcardsFetched.current = false;
      });
  }, [wildcardContextActive]);
  const autocompleteSuggestions = useMemo(() => {
    if (!autocompleteContext) return [];
    if (autocompleteDismissedFor === autocompleteContext.query) return [];

    return buildSuggestions({
      context: autocompleteContext,
      registry,
      downloads,
      loraShortcodes,
      wildcards: wildcardList,
    }).slice(0, 12);
  }, [
    autocompleteContext,
    autocompleteDismissedFor,
    downloads,
    loraShortcodes,
    wildcardList,
  ]);
  const autocompleteOpen = autocompleteSuggestions.length > 0;

  const updateCaretPosition = useCallback(() => {
    setCaretPosition(inputRef.current?.selectionStart ?? 0);
  }, []);

  const acceptSuggestion = useCallback(
    (suggestion: PromptSuggestion) => {
      if (!autocompleteContext) return;

      const nextValue =
        promptValue.slice(0, autocompleteContext.from) +
        suggestion.insertText +
        promptValue.slice(autocompleteContext.to);
      const nextCaret = autocompleteContext.from + suggestion.insertText.length;

      setPromptValue(nextValue);
      setCaretPosition(nextCaret);
      setHighlightedSuggestion(0);
      setAutocompleteDismissedFor(null);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [autocompleteContext, promptValue, setPromptValue],
  );

  // Dragging an image over the bar reveals the attachment drop zones
  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      const types = e.dataTransfer?.types ?? [];
      const hasImagePayload =
        types.includes("Files") || types.includes("text/uri-list");
      if (hasImagePayload) setAttachmentSectionsExpanded(true);
    },
    [setAttachmentSectionsExpanded],
  );

  // Pasting an image into the prompt adds it as an image prompt.
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const images = pickImageFiles(e.clipboardData?.files);
      if (images.length === 0) return;
      e.preventDefault();
      const { addImageAttachment } = useUIStore.getState();
      for (const attachment of imageFilesToAttachments(
        images,
        "image_prompt",
      )) {
        addImageAttachment(attachment);
      }
      setAttachmentSectionsExpanded(true);
    },
    [setAttachmentSectionsExpanded],
  );

  const handleSubmit = useCallback(async () => {
    if (!promptValue.trim() || isLoading || !isConnected) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      // Character picker "From a reference image (Anima)": the reference is
      // the character, the prompt is the scene; queued as the anima_ref
      // action (styles and character LoRAs don't apply to that graph). A
      // second reference makes it a two-character (left | right) render.
      const { reference: animaRef, second: animaRef2 } =
        useAnimaRefStore.getState();
      if (animaRef) {
        const gen = useGenerationStore.getState();
        const run = await submitAnimaRef({
          fetchImpl: fetch,
          image: animaRef,
          secondImage: animaRef2,
          input: promptValue,
          settings: useUIStore.getState().settings,
          clientId: gen.clientId,
        });
        gen.addRun(run);
        recallRef.current = HISTORY_RECALL_IDLE;
        setPromptValue("");
        inputRef.current?.focus();
        return;
      }
      const errorCount = useGenerationStore.getState().errors.length;
      const srefStr = selectSREFString(useStyleStore.getState());
      const fullPrompt = applyCharactersToPrompt(
        srefStr ? `${promptValue.trim()} ${srefStr}` : promptValue,
        useCharacterLoraStore.getState().selected,
        currentCharacterFamily(),
      );
      const result = await onSubmit(fullPrompt);
      const state = useGenerationStore.getState();
      const error =
        result && result.ok === false
          ? (result.error ?? "Prompt submission failed")
          : state.errors.length > errorCount
            ? (state.lastError ?? "Prompt submission failed")
            : null;
      if (error) {
        showToast(error, "error");
        return;
      }
      recallRef.current = HISTORY_RECALL_IDLE;
      setPromptValue("");
      inputRef.current?.focus();
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Prompt submission failed",
        "error",
      );
    } finally {
      submittingRef.current = false;
    }
  }, [promptValue, isLoading, isConnected, onSubmit, setPromptValue]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // IME composition (Japanese, Chinese…): Enter confirms the candidate.
      if (e.nativeEvent.isComposing) return;

      // Cmd/Ctrl+Enter always sends, even with suggestions open.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSubmit();
        return;
      }

      if (autocompleteOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHighlightedSuggestion(
            (index) => (index + 1) % autocompleteSuggestions.length,
          );
          return;
        }

        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHighlightedSuggestion(
            (index) =>
              (index - 1 + autocompleteSuggestions.length) %
              autocompleteSuggestions.length,
          );
          return;
        }

        if (e.key === "Tab" || e.key === "Enter") {
          e.preventDefault();
          acceptSuggestion(
            autocompleteSuggestions[
              Math.min(
                highlightedSuggestion,
                autocompleteSuggestions.length - 1,
              )
            ],
          );
          return;
        }

        if (e.key === "Escape") {
          e.preventDefault();
          if (autocompleteContext) {
            setAutocompleteDismissedFor(autocompleteContext.query);
          }
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSubmit();
        return;
      }

      if (
        (e.key === "ArrowUp" || e.key === "ArrowDown") &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        !e.ctrlKey
      ) {
        const textarea = e.currentTarget;
        if (textarea.selectionStart !== textarea.selectionEnd) return;
        const recalled = recallPromptHistory({
          direction: e.key === "ArrowUp" ? "up" : "down",
          history: useGenerationStore.getState().promptHistory,
          state: recallRef.current,
          value: promptValue,
          caret: textarea.selectionStart,
        });
        if (!recalled) return;
        e.preventDefault();
        recallRef.current = recalled.state;
        setPromptValue(recalled.value);
        const end = recalled.value.length;
        setCaretPosition(end);
        requestAnimationFrame(() =>
          inputRef.current?.setSelectionRange(end, end),
        );
      }
    },
    [
      acceptSuggestion,
      autocompleteContext,
      autocompleteOpen,
      autocompleteSuggestions,
      handleSubmit,
      highlightedSuggestion,
      promptValue,
      setPromptValue,
    ],
  );

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      recallRef.current = HISTORY_RECALL_IDLE;
      const { value, caret } = normalizeSmartDashes(
        e.target.value,
        e.target.selectionStart,
      );
      if (value !== e.target.value) {
        const textarea = e.target;
        requestAnimationFrame(() => textarea.setSelectionRange(caret, caret));
      }
      setPromptValue(value);
      setCaretPosition(caret);
      setHighlightedSuggestion(0);
      setAutocompleteDismissedFor(null);
      const textarea = e.target;
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 192)}px`;
    },
    [setPromptValue],
  );

  // Keep height in sync when the value changes programmatically (submit
  // clear, history pick, "Use text" from gallery/lightbox, persisted prompt).
  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 192)}px`;
  }, [promptValue]);

  return (
    <div className="w-full flex flex-col relative">
      {/* Card + control row: from sm up the Styles | Images | Settings pills
          and "…" sit beside the card on the same row; on phones they get
          their own row under it. */}
      <div className={PROMPT_ROW_CLASS}>
      <div
        data-prompt-card=""
        className={`glass-surface flex ${PROMPT_CARD_WIDTH_CLASS} shrink-0 rounded-xl flex-col relative border border-[var(--border-primary)] bg-[var(--bg-secondary)] shadow-[0px_7px_21px_0px_rgba(0,0,0,0.25)] transition-colors duration-150 focus-within:border-[var(--border-accent)]`}
        onDragEnter={handleDragEnter}
      >
        {/* Input row anchors the suggestions, which drop down under the
            text (the bar sits at the top of the page). */}
        <div className="relative flex w-full flex-wrap items-start gap-y-2 py-3.5 px-3">
          <PromptAutocompletePopover
            suggestions={autocompleteSuggestions}
            highlightedIndex={highlightedSuggestion}
            onSelect={acceptSuggestion}
          />
          <textarea
            id="desktop_input_bar"
            ref={inputRef}
            aria-label="Prompt"
            aria-autocomplete="list"
            aria-expanded={autocompleteOpen}
            aria-controls="cj-prompt-autocomplete"
            aria-activedescendant={
              autocompleteOpen
                ? `cj-prompt-suggestion-${Math.min(highlightedSuggestion, autocompleteSuggestions.length - 1)}`
                : undefined
            }
            value={promptValue}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onClick={updateCaretPosition}
            onKeyUp={updateCaretPosition}
            onSelect={updateCaretPosition}
            onPaste={handlePaste}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            placeholder={hoverPreview ?? EXAMPLE_PROMPTS[exampleIndex]}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            enterKeyHint="send"
            className="order-1 flex-1 min-w-0 ml-1 bg-transparent outline-none focus-visible:outline-none text-[var(--text-primary)] placeholder:text-[var(--text-primary)]/[0.36] placeholder:truncate overflow-hidden resize-none"
            rows={1}
            maxLength={10000}
            disabled={isLoading}
            style={{
              resize: "none",
              minHeight: "24px",
              maxHeight: "192px",
            }}
          />

          {/* Send — always inline with the textarea */}
          <div className="order-2 sm:order-3 flex items-center ml-2 shrink-0">
            <button
              onClick={handleSubmit}
              disabled={!promptValue.trim() || isLoading || !isConnected}
              className="flex size-10 sm:size-8 items-center justify-center rounded-lg bg-[var(--accent-primary)] text-white transition-[background-color,opacity,transform] duration-150 hover:bg-[var(--accent-primary)]/80 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
              title={
                isConnected
                  ? "Send (Enter) · Shift+Enter for a new line"
                  : "ComfyUI offline"
              }
              aria-label={isLoading ? "Generating..." : "Send prompt"}
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>

        {/* SREF inline pills — between textarea and attachment sections */}
        <SREFInlineRow />
        <CharacterChips />

        {/* Attachment sections — three-column layout, toggled by the
            Images pill (and auto-expanded when an image is dragged over) */}
        <PromptAttachmentSections />
        <MossLayoutEditor />
      </div>

      {/* Control group — icon-only Styles | Images | Settings pills (names pop
          in under each icon on hover/focus) plus a
          "…" overflow for workflow tools. Outside the card: to its right
          (centred on the card's first line) from sm up, its own row under
          the card on phones. */}
      <div data-prompt-controls="" className={PROMPT_CONTROLS_CLASS}>
        <div
          role="group"
          aria-label="Prompt controls"
          className="flex min-w-0 items-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-0.5"
        >
          <ControlPill
            label="Styles"
            icon={Palette}
            count={formatControlCount(srefCount)}
            active={isPromptControlActive(controlState, "styles")}
            onClick={() => handleControl("styles")}
          />
          <ControlPill
            id="cj-character-pill"
            label="Character"
            icon={UserRound}
            count={formatControlCount(characterCount)}
            active={characterPickerOpen}
            onClick={() => setCharacterPickerOpen(!characterPickerOpen)}
            ariaExpanded={characterPickerOpen}
          />
          <ControlPill
            label="Images"
            icon={ImageIcon}
            count={formatControlCount(imageAttachmentCount)}
            active={isPromptControlActive(controlState, "images")}
            onClick={() => handleControl("images")}
            ariaExpanded={attachmentSectionsExpanded}
          />
          <ControlPill
            label="Settings"
            icon={SlidersHorizontal}
            active={isPromptControlActive(controlState, "settings")}
            onClick={() => handleControl("settings")}
          />
        </div>

        <div className="relative">
          <PromptOverflowMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            items={overflowItems}
            onSelect={handleOverflow}
            showDot={overflowDot}
            busy={nevoRunning}
          />
          <PromptHistoryDropdown
            open={historyOpen}
            onOpenChange={setHistoryOpen}
            onSelect={(prompt) => {
              recallRef.current = HISTORY_RECALL_IDLE;
              setPromptValue(prompt);
              inputRef.current?.focus();
            }}
          />
          <ComfyLibraryPicker
            hideTrigger
            open={libraryOpen}
            onOpenChange={setLibraryOpen}
          />
          <PromptQueueTools ref={queueToolsRef} />
          <CharacterPicker
            open={characterPickerOpen}
            onClose={closeCharacterPicker}
            triggerId="cj-character-pill"
          />
        </div>
      </div>
      </div>

      {/* Connection indicator — calm compact pill, mobile only (desktop shows
          status in the sidebar footer); hidden while connected */}
      <div role="status" aria-live="polite">
        <ConnectionStatusPill isConnected={isConnected} />
      </div>

      {/* Character counter — only when nearing limit */}
      {promptValue.length > 500 && (
        <div
          className={`text-xs mt-1 ${promptValue.length > 2000 ? "text-[var(--error)]" : promptValue.length > 1000 ? "text-[var(--warning)]" : "text-[var(--text-muted)]"}`}
        >
          {promptValue.length.toLocaleString()} / 10,000
        </div>
      )}

      {/* NEvo dropdown — expands downward from the NEvo button */}
      {nevoAvailable && <NevoMenu />}
    </div>
  );
}

function SREFInlineRow() {
  const sref = useStyleStore((s) => s.sref);
  const addRandomSREF = useStyleStore((s) => s.addRandomSREF);
  const clearSREF = useStyleStore((s) => s.clearSREF);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const setDrawerTab = usePromptDrawerStore((s) => s.setTab);

  const items = sref?.items ?? [];
  const hasItems = items.length > 0;
  const isRandomOnly =
    items.length === 1 &&
    items[0].type === "random" &&
    items[0].value === "random";

  const handleRandom = useCallback(() => {
    if (isRandomOnly) {
      clearSREF();
    } else {
      clearSREF();
      setTimeout(() => addRandomSREF(), 0);
    }
  }, [isRandomOnly, clearSREF, addRandomSREF]);

  const pillLabel = hasItems
    ? !STYLE_CODES_ENABLED
      ? `style ×${items.length}`
      : isRandomOnly
        ? "sref random"
        : `sref ×${items.length}`
    : null;

  if (!pillLabel) return null;

  return (
    <div className="flex items-center gap-1.5 px-3 pb-2">
      <button
        type="button"
        onClick={() => {
          setDrawerTab("styles");
          setSettingsOpen(true);
        }}
        title="Edit style references"
        className="flex h-[24px] items-center gap-1 rounded-full border border-[var(--accent-primary)]/50 bg-[var(--accent-primary)]/10 px-2 text-xs font-medium text-[var(--accent-primary)]"
      >
        <span>{pillLabel}</span>
      </button>
      {STYLE_CODES_ENABLED && (
        <button
          type="button"
          onClick={handleRandom}
          className={`flex h-[24px] items-center gap-1 rounded-full border px-2 text-xs transition-colors ${
            isRandomOnly
              ? "border-[var(--accent-primary)]/50 bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]"
              : "border-[var(--border-primary)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          }`}
        >
          <Dice5 className="h-3 w-3" />
          <span>random</span>
        </button>
      )}
      {hasItems && (
        <button
          type="button"
          onClick={clearSREF}
          className="flex size-6 items-center justify-center rounded-full text-[var(--text-muted)] hover:text-[var(--error)]"
          title="Clear style refs"
          aria-label="Clear style refs"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

interface PromptAutocompletePopoverProps {
  suggestions: PromptSuggestion[];
  highlightedIndex: number;
  onSelect: (suggestion: PromptSuggestion) => void;
}

function PromptAutocompletePopover({
  suggestions,
  highlightedIndex,
  onSelect,
}: PromptAutocompletePopoverProps) {
  if (suggestions.length === 0) return null;
  const activeIndex = Math.min(highlightedIndex, suggestions.length - 1);

  return (
    <div
      id="cj-prompt-autocomplete"
      role="listbox"
      aria-label="Prompt suggestions"
      className="absolute top-full left-0 mt-2 w-full max-h-72 overflow-y-auto rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] shadow-xl z-50 p-1"
    >
      {suggestions.map((suggestion, index) => {
        const isHighlighted = index === activeIndex;
        return (
          <button
            key={suggestion.id}
            id={`cj-prompt-suggestion-${index}`}
            type="button"
            role="option"
            aria-selected={isHighlighted}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(suggestion);
            }}
            className={`flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
              isHighlighted
                ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            }`}
          >
            <span className="min-w-20 font-mono text-sm text-[var(--accent-primary)]">
              {suggestion.label}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs">
                {suggestion.description}
              </span>
              <span className="block truncate text-[10px] text-[var(--text-muted)]">
                {suggestion.type === "param"
                  ? suggestion.valueHint
                  : suggestion.type === "wildcard"
                    ? "wildcard"
                    : suggestion.type === "lora"
                      ? "LoRA name"
                      : `LoRA: ${suggestion.loraName}`}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

interface ControlPillProps {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  onClick: () => void;
  count?: string | null;
  ariaExpanded?: boolean;
  id?: string;
}

/** One segment of the Styles | Images | Settings control group. */
function ControlPill({
  label,
  icon: Icon,
  active,
  onClick,
  count,
  ariaExpanded,
  id,
}: ControlPillProps) {
  return (
    <button
      id={id}
      type="button"
      onClick={onClick}
      aria-label={count ? `${label} (${count})` : label}
      aria-pressed={active}
      aria-expanded={ariaExpanded}
      className={`flex ${PROMPT_PILL_SIZE_CLASS} items-center rounded-md transition-[background-color,color,transform] duration-150 active:scale-[0.97] ${
        active
          ? "bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm"
          : "text-[var(--text-muted)] hover:bg-[var(--bg-secondary)]/60 hover:text-[var(--text-primary)]"
      }`}
    >
      <Icon
        className={`${PROMPT_PILL_ICON_CLASS} ${active ? "text-[var(--accent-primary)]" : ""}`}
      />
      {count && <span className={PROMPT_PILL_COUNT_CLASS}>{count}</span>}
      <span className={PROMPT_PILL_LABEL_CLASS} aria-hidden="true">
        {label}
      </span>
    </button>
  );
}

const OVERFLOW_ICONS: Record<
  PromptOverflowItemId,
  React.ComponentType<{ className?: string }>
> = {
  history: History,
  import: FileUp,
  library: Library,
  "run-next": ListStart,
  nevo: Sparkles,
};

interface PromptOverflowMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ReturnType<typeof buildPromptOverflowItems>;
  onSelect: (id: PromptOverflowItemId) => void;
  showDot: boolean;
  busy: boolean;
}

/** "…" menu holding the workflow tools, each with a label and a hint. */
function PromptOverflowMenu({
  open,
  onOpenChange,
  items,
  onSelect,
  showDot,
  busy,
}: PromptOverflowMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const focusItem = (delta: number | "first" | "last") => {
    const nodes = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role^="menuitem"]',
      ) ?? [],
    );
    if (nodes.length === 0) return;
    const current = nodes.indexOf(document.activeElement as HTMLButtonElement);
    const index =
      delta === "first"
        ? 0
        : delta === "last"
          ? nodes.length - 1
          : (current + delta + nodes.length) % nodes.length;
    nodes[index]?.focus();
  };

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>('[role^="menuitem"]')
        ?.focus();
    });
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onOpenChange]);

  const close = (restoreFocus: boolean) => {
    onOpenChange(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  return (
    <div ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => onOpenChange(!open)}
        className={`group relative flex ${PROMPT_OVERFLOW_TRIGGER_SIZE_CLASS} items-center justify-center rounded-lg transition-colors ${
          open
            ? "bg-[var(--bg-hover)] text-[var(--text-primary)]"
            : "text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        }`}
        aria-label="More prompt tools"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="cj-prompt-tools"
      >
        {busy ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <MoreHorizontal className="w-4 h-4" />
        )}
        {showDot && !busy && (
          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--accent-primary)]" />
        )}
        {!open && (
          <span className={PROMPT_OVERFLOW_LABEL_CLASS} aria-hidden="true">
            More tools
          </span>
        )}
      </button>
      {open && (
        <div
          ref={menuRef}
          id="cj-prompt-tools"
          role="menu"
          aria-label="Prompt tools"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              focusItem(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              focusItem(-1);
            } else if (e.key === "Home") {
              e.preventDefault();
              focusItem("first");
            } else if (e.key === "End") {
              e.preventDefault();
              focusItem("last");
            } else if (e.key === "Escape") {
              // Keep the page-level Escape (closes the settings drawer) out.
              e.preventDefault();
              e.stopPropagation();
              close(true);
            } else if (e.key === "Tab") {
              close(false);
            }
          }}
          className="absolute right-0 top-full z-50 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-1 shadow-xl animate-fade-in"
        >
          {items.map((item) => {
            const Icon = OVERFLOW_ICONS[item.id];
            const isToggle = item.checked !== undefined;
            return (
              <button
                key={item.id}
                type="button"
                role={isToggle ? "menuitemcheckbox" : "menuitem"}
                aria-checked={isToggle ? item.checked : undefined}
                data-nevo-button={item.id === "nevo" ? "" : undefined}
                onClick={() => onSelect(item.id)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]"
              >
                <Icon
                  className={`h-4 w-4 shrink-0 ${item.checked || item.active ? "text-[var(--accent-primary)]" : "text-[var(--text-muted)]"}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-[var(--text-primary)]">
                    {item.label}
                  </span>
                  <span className="block truncate text-[11px] text-[var(--text-muted)]">
                    {item.hint}
                  </span>
                </span>
                {item.checked && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-[var(--accent-primary)]" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default PromptBar;

interface PromptHistoryDropdownProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (prompt: string) => void;
}

/** Recent + favorite prompts. Opened from the "…" menu; drops downward. */
function PromptHistoryDropdown({
  open: isOpen,
  onOpenChange: setIsOpen,
  onSelect,
}: PromptHistoryDropdownProps) {
  const promptValue = useUIStore((s) => s.promptValue);
  const promptHistory = useGenerationStore((s) => s.promptHistory);
  const favoritePrompts = useGenerationStore((s) => s.favoritePrompts);
  const clearPromptHistory = useGenerationStore((s) => s.clearPromptHistory);
  const addFavoritePrompt = useGenerationStore((s) => s.addFavoritePrompt);
  const removeFavoritePrompt = useGenerationStore(
    (s) => s.removeFavoritePrompt,
  );

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, setIsOpen]);

  const hasContent = promptHistory.length > 0 || favoritePrompts.length > 0;
  if (!hasContent) return null;

  return (
    <>
      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />

          <div
            role="dialog"
            aria-label="Prompt history and favorites"
            className="absolute top-full right-0 mt-2 w-[min(24rem,calc(100vw-2rem))] max-h-80 overflow-y-auto bg-[var(--bg-secondary)] border border-[var(--border-primary)] rounded-lg shadow-xl z-50"
          >
            {favoritePrompts.length > 0 && (
              <div className="border-b border-[var(--border-primary)]">
                <div className="flex items-center justify-between px-3 py-2 bg-[var(--bg-tertiary)]">
                  <span className="text-xs font-medium text-[var(--accent-primary)]">
                    Favorites
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    {favoritePrompts.length}
                  </span>
                </div>
                <div className="divide-y divide-[var(--border-primary)]">
                  {favoritePrompts.map((fav) => (
                    <div
                      key={fav.id}
                      className="flex items-center gap-2 px-3 py-2 hover:bg-[var(--bg-hover)] group"
                    >
                      <button
                        onClick={() => {
                          onSelect(fav.prompt);
                          setIsOpen(false);
                        }}
                        className="flex-1 text-left"
                      >
                        {fav.name && (
                          <p className="text-xs font-medium text-[var(--text-primary)]">
                            {fav.name}
                          </p>
                        )}
                        <p className="text-xs text-[var(--text-secondary)] line-clamp-2">
                          {fav.prompt}
                        </p>
                      </button>
                      <button
                        onClick={() => removeFavoritePrompt(fav.id)}
                        className={`${HISTORY_ROW_ACTION_CLASS} hover:text-[var(--error)]`}
                        title="Remove favorite"
                        aria-label="Remove favorite"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between px-3 py-2 bg-[var(--bg-tertiary)]">
                <span className="text-xs font-medium text-[var(--text-secondary)]">
                  Recent
                </span>
                <div className="flex items-center gap-2">
                  {promptValue && (
                    <button
                      onClick={() => addFavoritePrompt(promptValue)}
                      className="text-xs text-[var(--accent-primary)] hover:underline"
                      title="Save current prompt"
                    >
                      Save
                    </button>
                  )}
                  <button
                    onClick={() => {
                      clearPromptHistory();
                      setIsOpen(false);
                    }}
                    className="text-xs text-[var(--text-muted)] hover:text-[var(--error)]"
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="divide-y divide-[var(--border-primary)]">
                {promptHistory.slice(0, 20).map((prompt) => (
                  <div
                    key={prompt}
                    className="flex items-center gap-2 px-3 py-2 hover:bg-[var(--bg-hover)] group"
                  >
                    <button
                      onClick={() => {
                        onSelect(prompt);
                        setIsOpen(false);
                      }}
                      className="flex-1 text-left"
                    >
                      <p className="text-xs text-[var(--text-primary)] line-clamp-2">
                        {prompt}
                      </p>
                    </button>
                    <button
                      onClick={() => addFavoritePrompt(prompt)}
                      className={`${HISTORY_ROW_ACTION_CLASS} hover:text-[var(--accent-primary)]`}
                      title="Save as favorite"
                      aria-label="Save as favorite"
                    >
                      <svg
                        className="w-3 h-3"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
