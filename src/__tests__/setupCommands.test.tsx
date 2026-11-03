import React from "react";
import { existsSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  comfyEnvLine,
  fetchModelsCommand,
  fetchToolArg,
  pinHfCommand,
  revisionFor,
  revisionIndex,
  rowsFromDownloadListJson,
  rowsFromDownloadListTsv,
} from "@/lib/tools/setupCommands";
import { OptionBody, QuickSetup } from "@/components/tools/SetupDrawer";

const SHA = "ee6f4a40737a995bf5818954cfce6d59443b0f04";

describe("fetch-models command", () => {
  it("is the documented first command, quoted for the shell", () => {
    expect(fetchModelsCommand("upscale", "/opt/ComfyUI")).toBe(
      "node scripts/fetch-models.mjs --tool upscale --comfy /opt/ComfyUI --yes",
    );
    expect(fetchModelsCommand("upscale", "/Volumes/My Disk/ComfyUI")).toBe(
      "node scripts/fetch-models.mjs --tool upscale --comfy '/Volumes/My Disk/ComfyUI' --yes",
    );
  });

  it("maps a card key to the tool-map id; kind:id only when ids collide", () => {
    const map = {
      tools: [
        { kind: "action", id: "upscale" },
        { kind: "action", id: "x" },
        { kind: "catalog", id: "x" },
      ],
    };
    expect(fetchToolArg(map, "action:upscale")).toBe("upscale");
    expect(fetchToolArg(map, "catalog:x")).toBe("catalog:x");
    expect(fetchToolArg(map, "app:nope")).toBeNull();
    expect(fetchToolArg(null, "action:upscale")).toBeNull();
  });

  it("resolves against the real tool map", async () => {
    const map = (await import("../../docs/models-by-tool.json")).default;
    expect(fetchToolArg(map, "action:upscale")).toBe("upscale");
  });

  it("env line uses the real root, with a placeholder fallback", () => {
    expect(comfyEnvLine("/opt/ComfyUI")).toBe("export COMFYUI=/opt/ComfyUI");
    expect(comfyEnvLine(undefined)).toBe("export COMFYUI=/path/to/ComfyUI");
  });
});

describe("revision pins", () => {
  const rows = rowsFromDownloadListTsv(
    [
      "#host\tset\thf_repo\trepo_file_path\trevision_sha\tsize_bytes\tdest_relpath",
      `pc\tminimal\tOrg/Repo\tsplit/vae/a.safetensors\t${SHA}\t10\tvae/a.safetensors`,
      `pc\tfull\tOrg/Folder\tm/1.bin\t${SHA}\t1\tLLM/Folder/1.bin`,
      `pc\tfull\tOrg/Folder\tm/2.bin\t${SHA}\t1\tLLM/Folder/2.bin`,
      "pc\tfull\tbad repo\tx\tnot-a-sha\t1\tvae/b.safetensors",
    ].join("\n"),
  );
  const idx = revisionIndex(rows);

  it("parses TSV and JSON download lists, dropping malformed rows", () => {
    expect(rows.map((r) => r.dest)).toEqual([
      "vae/a.safetensors",
      "LLM/Folder/1.bin",
      "LLM/Folder/2.bin",
    ]);
    const json = rowsFromDownloadListJson({
      files: [
        {
          repo: "Org/Repo",
          path: "p.safetensors",
          revision: SHA,
          dest: "loras/p.safetensors",
          also: ["loras/alt/p.safetensors"],
        },
        { repo: "Org/Repo", path: "q", revision: "main", dest: "q" },
      ],
    });
    expect(json.map((r) => r.dest)).toEqual([
      "loras/p.safetensors",
      "loras/alt/p.safetensors",
    ]);
    expect(rowsFromDownloadListJson("nope")).toEqual([]);
  });

  it("pins only when the repo matches the list row", () => {
    expect(
      revisionFor(idx, {
        file: "a.safetensors",
        folder: "vae/",
        source: "Org/Repo",
      }),
    ).toBe(SHA);
    expect(
      revisionFor(idx, {
        file: "a.safetensors",
        folder: "vae",
        source: "Other/Repo",
      }),
    ).toBeNull();
    expect(
      revisionFor(idx, {
        file: "Folder",
        folder: "LLM/Folder",
        source: "Org/Folder",
        byName: true,
      }),
    ).toBe(SHA);
    expect(
      revisionFor(idx, {
        file: "a.safetensors",
        folder: null,
        source: "Org/Repo",
      }),
    ).toBeNull();
  });

  it("adds --revision to hf lines only", () => {
    const cmd = `hf download Org/Repo split/vae/a.safetensors --local-dir "$COMFYUI/models" && mv "$COMFYUI/models/split/vae/a.safetensors" "$COMFYUI/models/vae/"`;
    expect(pinHfCommand(cmd, SHA)).toBe(
      `hf download Org/Repo split/vae/a.safetensors --revision ${SHA} --local-dir "$COMFYUI/models" && mv "$COMFYUI/models/split/vae/a.safetensors" "$COMFYUI/models/vae/"`,
    );
    expect(pinHfCommand(cmd, null)).toBe(cmd);
    expect(pinHfCommand(cmd, "main; rm -rf /")).toBe(cmd);
    const curl = "curl -L -o x https://github.com/a/b/releases/download/v1/x";
    expect(pinHfCommand(curl, SHA)).toBe(curl);
  });
});

