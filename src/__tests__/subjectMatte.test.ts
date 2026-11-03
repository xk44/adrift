import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ImagineRun, Workflow } from "@/types";
import {
  SUBJECT_MATTE_DEFAULT,
  buildSubjectMatteWorkflow,
} from "@/lib/oj/subjectMatte";

const base = () =>
  JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "public/workflows/packs/matanyone/subject_matte.json"),
      "utf-8",
    ),
  ) as Workflow;

const run = {
  jobs: [{ seed: 7, videos: ["/api/comfy/view?filename=clip.mp4&type=input&subfolder="] }],
} as unknown as ImagineRun;

const classes = (wf: Workflow) =>
  Object.values(wf).map((n) => n.class_type);

function textOf(wf: Workflow): unknown {
  return Object.values(wf).find((n) => n.class_type === "CLIPTextEncode")?.inputs.text;
}

describe("subject_matte builder", () => {
  it("names the subject, defaults to the largest person", () => {
    expect(textOf(buildSubjectMatteWorkflow(base(), run, 0, { subject: " man in blue " }).workflow)).toBe("man in blue");
    expect(textOf(buildSubjectMatteWorkflow(base(), run, 0, {}).workflow)).toBe(SUBJECT_MATTE_DEFAULT);
  });

  it("alpha keeps the RGBA branch only", () => {
    const c = classes(buildSubjectMatteWorkflow(base(), run, 0, { background: "alpha" }).workflow);
    expect(c).toContain("SaveAnimatedPNG");
    expect(c).not.toContain("SaveVideo");
    expect(c).not.toContain("EmptyImage");
  });

  it("green keeps the mp4 branch only", () => {
    const { workflow } = buildSubjectMatteWorkflow(base(), run, 0, { background: "green" });
    const c = classes(workflow);
    expect(c).toContain("SaveVideo");
    expect(c).not.toContain("SaveAnimatedPNG");
    expect(Object.values(workflow).find((n) => n.class_type === "EmptyImage")?.inputs.color).toBe(0x00ff00);
  });

  it("refuses a run with no video", () => {
    expect(() =>
      buildSubjectMatteWorkflow(base(), { jobs: [{}] } as unknown as ImagineRun, 0, {}),
    ).toThrow(/no video/);
  });
});
