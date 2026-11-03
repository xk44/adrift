/**
 * localLorasDir: only a ComfyUI on this machine exposes its loras folder,
 * and only when that folder exists.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localLorasDir } from "@/lib/characters/localLoras";

let root: string;
let empty: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cj-loras-"));
  fs.mkdirSync(path.join(root, "models", "loras"), { recursive: true });
  empty = fs.mkdtempSync(path.join(os.tmpdir(), "cj-noloras-"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});

describe("localLorasDir", () => {
  it("loopback ComfyUI with a loras folder -> that folder", () => {
    const want = path.resolve(root, "models", "loras");
    for (const url of [
      "http://127.0.0.1:8188",
      "http://localhost:8000",
      "http://[::1]:8188",
      "http://127.0.0.2:8188",
    ])
      expect(localLorasDir(url, root), url).toBe(want);
  });

  it("remote ComfyUI -> null even if a local folder exists", () => {
    for (const url of [
      "http://gpu-box.local:8188",
      "http://10.0.0.5:8188",
      "https://comfy.example.com",
    ])
      expect(localLorasDir(url, root), url).toBeNull();
  });

  it("missing folder or unparsable URL -> null", () => {
    expect(localLorasDir("http://127.0.0.1:8188", empty)).toBeNull();
    expect(localLorasDir("not a url", root)).toBeNull();
  });
});
