/**
 * Setup wizard Folders step: row state, default-follows-root, save payload,
 * the no-ComfyUI and remote-ComfyUI renders, and the wizard wiring.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { DirRowView, DirsResponse } from "@/components/onboarding/api";
import {
  folderSavePayload,
  folderValue,
  initialFolderRows,
  joinDir,
  visibleFolderKeys,
} from "@/components/onboarding/foldersModel";
import {
  FoldersEditor,
  PRECEDENCE_HELP,
} from "@/components/onboarding/FoldersEditor";
import { forcedSetupStep } from "@/components/onboarding/firstRun";

const src = (p: string) =>
  readFileSync(path.resolve(__dirname, "..", p), "utf8");

function row(
  over: Partial<DirRowView> & Pick<DirRowView, "key" | "display">,
): DirRowView {
  const side = over.key === "data" ? "adrift" : "comfy";
  return {
    source: "default",
    envVar: "X",
    envLocked: false,
    defaultDisplay: over.display,
    side,
    check: {
      key: over.key,
      status: "ok",
      display: over.display,
      exists: true,
      reason: "",
      notes: [],
      canCreate: false,
    },
    ...over,
  };
}

function resp(over: Partial<DirsResponse> = {}): DirsResponse {
  return {
    ok: true,
    comfyLocal: true,
    dirs: [
      row({ key: "comfyRoot", display: "~/ComfyUI", envVar: "COMFY_ROOT" }),
      row({
        key: "models",
        display: "~/ComfyUI/models",
        envVar: "COMFY_MODELS_DIR",
      }),
      row({
        key: "input",
        display: "~/ComfyUI/input",
        envVar: "COMFY_INPUT_DIR",
      }),
      row({
        key: "output",
        display: "/srv/renders",
        source: "saved",
        defaultDisplay: "~/ComfyUI/output",
        envVar: "COMFYUI_OUTPUT_DIR",
      }),
      row({ key: "data", display: "~/adrift/data", envVar: "ADRIFT_DATA_DIR" }),
    ],
    ...over,
  };
}

describe("foldersModel", () => {
  it("initial rows: saved rows are custom, others on their default", () => {
    const rows = initialFolderRows(resp());
    expect(rows.output).toMatchObject({
      useDefault: false,
      value: "/srv/renders",
    });
    expect(rows.models.useDefault).toBe(true);
  });

  it("default subfolders follow the ComfyUI folder as it is edited", () => {
    const r = resp();
    const rows = initialFolderRows(r);
    rows.comfyRoot = {
      ...rows.comfyRoot,
      value: "/mnt/ana/ComfyUI",
      useDefault: false,
    };
    expect(folderValue("models", rows, r)).toBe("/mnt/ana/ComfyUI/models");
    expect(folderValue("output", rows, r)).toBe("/srv/renders");
    rows.comfyRoot = { ...rows.comfyRoot, value: "D:\\ComfyUI" };
    expect(folderValue("input", rows, r)).toBe("D:\\ComfyUI\\input");
  });

  it("joinDir", () => {
    expect(joinDir("~/ComfyUI/", "models")).toBe("~/ComfyUI/models");
    expect(joinDir("/", "models")).toBe("/models");
  });

  it("save payload: null for defaults, skips env-locked and hidden rows", () => {
    const r = resp();
    r.dirs[0] = { ...r.dirs[0], envLocked: true, source: "env" };
    const rows = initialFolderRows(r);
    expect(folderSavePayload(rows, false)).toEqual({
      models: null,
      input: null,
      output: "/srv/renders",
      data: null,
    });
    rows.data = { ...rows.data, useDefault: false, value: " ~/AdriftLibrary " };
    expect(folderSavePayload(rows, true)).toEqual({ data: "~/AdriftLibrary" });
  });

  it("no ComfyUI: only Adrift's own folder", () => {
    expect(visibleFolderKeys(true)).toEqual(["data"]);
    expect(visibleFolderKeys(false)).toHaveLength(5);
  });

  it("?setup= opens a known step only", () => {
    expect(forcedSetupStep("?setup=folders")).toBe("folders");
    expect(forcedSetupStep("?setup=nope")).toBeNull();
    expect(forcedSetupStep("")).toBeNull();
  });
});

describe("FoldersEditor render", () => {
  it("shows every folder, sources, status and the precedence help", () => {
    const html = renderToStaticMarkup(<FoldersEditor initial={resp()} />);
    for (const label of [
      "ComfyUI folder",
      "Models",
      "Input",
      "Output",
      "Adrift library",
    ])
      expect(html).toContain(label);
    expect(html).toContain("~/ComfyUI/models");
    expect(html).toContain("Custom");
    expect(html).toContain("Use default");
    expect(html).toContain("Looks good");
    expect(html).toContain(PRECEDENCE_HELP.slice(0, 30));
  });

  it("env-locked rows are read-only and say which variable", () => {
    const r = resp();
    r.dirs[4] = { ...r.dirs[4], envLocked: true, source: "env" };
    const html = renderToStaticMarkup(<FoldersEditor initial={r} />);
    expect(html).toMatch(/Set by ADRIFT_DATA_DIR in .env.local/);
    expect(html).toMatch(/readOnly|readonly/);
  });

  it("missing folder offers Create folder", () => {
    const r = resp();
    r.dirs[4] = {
      ...r.dirs[4],
      check: {
        ...r.dirs[4].check,
        status: "warn",
        exists: false,
        reason: "Folder doesn't exist yet.",
        canCreate: true,
      },
    };
    const html = renderToStaticMarkup(<FoldersEditor initial={r} />);
    expect(html).toContain("Create folder");
    expect(html).toContain("doesn&#x27;t exist yet");
  });

  it("remote ComfyUI: explains, marks its folders not checked", () => {
    const r = resp({ comfyLocal: false });
    for (const d of r.dirs.slice(0, 4))
      d.check = {
        ...d.check,
        status: "remote",
        reason: "On the ComfyUI machine (not checked).",
      };
    const html = renderToStaticMarkup(<FoldersEditor initial={r} />);
    expect(html).toContain("ComfyUI runs on another machine");
    expect(html.match(/not checked/g)?.length).toBe(4);
    expect(html).toContain("Looks good"); // the Adrift library row
  });

  it("no ComfyUI yet: only the library row", () => {
    const html = renderToStaticMarkup(
      <FoldersEditor initial={resp()} noComfy />,
    );
    expect(html).toContain("Adrift library");
    expect(html).not.toContain("ComfyUI folder<");
    expect(html).toContain("Settings &rarr; Folders".replace("&rarr;", "→"));
  });

  it("Settings mode has a Save button", () => {
    expect(
      renderToStaticMarkup(<FoldersEditor initial={resp()} showSave />),
    ).toContain("Save");
  });
});

describe("wizard wiring", () => {
  const wiz = src("components/onboarding/OnboardingWizard.tsx");
  it("Folders sits between Connect and Models and saves on Next", () => {
    expect(wiz).toMatch(/"connect"[\s\S]*"folders"[\s\S]*"packs"/);
    expect(wiz).toContain("folders.current.save()");
  });
  it("Continue without ComfyUI goes to Folders in no-ComfyUI mode", () => {
    expect(wiz).toContain("onContinueWithout={continueWithout}");
    expect(wiz).toMatch(/setNoComfy\(true\);\s*setStep\("folders"\)/);
  });
  it("Settings has a Folders card", () => {
    expect(src("components/SettingsPanel.tsx")).toContain(
      "<FoldersEditor showSave />",
    );
  });
});
