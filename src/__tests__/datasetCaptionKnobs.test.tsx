import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  applyCaptionBatchEdit,
  buildMetadataJsonl,
  captionTrainingParams,
  datasetFileName,
  editCaption,
  normalizeCaptionSettings,
} from "@/lib/moodboards/captions";
import {
  DatasetCaptionPanel,
  buildBatchOp,
} from "@/components/training/DatasetCaptionPanel";
import type { Moodboard } from "@/types";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("editCaption", () => {
  it("find/replace is literal, case-insensitive by default, and tidies separators", () => {
    expect(
      editCaption("a cat, Cat ears", {
        kind: "replace",
        find: "cat",
        replace: "dog",
      }),
    ).toBe("a dog, dog ears");
    expect(
      editCaption("a (cat).*", {
        kind: "replace",
        find: "(cat).*",
        replace: "x",
      }),
    ).toBe("a x");
    expect(
      editCaption("red, blurry, sky", {
        kind: "replace",
        find: "blurry",
        replace: "",
      }),
    ).toBe("red, sky");
    expect(
      editCaption("Cat", {
        kind: "replace",
        find: "cat",
        replace: "dog",
        caseSensitive: true,
      }),
    ).toBe("Cat");
  });

  it("prepend/append add a tag once and fill empty captions", () => {
    expect(editCaption("a fox", { kind: "prepend", token: "ohwx" })).toBe(
      "ohwx, a fox",
    );
    expect(editCaption("OHWX, a fox", { kind: "prepend", token: "ohwx" })).toBe(
      "OHWX, a fox",
    );
    expect(
      editCaption("a fox", { kind: "append", token: " film grain, " }),
    ).toBe("a fox, film grain");
    expect(
      editCaption("a fox, film grain", { kind: "append", token: "film grain" }),
    ).toBe("a fox, film grain");
    expect(editCaption("", { kind: "append", token: "tag" })).toBe("tag");
    expect(editCaption("keep", { kind: "prepend", token: "  " })).toBe("keep");
  });
});

describe("applyCaptionBatchEdit", () => {
  const images = [
    { url: "/a.png", caption: "a cat", captionSource: "florence" },
    { url: "/b.png", caption: "a cat sleeping" },
    { url: "/c.png" },
  ];

  it("only touches selected items and marks them manual", () => {
    const { images: next, changed } = applyCaptionBatchEdit(images, [0, 2], {
      kind: "replace",
      find: "cat",
      replace: "dog",
    });
    expect(changed).toBe(1);
    expect(next[0]).toEqual({
      url: "/a.png",
      caption: "a dog",
      captionSource: "manual",
    });
    expect(next[1]).toBe(images[1]);
    expect(next[2]).toBe(images[2]);
  });

  it("clears captions edited to empty and returns the same array on no-op", () => {
    const cleared = applyCaptionBatchEdit(images, [0], {
      kind: "replace",
      find: "a cat",
      replace: "",
    });
    expect(cleared.images[0]).toEqual({
      url: "/a.png",
      caption: undefined,
      captionSource: undefined,
    });
    const noop = applyCaptionBatchEdit(images, [1], {
      kind: "replace",
      find: "zebra",
      replace: "x",
    });
    expect(noop.changed).toBe(0);
    expect(noop.images).toBe(images);
  });

  it("prepends across all selected items, including uncaptioned ones", () => {
    const { images: next, changed } = applyCaptionBatchEdit(images, [0, 1, 2], {
      kind: "prepend",
      token: "zk",
    });
    expect(changed).toBe(3);
    expect(next.map((i) => i.caption)).toEqual([
      "zk, a cat",
      "zk, a cat sleeping",
      "zk",
    ]);
  });
});

describe("metadata.jsonl", () => {
  it("emits one file_name/text line per captioned row with the trigger prefixed", () => {
    const out = buildMetadataJsonl(
      [
        { fileName: "0001-a.png", caption: "a cat" },
        { fileName: "0002-b.png" },
        { fileName: "0003-c.png", caption: 'quote "x"\nnewline' },
      ],
      "ohwx",
    );
    const lines = out.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({
      file_name: "0001-a.png",
      text: "ohwx, a cat",
    });
    expect(JSON.parse(lines[1]!)).toEqual({
      file_name: "0003-c.png",
      text: 'ohwx, quote "x"\nnewline',
    });
    expect(out.endsWith("\n")).toBe(true);
    expect(buildMetadataJsonl([{ fileName: "x.png" }])).toBe("");
  });

  it("datasetFileName is index-prefixed, sanitized and keeps an extension", () => {
    expect(datasetFileName("/api/moodboards/upload?file=my%20pic.jpg", 0)).toBe(
      "0001-my_pic.jpg",
    );
    expect(datasetFileName("https://cdn.example/x/y/photo.webp?sig=1", 9)).toBe(
      "0010-photo.webp",
    );
    expect(datasetFileName("/api/thing", 1)).toBe("0002-thing.png");
    expect(datasetFileName("/a/../..", 2)).toMatch(
      /^0003-[A-Za-z0-9_-]*\.png$/,
    );
  });
});

