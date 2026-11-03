import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  shouldAutoProbeLocal,
  splitCliFlags,
} from "@/lib/onboarding/connectUi";
import { INLINE_TOOLS } from "@/lib/ui/lightboxTools";

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("shouldAutoProbeLocal", () => {
  const base = {
    choice: "local",
    hasResult: false,
    busy: false,
    envLocked: false,
    reachable: false,
  };
  it("probes this computer when nothing has been checked yet", () => {
    expect(shouldAutoProbeLocal(base)).toBe(true);
  });
  it("skips when the env-locked server already answers", () => {
    expect(
      shouldAutoProbeLocal({ ...base, envLocked: true, reachable: true }),
    ).toBe(false);
  });
  it("still probes when env-locked but unreachable", () => {
    expect(shouldAutoProbeLocal({ ...base, envLocked: true })).toBe(true);
  });
  it("skips for other choices, finished or running probes", () => {
    expect(shouldAutoProbeLocal({ ...base, choice: "lan" })).toBe(false);
    expect(shouldAutoProbeLocal({ ...base, hasResult: true })).toBe(false);
    expect(shouldAutoProbeLocal({ ...base, busy: true })).toBe(false);
  });
});

describe("splitCliFlags", () => {
  it("puts flags at odd indexes so they render unbroken", () => {
    const parts = splitCliFlags("Start it with --listen and --port 8188.");
    expect(parts.filter((_, i) => i % 2 === 1)).toEqual(["--listen", "--port"]);
    expect(parts.join("")).toBe("Start it with --listen and --port 8188.");
  });
  it("returns the whole message when there is no flag", () => {
    expect(splitCliFlags("Nothing answered")).toEqual(["Nothing answered"]);
  });
});

describe("visual polish copy and tokens", () => {
  it("names the face-fix variant plainly but keeps ADetailer searchable", () => {
    const t = INLINE_TOOLS.find((x) => x.key === "inline:adetailer");
    const v =
      t?.target.kind === "inline" ? t.target.variants[0] : undefined;
    expect(v?.label).toBe("Fix faces");
    expect(v?.ariaLabel).toContain("ADetailer");
  });
  it("Krea style browser uses theme tokens, not fixed greys", () => {
    expect(src("components/style/Krea2StyleLoraBrowser.tsx")).not.toMatch(
      /\bneutral-\d/,
    );
  });
  it("catalog errors never show raw file paths", () => {
    for (const p of [
      "components/style/StylesBrowse.tsx",
      "components/style/StyleCreatorHome.tsx",
    ]) {
      expect(src(p)).toContain("style catalog isn");
    }
  });
  it("editor bar wraps on phones and says Presets instead of P", () => {
    const s = src("components/editor/EditorPromptBar.tsx");
    expect(s).toContain('aria-label="Presets"');
    expect(s).not.toContain(">P</span>");
    expect(s).toContain("flex-wrap");
  });
  it("onboarding LAN example avoids a real home-network address", () => {
    expect(src("components/onboarding/ConnectStep.tsx")).not.toMatch(
      /192\.168\.1\./,
    );
  });
});
