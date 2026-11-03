import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isTypingTarget } from "@/lib/ui/typingTarget";

const el = (
  tagName: string,
  extra: {
    type?: string;
    role?: string;
    editable?: boolean;
    inCombobox?: boolean;
  } = {},
) => ({
  tagName,
  type: extra.type,
  isContentEditable: !!extra.editable,
  getAttribute: (n: string) => (n === "role" ? (extra.role ?? null) : null),
  closest: () => (extra.inCombobox ? {} : null),
});

describe("isTypingTarget", () => {
  it.each([
    ["text input", el("INPUT", { type: "text" })],
    ["search input", el("INPUT", { type: "search" })],
    ["number input", el("INPUT", { type: "number" })],
    ["textarea", el("TEXTAREA")],
    ["select (model picker)", el("SELECT")],
    ["contenteditable", el("DIV", { editable: true })],
    ["ARIA combobox", el("BUTTON", { role: "combobox" })],
    ["option inside a listbox", el("LI", { inCombobox: true })],
  ])("treats a %s as typing", (_label, target) => {
    expect(isTypingTarget(target)).toBe(true);
  });

  it.each([
    ["button", el("BUTTON")],
    ["checkbox", el("INPUT", { type: "checkbox" })],
    ["range slider", el("INPUT", { type: "range" })],
    ["plain div", el("DIV")],
    ["null", null],
  ])("lets shortcuts through on a %s", (_label, target) => {
    expect(isTypingTarget(target)).toBe(false);
  });

  it("the shell's number-key shortcuts use it", () => {
    const page = readFileSync(path.join(process.cwd(), "src/app/page.tsx"), "utf8");
    expect(page).toContain("const isTyping = isTypingTarget(e.target);");
  });
});
