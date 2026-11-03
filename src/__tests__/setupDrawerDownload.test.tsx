import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DownloadPanel,
  OptionBody,
  type SetupDownloads,
} from "@/components/tools/SetupDrawer";

const noop = () => {};

function file(over: Record<string, unknown>) {
  return {
    file: "a.safetensors",
    name: "a.safetensors",
    folder: "loras/",
    type: "loras",
    bytes: 2 * 1024 ** 3,
    source: "Org/Repo",
    sourceUrl: "https://huggingface.co/Org/Repo",
    gated: false,
    license: "apache-2.0",
    commercial: "yes",
    nc: false,
    command: "hf download Org/Repo a.safetensors",
    pathGuessed: false,
    optional: false,
    byName: false,
    status: "missing",
    dest: "loras/a.safetensors",
    ...over,
  } as never;
}

const dl = (over: Partial<SetupDownloads> = {}): SetupDownloads => ({
  enabled: true,
  job: null,
  error: null,
  start: noop,
  cancel: noop,
  ...over,
});

describe("setup drawer downloads", () => {
  it("offers one button for the required missing files with a dest", () => {
    const html = renderToStaticMarkup(
      <DownloadPanel
        files={[
          file({}),
          file({ file: "b.safetensors", dest: "loras/b.safetensors", status: "installed" }),
          file({ file: "c.safetensors", dest: null, gated: true }),
          file({ file: "d.safetensors", dest: "loras/d.safetensors", optional: true }),
        ]}
        dl={dl()}
      />,
    );
    expect(html).toContain("setup-download-all");
    expect(html).toContain("Get 1 missing");
    expect(html).toContain("1 file needs a manual download");
  });

  it("shows the running job's log and a stop button", () => {
    const html = renderToStaticMarkup(
      <DownloadPanel
        files={[file({})]}
        dl={dl({
          job: {
            id: "j",
            key: "k",
            dests: ["loras/a.safetensors"],
            state: "running",
            lines: ["a.safetensors:  40%|####"],
            exitCode: null,
          },
        })}
      />,
    );
    expect(html).toContain("Stop");
    expect(html).not.toContain("setup-download-all");
    expect(html).toContain("40%");
  });

  it("per-file Get only when downloads are enabled", () => {
    const opt = {
      id: "tool",
      label: "Tool",
      files: [file({}), file({ file: "g.safetensors", dest: null, gated: true, command: null })],
      nodeClasses: [],
      optionalNodeClasses: [],
      nodePacks: [],
      workflows: [],
      notes: [],
      backend: "default",
      missingNodes: [],
      missingOptionalNodes: [],
      nodeSources: {},
    } as never;
    const on = renderToStaticMarkup(
      <OptionBody opt={opt} copied={null} onCopy={noop} dl={dl()} />,
    );
    expect(on.match(/setup-file-download/g)?.length).toBe(1);
    expect(on).toContain("Gated: accept its terms");
    const off = renderToStaticMarkup(
      <OptionBody opt={opt} copied={null} onCopy={noop} />,
    );
    expect(off).not.toContain("setup-file-download");
    expect(off).not.toContain("setup-download-all");
  });

  it("notes files other tools share", () => {
    const opt = {
      id: "tool",
      label: "Tool",
      files: [
        file({ sharedWith: 3 }),
        file({ file: "b.safetensors", sharedWith: 1 }),
        file({ file: "c.safetensors", sharedWith: 0 }),
      ],
      nodeClasses: [],
      optionalNodeClasses: [],
      nodePacks: [],
      workflows: [],
      notes: [],
      backend: "default",
      missingNodes: [],
      missingOptionalNodes: [],
      nodeSources: {},
    } as never;
    const html = renderToStaticMarkup(
      <OptionBody opt={opt} copied={null} onCopy={noop} />,
    );
    expect(html.match(/setup-file-shared/g)?.length).toBe(2);
    expect(html).toContain("Shared with 3 other tools");
    expect(html).toContain("Shared with 1 other tool<");
  });
});