describe("caption settings", () => {
  it("normalizes, clamps and drops defaults", () => {
    expect(normalizeCaptionSettings(null)).toEqual({});
    expect(
      normalizeCaptionSettings({
        triggerWord: "  ohwx ",
        dropoutRate: 1.7,
        shuffle: true,
        keepTokens: 99.6,
      }),
    ).toEqual({
      triggerWord: "ohwx",
      dropoutRate: 1,
      shuffle: true,
      keepTokens: 32,
    });
    expect(
      normalizeCaptionSettings({
        dropoutRate: 0,
        shuffle: false,
        keepTokens: 3,
      }),
    ).toEqual({});
  });

  it("maps to kohya-style trainer params only when set", () => {
    expect(captionTrainingParams(undefined)).toEqual({});
    expect(
      captionTrainingParams({
        dropoutRate: 0.05,
        shuffle: true,
        keepTokens: 2,
      }),
    ).toEqual({
      caption_dropout_rate: 0.05,
      shuffle_caption: true,
      keep_tokens: 2,
    });
    expect(captionTrainingParams({ shuffle: true })).toEqual({
      shuffle_caption: true,
    });
  });

  it("buildBatchOp returns null for no-op inputs", () => {
    expect(buildBatchOp("replace", "", "x", "")).toBeNull();
    expect(buildBatchOp("append", "", "", "  ")).toBeNull();
    expect(buildBatchOp("prepend", "", "", "zk")).toEqual({
      kind: "prepend",
      token: "zk",
    });
    expect(buildBatchOp("replace", "a", "", "")).toEqual({
      kind: "replace",
      find: "a",
      replace: "",
    });
  });
});

describe("DatasetCaptionPanel markup", () => {
  it("renders the knobs, batch editor and export with saved settings", () => {
    const board: Moodboard = {
      id: "b1",
      name: "Ink",
      kind: "style",
      captionSettings: {
        triggerWord: "zkink",
        dropoutRate: 0.1,
        shuffle: true,
        keepTokens: 2,
      },
      images: [
        { url: "/a.png", weight: 1, caption: "ink" },
        { url: "/b.png", weight: 1 },
      ],
    };
    const html = renderToStaticMarkup(
      <DatasetCaptionPanel
        board={board}
        selected={[1]}
        onSelectionChange={() => {}}
        onBoardUpdated={() => {}}
      />,
    );
    expect(html).toContain('value="zkink"');
    expect(html).toContain('value="10"');
    expect(html).toContain("Shuffle tags");
    expect(html).toContain("1/2 selected");
    expect(html).toContain("Find / replace");
    expect(html).toContain("metadata.jsonl");
    expect(html).toContain("Apply to selected");
  });
});

describe("PUT /api/moodboards captionSettings", () => {
  async function loadPUT(boards: Moodboard[]) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-mb-knobs-"));
    await fs.mkdir(path.join(tmp, "data"));
    await fs.writeFile(
      path.join(tmp, "data/moodboards.json"),
      JSON.stringify({ version: 1, moodboards: boards }),
    );
    vi.resetModules();
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
    vi.doMock("@/lib/env", () => ({
      env: {
        ADMIN_API_KEY: "",
        COMFY_HTTP_URL: "http://127.0.0.1:8188",
        STYLEVAULT_API_URL: "http://127.0.0.1:8000",
        NODE_ENV: "test",
      },
    }));
    return (await import("@/app/api/moodboards/route")).PUT;
  }
  const put = (PUT: (r: NextRequest) => Promise<Response>, body: unknown) =>
    PUT(
      new NextRequest("http://localhost:3000/api/moodboards", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ).then((r) => r.json());

  const id = "00000000-0000-4000-8000-000000000001";

  it("saves normalized knobs, keeps them on unrelated updates, and clears with null", async () => {
    const PUT = await loadPUT([{ id, name: "Ink", kind: "style", images: [] }]);
    const saved = await put(PUT, {
      id,
      captionSettings: {
        triggerWord: " zk ",
        dropoutRate: 0.25,
        shuffle: true,
        keepTokens: 1,
      },
    });
    expect(saved.ok).toBe(true);
    expect(saved.moodboard.captionSettings).toEqual({
      triggerWord: "zk",
      dropoutRate: 0.25,
      shuffle: true,
      keepTokens: 1,
    });
    const renamed = await put(PUT, { id, name: "Ink 2" });
    expect(renamed.moodboard.captionSettings.triggerWord).toBe("zk");
    const cleared = await put(PUT, { id, captionSettings: null });
    expect(cleared.moodboard.captionSettings).toBeUndefined();
  });

  it("rejects out-of-range knobs", async () => {
    const PUT = await loadPUT([{ id, name: "Ink", kind: "style", images: [] }]);
    const res = await put(PUT, { id, captionSettings: { dropoutRate: 2 } });
    expect(res.ok).toBe(false);
  });
});
