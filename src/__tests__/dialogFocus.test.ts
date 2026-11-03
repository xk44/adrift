import { describe, it, expect, beforeEach } from "vitest";
import {
  activateDialogFocus,
  activeDialogCount,
  getFocusable,
  nextTrapTarget,
  type DocumentLike,
  type FocusableLike,
  type KeyEventLike,
} from "@/lib/ui/dialogFocus";

// Minimal fake DOM: elements know their parent, focus() sets doc.activeElement.
class FakeDoc implements DocumentLike {
  activeElement: unknown = null;
  listeners: Array<(e: KeyEventLike) => void> = [];
  addEventListener(_t: "keydown", fn: (e: KeyEventLike) => void) {
    this.listeners.push(fn);
  }
  removeEventListener(_t: "keydown", fn: (e: KeyEventLike) => void) {
    this.listeners = this.listeners.filter((f) => f !== fn);
  }
  key(key: string, shiftKey = false) {
    const e = {
      key,
      shiftKey,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    for (const fn of [...this.listeners]) fn(e);
    return e;
  }
}

class FakeEl implements FocusableLike {
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  visible = true;
  isConnected = true;
  constructor(
    public doc: FakeDoc,
    public tagName = "DIV",
    attrs: Record<string, string> = {},
  ) {
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
  }
  add(child: FakeEl) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  focus() {
    this.doc.activeElement = this;
  }
  contains(other: unknown): boolean {
    let n = other as FakeEl | null;
    while (n) {
      if (n === this) return true;
      n = n.parent;
    }
    return false;
  }
  getAttribute(n: string) {
    return this.attrs.get(n) ?? null;
  }
  setAttribute(n: string, v: string) {
    this.attrs.set(n, v);
  }
  removeAttribute(n: string) {
    this.attrs.delete(n);
  }
  hasAttribute(n: string) {
    return this.attrs.has(n);
  }
  getClientRects() {
    return { length: this.visible ? 1 : 0 };
  }
  // Treat every BUTTON/INPUT descendant as matching the selector; the
  // disabled/hidden filtering under test lives in getFocusable itself.
  querySelectorAll(): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (n: FakeEl) => {
      for (const c of n.children) {
        if (c.tagName === "BUTTON" || c.tagName === "INPUT") out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

function setup() {
  const doc = new FakeDoc();
  const opener = new FakeEl(doc, "BUTTON");
  const dialog = new FakeEl(doc);
  const a = dialog.add(new FakeEl(doc, "BUTTON"));
  const b = dialog.add(new FakeEl(doc, "INPUT"));
  const c = dialog.add(new FakeEl(doc, "BUTTON"));
  opener.focus();
  return { doc, opener, dialog, a, b, c };
}

describe("dialogFocus", () => {
  beforeEach(() => {
    expect(activeDialogCount()).toBe(0);
  });

  it("skips disabled, aria-hidden and invisible elements", () => {
    const { dialog, a, b, c } = setup();
    a.setAttribute("disabled", "");
    b.visible = false;
    expect(getFocusable(dialog)).toEqual([c]);
    c.setAttribute("aria-hidden", "true");
    expect(getFocusable(dialog)).toEqual([]);
  });

  it("wraps Tab at both ends and leaves middle moves to the browser", () => {
    const { dialog, a, b, c } = setup();
    expect(nextTrapTarget(dialog, c, false)).toBe(a);
    expect(nextTrapTarget(dialog, a, true)).toBe(c);
    expect(nextTrapTarget(dialog, a, false)).toBeNull();
    expect(nextTrapTarget(dialog, b, true)).toBeNull();
  });

  it("pulls escaped focus back in", () => {
    const { dialog, opener, a, c } = setup();
    expect(nextTrapTarget(dialog, opener, false)).toBe(a);
    expect(nextTrapTarget(dialog, opener, true)).toBe(c);
    expect(nextTrapTarget(dialog, dialog, false)).toBe(a);
  });

  it("focuses first element, traps Tab, restores focus on close", () => {
    const { doc, dialog, opener, a, c } = setup();
    const off = activateDialogFocus(dialog, doc);
    expect(doc.activeElement).toBe(a);
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    c.focus();
    const e = doc.key("Tab");
    expect(e.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(a);

    const back = doc.key("Tab", true);
    expect(back.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(c);

    off();
    expect(doc.activeElement).toBe(opener);
    expect(doc.listeners).toHaveLength(0);
    // Attributes the hook added are removed again; authored ones stay.
    expect(dialog.hasAttribute("role")).toBe(false);
    expect(dialog.hasAttribute("aria-modal")).toBe(false);
  });

  it("keeps existing role/label and applies a label only when missing", () => {
    const { doc, dialog } = setup();
    dialog.setAttribute("role", "alertdialog");
    const off = activateDialogFocus(dialog, doc, { label: "Settings" });
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    expect(dialog.getAttribute("aria-label")).toBe("Settings");
    off();
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    const d2 = setup();
    d2.dialog.setAttribute("aria-labelledby", "t");
    const off2 = activateDialogFocus(d2.dialog, d2.doc, { label: "X" });
    expect(d2.dialog.hasAttribute("aria-label")).toBe(false);
    off2();
  });

  it("Escape calls onEscape only when provided and not already handled", () => {
    const { doc, dialog } = setup();
    let closed = 0;
    const off = activateDialogFocus(dialog, doc, {
      onEscape: () => closed++,
    });
    doc.key("Escape");
    expect(closed).toBe(1);
    // A nested handler that already consumed Escape wins.
    const handled = {
      key: "Escape",
      defaultPrevented: true,
      preventDefault() {},
    };
    for (const fn of doc.listeners) fn(handled);
    expect(closed).toBe(1);
    off();

    const s = setup();
    const off2 = activateDialogFocus(s.dialog, s.doc);
    const e = s.doc.key("Escape");
    expect(e.defaultPrevented).toBe(false);
    off2();
  });

  it("does not steal focus already inside the dialog", () => {
    const { doc, dialog, b } = setup();
    b.focus();
    const off = activateDialogFocus(dialog, doc);
    expect(doc.activeElement).toBe(b);
    off();
  });

  it("supports initialFocus container/none and empty dialogs", () => {
    const { doc, dialog, opener } = setup();
    const off = activateDialogFocus(dialog, doc, { initialFocus: "none" });
    expect(doc.activeElement).toBe(opener);
    off();

    const s = setup();
    const off2 = activateDialogFocus(s.dialog, s.doc, {
      initialFocus: "container",
    });
    expect(s.doc.activeElement).toBe(s.dialog);
    expect(s.dialog.getAttribute("tabindex")).toBe("-1");
    off2();

    const doc3 = new FakeDoc();
    const empty = new FakeEl(doc3);
    const off3 = activateDialogFocus(empty, doc3);
    expect(doc3.activeElement).toBe(empty);
    const e = doc3.key("Tab");
    expect(e.defaultPrevented).toBe(true);
    off3();
  });

  it("only the top-most dialog reacts to keys", () => {
    const { doc, dialog, c } = setup();
    let outerClosed = 0;
    let innerClosed = 0;
    const offOuter = activateDialogFocus(dialog, doc, {
      onEscape: () => outerClosed++,
    });
    const inner = new FakeEl(doc);
    const x = inner.add(new FakeEl(doc, "BUTTON"));
    const offInner = activateDialogFocus(inner, doc, {
      onEscape: () => innerClosed++,
    });
    expect(doc.activeElement).toBe(x);
    doc.key("Escape");
    expect(innerClosed).toBe(1);
    expect(outerClosed).toBe(0);
    offInner();
    // Focus returns to what the outer dialog had focused.
    expect(dialog.contains(doc.activeElement)).toBe(true);
    c.focus();
    doc.key("Escape");
    expect(outerClosed).toBe(1);
    offOuter();
  });

  it("does not restore to a detached opener or when restoreFocus=false", () => {
    const { doc, dialog, opener } = setup();
    const off = activateDialogFocus(dialog, doc);
    opener.isConnected = false;
    off();
    expect(doc.activeElement).not.toBe(opener);

    const s = setup();
    const off2 = activateDialogFocus(s.dialog, s.doc, { restoreFocus: false });
    off2();
    expect(s.doc.activeElement).toBe(s.a);
  });

  it("does not yank focus the close action sent elsewhere", () => {
    const { doc, dialog, opener } = setup();
    const elsewhere = new FakeEl(doc, "BUTTON");
    const off = activateDialogFocus(dialog, doc);
    elsewhere.focus();
    off();
    expect(doc.activeElement).toBe(elsewhere);
    expect(doc.activeElement).not.toBe(opener);
  });

  it("leaves a Tab the dialog already handled alone", () => {
    const { doc, dialog, a, b } = setup();
    const off = activateDialogFocus(dialog, doc);
    b.focus();
    // Simulate the palette input's own handler running first.
    doc.listeners.unshift((e) => e.preventDefault());
    doc.key("Tab", true);
    expect(doc.activeElement).toBe(b);
    a.focus();
    doc.key("Tab", true);
    expect(doc.activeElement).toBe(a);
    off();
  });

  it("trap=false or a false getter lets Tab leave the dialog", () => {
    const { doc, dialog, c } = setup();
    let modal = false;
    const off = activateDialogFocus(dialog, doc, { trap: () => modal });
    c.focus();
    expect(doc.key("Tab").defaultPrevented).toBe(false);
    modal = true;
    expect(doc.key("Tab").defaultPrevented).toBe(true);
    off();
    const s = setup();
    const off2 = activateDialogFocus(s.dialog, s.doc, { trap: false });
    s.c.focus();
    expect(s.doc.key("Tab").defaultPrevented).toBe(false);
    off2();
  });
});