describe("SetupDrawer blocks", () => {
  const noop = () => {};
  it("Quick setup shows the fetch-models command with a copy button", () => {
    const html = renderToStaticMarkup(
      <QuickSetup
        command={fetchModelsCommand("upscale", "/opt/ComfyUI")}
        copied={null}
        onCopy={noop}
      />,
    );
    expect(html).toContain('data-testid="setup-quick"');
    expect(html).toContain(
      "node scripts/fetch-models.mjs --tool upscale --comfy /opt/ComfyUI --yes",
    );
    expect(html).toContain("Copy the setup command");
  });

  it("per-file commands sit under Manual with the real COMFYUI line", () => {
    const html = renderToStaticMarkup(
      <OptionBody
        opt={{
          id: "tool",
          label: "Tool",
          files: [],
          nodeClasses: [],
          optionalNodeClasses: [],
          nodePacks: [],
          workflows: [],
          notes: [],
          backend: "default",
          missingNodes: [],
          missingOptionalNodes: [],
          nodeSources: {},
        }}
        copied={null}
        onCopy={noop}
        envLine={comfyEnvLine("/opt/ComfyUI")}
      />,
    );
    expect(html).toContain(">Manual</h3>");
    expect(html).toContain("export COMFYUI=/opt/ComfyUI");
    expect(html).not.toContain("/path/to/ComfyUI");
  });
});

describe("GET /api/tools/setup", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("@/lib/comfy/comfyFetch");
    vi.doUnmock("@/lib/comfy/objectInfoCache");
    vi.resetModules();
  });

  async function route() {
    vi.resetModules();
    vi.stubEnv("ADMIN_API_KEY", "");
    vi.stubEnv("COMFY_ROOT", "/nonexistent/adrift-test/ComfyUI");
    vi.doMock("@/lib/comfy/comfyFetch", () => ({
      comfyFetch: vi.fn(async () => {
        throw new Error("offline");
      }),
    }));
    vi.doMock("@/lib/comfy/objectInfoCache", () => ({
      getObjectInfoCached: vi.fn(async () => {
        throw new Error("offline");
      }),
    }));
    return import("@/app/api/tools/setup/route");
  }
  const get = async (key: string) =>
    (await route()).GET(
      new NextRequest(
        `http://localhost/api/tools/setup?key=${encodeURIComponent(key)}`,
      ),
    );

  it("returns the real root and the fetch-models first command", async () => {
    const body = await (await get("action:upscale")).json();
    expect(body.ok).toBe(true);
    expect(body.comfyRoot).toBe("/nonexistent/adrift-test/ComfyUI");
    expect(body.fetchCommand).toBe(
      "node scripts/fetch-models.mjs --tool upscale --comfy /nonexistent/adrift-test/ComfyUI --yes",
    );
  });

  it("says how many other cards share each file", async () => {
    const body = await (await get("action:edit_photo")).json();
    const files = body.setup.options.flatMap(
      (o: { files: Array<{ file: string; sharedWith: number }> }) => o.files,
    );
    const vae = files.find(
      (f: { file: string }) => f.file === "qwen_image_vae.safetensors",
    );
    expect(vae.sharedWith).toBeGreaterThanOrEqual(20);
    for (const f of files) expect(typeof f.sharedWith).toBe("number");
  });

  // models/download-list.json ships in the public repo; a monorepo checkout
  // has the TSV it is generated from instead.
  const LIST_SRC = path.join(process.cwd(), "models");
  const hasList =
    existsSync(path.join(process.cwd(), "models/download-list.json")) ||
    existsSync(path.join(LIST_SRC, "download_list.tsv"));

  it.skipIf(!hasList)("hf lines carry the download-list revision", async () => {
    const body = await (await get("action:make_3d_trellis")).json();
    const files = body.setup.options.flatMap(
      (o: {
        files: Array<{ command: string | null; revision: string | null }>;
      }) => o.files,
    );
    const pinned = files.filter((f: { revision: string | null }) => f.revision);
    expect(pinned.length).toBeGreaterThan(0);
    for (const f of files) {
      if (f.revision) expect(f.command).toContain(`--revision ${f.revision}`);
      else if (f.command?.startsWith("hf download"))
        expect(f.command).not.toContain("--revision");
    }
  });
});
