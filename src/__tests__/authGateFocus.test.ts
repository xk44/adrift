/** C13: the sign-in dialog is a real modal (focus trapped, labelled). */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = fs.readFileSync(
  path.join(process.cwd(), "src/components/AuthGate.tsx"),
  "utf8",
);

describe("AuthGate dialog", () => {
  it("traps focus with useDialogFocus while open", () => {
    expect(src).toContain('from "@/hooks/useDialogFocus"');
    expect(src).toContain("useDialogFocus(dialogRef, open)");
    expect(src).toContain("ref={dialogRef}");
  });

  it("is a labelled modal dialog", () => {
    expect(src).toContain('role="dialog"');
    expect(src).toContain('aria-modal="true"');
    expect(src).toContain('aria-labelledby="auth-gate-title"');
    expect(src).toContain('id="auth-gate-title"');
  });

  it("calls the hook before the closed early return (rules of hooks)", () => {
    expect(src.indexOf("useDialogFocus(dialogRef")).toBeLessThan(
      src.indexOf("if (!open) return null"),
    );
  });
});
