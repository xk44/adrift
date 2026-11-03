/**
 * Prompt bar layout + copy checks.
 *
 * Rendered to static markup (no DOM library in devDeps): the Styles | Images
 * | Settings pills and the "…" menu must sit OUTSIDE the glass card, every
 * button needs an accessible name, and the prose under the bar stays short.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PromptBar } from "@/components/PromptBar";
import { PromptAttachmentSections } from "@/components/PromptAttachmentSections";
import {
  HISTORY_ROW_ACTION_CLASS,
  PROMPT_CONTROLS_CLASS,
  PROMPT_OVERFLOW_TRIGGER_SIZE_CLASS,
  PROMPT_PILL_ICON_CLASS,
  PROMPT_PILL_LABEL_CLASS,
  PROMPT_PILL_SIZE_CLASS,
  PROMPT_ROW_CLASS,
} from "@/lib/ui/promptBarLayout";

/** Index just past the `</div>` that closes the div opened at `start`. */
function closingDivEnd(html: string, start: number): number {
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = start;
  let depth = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  throw new Error("unbalanced div");
}

function openingDivIndex(html: string, marker: string): number {
  const at = html.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  return html.lastIndexOf("<div", at);
}

function renderBar() {
  return renderToStaticMarkup(
    createElement(PromptBar, {
      onSubmit: async () => undefined,
      isConnected: true,
    }),
  );
}

describe("prompt bar layout", () => {
  it("renders the control pills and the … menu outside the glass card", () => {
    const html = renderBar();
    const cardStart = openingDivIndex(html, 'data-prompt-card=""');
    const cardEnd = closingDivEnd(html, cardStart);
    const card = html.slice(cardStart, cardEnd);

    expect(card).toContain('id="desktop_input_bar"');
    expect(card).toContain('aria-label="Send prompt"');
    expect(card).not.toContain('aria-label="Prompt controls"');
    expect(card).not.toContain('aria-label="More prompt tools"');

    const controlsAt = html.indexOf('data-prompt-controls=""');
    expect(controlsAt).toBeGreaterThan(cardEnd);
    const controls = html.slice(
      openingDivIndex(html, 'data-prompt-controls=""'),
    );
    expect(controls).toContain('aria-label="Prompt controls"');
    expect(controls).toContain('aria-label="More prompt tools"');
    for (const label of ["Styles", "Character", "Images", "Settings"]) {
      expect(controls).toContain(
        `<span class="${PROMPT_PILL_LABEL_CLASS}" aria-hidden="true">${label}</span>`,
      );
      // Named even when the label is hidden by the compact container query.
      expect(controls).toContain(`aria-label="${label}"`);
    }
  });

  it("puts card and controls side by side from sm up, stacked on phones", () => {
    expect(PROMPT_ROW_CLASS).toMatch(/(^| )flex-col( |$)/);
    expect(PROMPT_ROW_CLASS).toContain("sm:flex-row");
    expect(PROMPT_ROW_CLASS).toContain("sm:items-start");
    // Phones: the pill row wraps rather than overflowing at 320 px.
    expect(PROMPT_CONTROLS_CLASS).toMatch(/(^| )flex-wrap( |$)/);
    expect(PROMPT_CONTROLS_CLASS).toContain("sm:flex-nowrap");
    expect(PROMPT_CONTROLS_CLASS).toContain("sm:shrink-0");
    // No in-card divider any more.
    expect(PROMPT_CONTROLS_CLASS).not.toContain("border-t");

    const html = renderBar();
    expect(html).toContain(PROMPT_ROW_CLASS);
    expect(html).toMatch(/data-prompt-card=""[^>]*class="[^"]*min-w-0 flex-1/);
  });

  it("pills are icon-only; names pop in under the icon on hover/focus", () => {
    expect(PROMPT_ROW_CLASS).toMatch(/(^| )cj-prompt-row( |$)/);
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    expect(css).toMatch(/\.cj-prompt-row\s*\{\s*container: cj-prompt-row \/ inline-size;/);
    // No container query hides the label any more: it is a hover label.
    expect(css).not.toMatch(/\.cj-prompt-pill-label\s*\{\s*display: none;/);
    expect(PROMPT_PILL_LABEL_CLASS).toMatch(/(^| )absolute( |$)/);
    expect(PROMPT_PILL_LABEL_CLASS).toMatch(/(^| )top-full( |$)/);
    expect(PROMPT_PILL_LABEL_CLASS).toMatch(/(^| )opacity-0( |$)/);
    expect(PROMPT_PILL_LABEL_CLASS).toContain(
      "[@media(hover:hover)]:group-hover:opacity-100",
    );
    expect(PROMPT_PILL_LABEL_CLASS).toContain("group-focus-visible:opacity-100");
    expect(PROMPT_PILL_SIZE_CLASS).toMatch(/(^| )group( |$)/);
    expect(PROMPT_PILL_SIZE_CLASS).toMatch(/(^| )relative( |$)/);
  });

  it("drops suggestions down under the input (the bar is at the page top)", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/PromptBar.tsx"),
      "utf8",
    );
    expect(src).toContain('id="cj-prompt-autocomplete"');
    expect(src).toContain("absolute top-full left-0 mt-2");
    expect(src).not.toContain("absolute bottom-full left-0 mb-2");
  });

  it("textarea is tuned for prompts: no autocorrect, send key, quiet focus", () => {
    const html = renderBar();
    const textarea = html.match(/<textarea[^>]*>/)?.[0] ?? "";
    expect(textarea).toContain('autoCorrect="off"');
    expect(textarea).toContain('autoCapitalize="off"');
    expect(textarea).toContain('enterKeyHint="send"');
    expect(textarea).toContain('placeholder="What will you imagine?"');
    expect(textarea).toContain("focus-visible:outline-none");
    expect(html).toMatch(/data-prompt-card=""[^>]*focus-within:border-/);
    expect(html).toContain("Shift+Enter for a new line");
  });

  it("wires the keyboard: Cmd/Ctrl+Enter, IME-safe Enter, ↑/↓ history", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/PromptBar.tsx"),
      "utf8",
    );
    expect(src).toContain("e.nativeEvent.isComposing");
    expect(src).toContain('e.key === "Enter" && (e.metaKey || e.ctrlKey)');
    // Cmd/Ctrl+Enter is checked before the suggestion list claims Enter.
    expect(src.indexOf("(e.metaKey || e.ctrlKey)")).toBeLessThan(
      src.indexOf("if (autocompleteOpen) {"),
    );
    expect(src).toContain("recallPromptHistory({");
    expect(src).toContain("normalizeSmartDashes(");
    expect(src).toContain("onPaste={handlePaste}");
  });

  it("attachment columns accept dropped image files in their own mode", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/PromptAttachmentSections.tsx"),
      "utf8",
    );
    expect(src).toContain("dragHasFiles(e.dataTransfer?.types)");
    expect(src).toMatch(
      /imageFilesToAttachments\(\s*pickImageFiles\(e\.dataTransfer\.files\),\s*section\.mode,/,
    );
  });

  it("keeps touch targets at 40 px on phones", () => {
    // Square 40 px icon targets on phones, 32 px from sm up.
    expect(PROMPT_PILL_SIZE_CLASS).toMatch(/(^| )size-10( |$)/);
    expect(PROMPT_PILL_SIZE_CLASS).toMatch(/(^| )sm:size-8( |$)/);
    // Icons always shown: the pills carry no static text.
    expect(PROMPT_PILL_ICON_CLASS).not.toMatch(/(^| )hidden( |$)/);
    expect(PROMPT_OVERFLOW_TRIGGER_SIZE_CLASS).toMatch(/(^| )size-10( |$)/);
    const html = renderBar();
    expect(html).toContain("size-10 sm:size-8"); // send button
    expect(html.split(PROMPT_PILL_SIZE_CLASS).length - 1).toBe(4);
    expect(html.split(PROMPT_PILL_ICON_CLASS).length - 1).toBe(4);
  });

  it("gives every control an accessible name", () => {
    const html = renderBar();
    expect(html).toMatch(/<textarea[^>]*aria-label="Prompt"/);
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(3);
    for (const button of buttons) {
      const open = button.slice(0, button.indexOf(">") + 1);
      const text = button.replace(/<[^>]+>/g, "").trim();
      const named =
        /aria-label="[^"]+"/.test(open) ||
        /title="[^"]+"/.test(open) ||
        text.length > 0;
      expect(named, open).toBe(true);
    }
  });

  it("history row actions stay visible on touch, hover-reveal from md", () => {
    expect(HISTORY_ROW_ACTION_CLASS).toContain("md:opacity-0");
    expect(HISTORY_ROW_ACTION_CLASS).toContain("md:group-hover:opacity-100");
    expect(HISTORY_ROW_ACTION_CLASS).toContain("focus-visible:opacity-100");
    expect(HISTORY_ROW_ACTION_CLASS).not.toMatch(/(^| )opacity-0/);
  });
});

