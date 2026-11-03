import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { featuredLayout } from "@/lib/tools/hubVisuals";
import {
  defaultPick,
  defaultSettings,
  getActionTool,
  pickValue,
  type ActionPicker,
} from "@/lib/tools/toolsPage";
import { radioKeyTarget } from "@/lib/tools/radioNav";
import {
  DROP_HINT,
  dragHasFiles,
  dropZoneClass,
} from "@/components/tools/useFileDrop";

const src = (p: string) =>
  readFileSync(join(__dirname, "..", "components", "tools", p), "utf8");

describe("featuredLayout", () => {
  it("only uses the wide lead tile when the rest fills whole rows", () => {
    expect(featuredLayout(0)).toEqual({ lead: false, bento: false });
    expect(featuredLayout(1)).toEqual({ lead: false, bento: false });
    expect(featuredLayout(2)).toEqual({ lead: false, bento: false });
    expect(featuredLayout(3)).toEqual({ lead: true, bento: false });
    // 4 cards: a 2-wide lead would leave an orphan on row 2.
    expect(featuredLayout(4)).toEqual({ lead: false, bento: false });
    expect(featuredLayout(5)).toEqual({ lead: true, bento: true });
    expect(featuredLayout(8)).toEqual({ lead: true, bento: true });
  });
});

describe("picker defaults", () => {
  const picker: ActionPicker = {
    key: "len",
    title: "Length",
    defaultId: "b",
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
  };

  it("uses defaultId when listed, else the first option", () => {
    expect(defaultPick(picker)).toBe("b");
    expect(defaultPick({ ...picker, defaultId: "zz" })).toBe("a");
    expect(defaultPick({ ...picker, defaultId: undefined })).toBe("a");
    expect(defaultPick({ ...picker, options: [] })).toBe("");
  });

  it("pickValue prefers the user's pick over the default", () => {
    const s = defaultSettings();
    expect(pickValue(picker, s)).toBe("b");
    expect(pickValue(picker, { ...s, picks: { len: "a" } })).toBe("a");
    expect(pickValue(picker, { ...s, picks: { len: "gone" } })).toBe("b");
  });

  it.each([
    ["music", "duration", "30"],
    ["music", "bpm", "120"],
    ["sfx", "duration", "8"],
  ])("%s %s reads in ascending order and keeps default %s", (id, key, def) => {
    const p = getActionTool(id)?.pickers?.find((x) => x.key === key);
    expect(p).toBeDefined();
    const nums = p!.options.map((o) => Number(o.id));
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
    expect(pickValue(p!, defaultSettings())).toBe(def);
  });
});

describe("radioKeyTarget", () => {
  const none = [false, false, false, false];

  it("wraps on arrows", () => {
    expect(radioKeyTarget(none, 3, "ArrowRight")).toBe(0);
    expect(radioKeyTarget(none, 0, "ArrowLeft")).toBe(3);
    expect(radioKeyTarget(none, 1, "ArrowDown")).toBe(2);
    expect(radioKeyTarget(none, 1, "ArrowUp")).toBe(0);
  });

  it("skips disabled options, including on Home/End", () => {
    const d = [true, false, true, false];
    expect(radioKeyTarget(d, 1, "ArrowRight")).toBe(3);
    expect(radioKeyTarget(d, 3, "ArrowRight")).toBe(1);
    expect(radioKeyTarget(d, 1, "ArrowLeft")).toBe(3);
    expect(radioKeyTarget(d, 3, "Home")).toBe(1);
    expect(radioKeyTarget([false, false, true], 0, "End")).toBe(1);
  });

  it("returns null for other keys, empty or all-disabled groups", () => {
    expect(radioKeyTarget(none, 0, "Enter")).toBeNull();
    expect(radioKeyTarget([], 0, "ArrowRight")).toBeNull();
    expect(radioKeyTarget([true, true], 0, "ArrowRight")).toBeNull();
  });
});

describe("tool input drop zones", () => {
  it("only reacts to drags that carry files", () => {
    expect(dragHasFiles(["text/plain", "Files"])).toBe(true);
    expect(dragHasFiles(["text/uri-list"])).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
  });

  it("outlines the zone while a file hovers", () => {
    expect(dropZoneClass(true)).toContain("outline-dashed");
    expect(dropZoneClass(false)).not.toContain("outline-dashed");
  });

  it("hides the drop hint on touch devices", () => {
    expect(DROP_HINT).toContain("[@media(hover:none)]:hidden");
  });

  it.each(["ToolImageInput.tsx", "ToolVideoInput.tsx", "ToolAudioInput.tsx"])(
    "%s uses the shared drop zone and labels Remove",
    (file) => {
      const s = src(file);
      expect(s).toMatch(/useFileDrop\(/);
      expect(s).toMatch(/dropZoneClass\(drop\.over\)/);
      expect(s).toMatch(/aria-label=\{`Remove \$\{label\.toLowerCase\(\)\}`\}/);
    },
  );
});

describe("runner and hub polish", () => {
  it("run buttons announce busy state", () => {
    expect(src("ToolRunner.tsx")).toMatch(/aria-busy=\{busy\}/);
    expect(src("ToolRunner.tsx")).toContain('"Starting…"');
    expect(src("RunnerShell.tsx")).toMatch(/aria-busy=\{busy\}/);
  });

  it("advanced params use plain labels behind a styled disclosure", () => {
    const s = src("ToolRunner.tsx");
    expect(s).toContain("<AdvancedSummary />");
    expect(s).toContain('"Prompt strength (CFG)"');
    expect(s).toMatch(/radioKeyTarget\(/);
  });

  it("the stage marks a sample cover as an example", () => {
    expect(src("RunnerStudio.tsx")).toContain(
      'data-testid="runner-stage-example"',
    );
  });

  it("the empty hub explains matches hidden by the license filter", () => {
    const s = src("ToolsPage.tsx");
    expect(s).toContain('data-testid="tools-empty-license"');
    expect(s).toMatch(/featuredLayout\(featured\.length\)/);
  });
});
