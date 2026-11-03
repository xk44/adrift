import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutputFormatPicker } from "@/components/tools/OutputFormatPicker";
import {
  fetchMasterFormats,
  masterCookieString,
  readMasterChoice,
  resetMasterFormatsCache,
} from "@/lib/output/masterChoiceClient";

describe("master choice cookie (client)", () => {
  it("reads the choice from document.cookie text", () => {
    expect(readMasterChoice("x=1; adrift_master=image%3Aexr%2Cvideo%3Aprores4444")).toEqual({
      image: "exr",
      video: "prores4444",
    });
    expect(readMasterChoice("x=1")).toEqual({});
  });

  it("clears the cookie when both are back to the defaults", () => {
    expect(masterCookieString({ image: "png", video: "h264" })).toMatch(/^adrift_master=; .*max-age=0/);
    expect(masterCookieString({ image: "png16" })).toMatch(
      /^adrift_master=image%3Apng16; path=\/; max-age=31536000/,
    );
  });
});

describe("fetchMasterFormats", () => {
  beforeEach(() => resetMasterFormatsCache());
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shares one request and returns the lists", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, image: ["png", "exr"], video: ["h264"] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const [a, b] = await Promise.all([fetchMasterFormats(), fetchMasterFormats()]);
    expect(a).toEqual({ image: ["png", "exr"], video: ["h264"] });
    expect(b).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/comfy/output-formats");
  });

  it("returns null on failure and retries next time", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("down"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchMasterFormats()).toBeNull();
    expect(await fetchMasterFormats()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("OutputFormatPicker", () => {
  it("renders nothing until the server says extra formats exist", () => {
    expect(renderToStaticMarkup(<OutputFormatPicker />)).toBe("");
  });
});