describe("prose under the prompt bar", () => {
  it("attachment columns keep descriptions in tooltips, not on screen", () => {
    const html = renderToStaticMarkup(createElement(PromptAttachmentSections));
    for (const description of [
      "Animate an image",
      "Use the elements of an image",
      "Use the style of an image",
      "Use a character likeness",
      "Structure, pose, depth map",
    ]) {
      expect(html).toMatch(new RegExp(`title="[^"]+: ${description}"`));
      // Only in attributes, never as visible text.
      expect(html).not.toContain(`>${description}<`);
    }
    expect(html).toContain('aria-label="Clear image prompts"');
    // No misleading "Select images below" filler in the empty style column.
    expect(html).not.toMatch(/>\s*below\s*</);
  });

  it("section labels wrap to two lines instead of truncating (C16)", () => {
    const html = renderToStaticMarkup(createElement(PromptAttachmentSections));
    const labels = Array.from(
      html.matchAll(
        /<div class="([^"]*)" data-testid="attachment-section-label">([^<]*)</g,
      ),
    );
    expect(labels.map((m) => m[2])).toContain("Character References");
    for (const [, cls] of labels) {
      expect(cls).toContain("line-clamp-2");
      expect(cls).not.toContain("truncate");
      expect(cls).not.toContain("whitespace-nowrap");
    }
  });
});

describe("Create header grid", () => {
  const page = readFileSync(join(process.cwd(), "src/app/page.tsx"), "utf8");

  it("gutters never take min-content width from the prompt column", () => {
    expect(page).toContain(
      "grid-cols-[minmax(0,1fr)_minmax(0,1600px)_minmax(0,1fr)]",
    );
    expect(page).not.toContain('"grid-cols-[1fr_minmax(0,1600px)_1fr]"');
    // Column gaps only once the gutters actually have room.
    expect(page).toContain("gap-x-0 min-[1900px]:gap-x-4");
  });

  it("uses a 16 px side gutter on phones", () => {
    expect(page).toContain("className={`flex-shrink-0 px-4 sm:px-6 pt-4 pb-2");
  });
});
