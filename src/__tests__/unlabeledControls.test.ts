import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { scanSource } from "@/lib/a11y/unlabeledControls";

// Guard against new controls that a screen reader announces as just "button".
// Icon-only buttons/links: zero tolerance. Form fields without a label: a
// per-file ratchet — counts may go down (lower the number here), never up.

const FIELD_BASELINE: Record<string, number> = {
  "src/components/ComfyLibraryPicker.tsx": 1,
  "src/components/CreateWorkflowPicker.tsx": 1,
  "src/components/editor/EnhanceOptions.tsx": 2,
  "src/components/MossLayoutEditor.tsx": 3,
  "src/components/nevo/NevoMenu.tsx": 1,
  "src/components/PersonalizePage.tsx": 1,
  "src/components/PromptAttachmentSections.tsx": 1,
  "src/components/SettingsPanel.tsx": 3,
  "src/components/style/Krea2StyleLoraBrowser.tsx": 1,
  "src/components/style/StyleSessionView.tsx": 1,
  "src/components/tools/TrainIdentity.tsx": 1,
  "src/components/training/LoraRunPanel.tsx": 4,
  "src/components/WorkflowControlPanel.tsx": 14,
  "src/components/workflowControls/specControls.tsx": 2,
  "src/components/WorkflowsPage.tsx": 1,
};

const FIELD_TAGS = new Set(["input", "textarea", "select"]);

function scan(src: string) {
  return scanSource("x.tsx", src).map((r) => r.tag);
}

describe("scanSource", () => {
  it("flags icon-only buttons and links", () => {
    expect(
      scan(`<button onClick={f}><X className="h-4 w-4" /></button>`),
    ).toEqual(["button"]);
    expect(scan(`<a href="/x"><Icon /></a>`)).toEqual(["a"]);
    expect(scan(`<div role="button" onClick={f}><Icon /></div>`)).toEqual([
      "div[role=button]",
    ]);
    expect(scan(`<button><span aria-hidden="true">x</span></button>`)).toEqual([
      "button",
    ]);
    expect(scan(`<button><img src={s} /></button>`)).toEqual(["button"]);
    expect(scan(`<button>{busy ? <Spinner /> : <Icon />}</button>`)).toEqual([
      "button",
    ]);
    expect(scan(`<button>{open && <Icon />}</button>`)).toEqual(["button"]);
  });

  it("accepts labelled or text-bearing controls", () => {
    for (const src of [
      `<button aria-label="Close"><X /></button>`,
      `<button title="Close"><X /></button>`,
      `<button aria-labelledby="t"><X /></button>`,
      `<button><X /> Close</button>`,
      `<button><span className="sr-only">Close</span><X /></button>`,
      `<button>{label}</button>`,
      `<button>{busy ? "Saving" : <>Save</>}</button>`,
      `<button><img src={s} alt="Avatar" /></button>`,
      `<button {...props} />`,
      `<button><Badge label="New" /></button>`,
      `<a>no href is not a link</a>`,
      `<Button onClick={f}><X /></Button>`,
    ]) {
      expect(scan(src), src).toEqual([]);
    }
  });

  it("flags form fields without a label", () => {
    expect(scan(`<input value={v} />`)).toEqual(["input"]);
    expect(scan(`<textarea value={v} />`)).toEqual(["textarea"]);
    expect(scan(`<select value={v}><option>a</option></select>`)).toEqual([
      "select",
    ]);
    for (const src of [
      `<input aria-label="Name" />`,
      `<input id="name" />`,
      `<label>Name <input /></label>`,
      `<input type="hidden" />`,
      `<input type="file" className="hidden" />`,
    ]) {
      expect(scan(src), src).toEqual([]);
    }
  });

  it("reports 1-based line numbers", () => {
    const r = scanSource(
      "f.tsx",
      `const a = 1;\nconst b = (\n  <button><X /></button>\n);`,
    );
    expect(r).toEqual([{ file: "f.tsx", line: 3, tag: "button" }]);
  });
});

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name === "__tests__" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("repo controls", () => {
  const root = path.join(__dirname, "..", "..");
  const results = tsxFiles(path.join(root, "src")).flatMap((abs) => {
    const rel = path.relative(root, abs).split(path.sep).join("/");
    return scanSource(rel, readFileSync(abs, "utf8"));
  });

  it("scans the real component tree", () => {
    // Guards against a path bug silently scanning nothing.
    expect(results.filter((r) => FIELD_TAGS.has(r.tag)).length).toBeGreaterThan(0);
  });

  it("has no unlabeled icon-only buttons or links", () => {
    const bad = results
      .filter((r) => !FIELD_TAGS.has(r.tag))
      .map(
        (r) =>
          `${r.file}:${r.line} <${r.tag}> needs aria-label or visible text`,
      );
    expect(bad).toEqual([]);
  });

  it("does not add unlabeled form fields", () => {
    const counts: Record<string, number> = {};
    for (const r of results) {
      if (FIELD_TAGS.has(r.tag)) counts[r.file] = (counts[r.file] ?? 0) + 1;
    }
    const over = Object.entries(counts)
      .filter(([f, n]) => n > (FIELD_BASELINE[f] ?? 0))
      .map(
        ([f, n]) =>
          `${f}: ${n} unlabeled fields (baseline ${FIELD_BASELINE[f] ?? 0}) — add aria-label`,
      );
    expect(over).toEqual([]);
  });
});
