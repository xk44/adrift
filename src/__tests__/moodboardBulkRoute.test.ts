import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { Moodboard } from "@/types";

function moodboard(id: string, name: string): Moodboard {
  return {
    id,
    name,
    images: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function request(body: unknown, token?: string): NextRequest {
  return new NextRequest("http://localhost:3000/api/moodboards/bulk", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function writeMoodboards(cwd: string, moodboards: Moodboard[]) {
  await fs.mkdir(path.join(cwd, "data"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, "data/moodboards.json"),
    JSON.stringify({ version: 1, moodboards }, null, 2),
    "utf-8",
  );
}

async function readMoodboards(cwd: string): Promise<Moodboard[]> {
  const raw = await fs.readFile(path.join(cwd, "data/moodboards.json"), "utf-8");
  return JSON.parse(raw).moodboards;
}

async function loadRoute(cwd: string, adminApiKey = "") {
  vi.resetModules();
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.doMock("@/lib/env", () => ({
    env: {
      ADMIN_API_KEY: adminApiKey,
      COMFY_HTTP_URL: "http://127.0.0.1:8188",
      COMFY_ROOT: "/tmp/adrift-test-comfyui",
      COMFY_DEFAULT_CHECKPOINT: "",
      CIVITAI_API_URL: "https://civitai.com/api/v1",
      CIVITAI_API_KEY: "",
      CIVITAI_API_KEY_ENCRYPTED: "",
      SECRETS_PASSPHRASE: "",
      STYLEVAULT_API_URL: "http://127.0.0.1:8000",
      NODE_ENV: "test",
    },
  }));
  return import("@/app/api/moodboards/bulk/route");
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/moodboards/bulk", () => {
  it("rejects unauthenticated requests when ADMIN_API_KEY is configured", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-bulk-route-"));
    const cwd = path.join(tmp, "app");
    await fs.mkdir(cwd);
    await writeMoodboards(cwd, [moodboard("a", "A")]);
    const { POST } = await loadRoute(cwd, "admin-key");

    const res = await POST(request({ action: "delete", ids: ["a"] }));

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error: "Unauthorized" });
    expect((await readMoodboards(cwd)).map((m) => m.id)).toEqual(["a"]);
  });

  it("deletes selected moodboards", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-bulk-route-"));
    const cwd = path.join(tmp, "app");
    await fs.mkdir(cwd);
    await writeMoodboards(cwd, [
      moodboard("a", "A"),
      moodboard("b", "B"),
      moodboard("c", "C"),
    ]);
    const { POST } = await loadRoute(cwd, "admin-key");

    const res = await POST(request({ action: "delete", ids: ["a", "c"] }, "admin-key"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deleted: ["a", "c"] });
    expect((await readMoodboards(cwd)).map((m) => m.id)).toEqual(["b"]);
  });

  it("adds and removes tags", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-bulk-route-"));
    const cwd = path.join(tmp, "app");
    await fs.mkdir(cwd);
    await writeMoodboards(cwd, [
      { ...moodboard("a", "A"), tags: ["old"] },
      { ...moodboard("b", "B"), tags: ["keep"] },
    ]);
    const { POST } = await loadRoute(cwd, "admin-key");

    let res = await POST(
      request(
        { action: "tag", ids: ["a", "b"], tags: ["new", "old"], mode: "add" },
        "admin-key",
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, updated: ["a", "b"] });
    let boards = await readMoodboards(cwd);
    expect(boards.find((m) => m.id === "a")?.tags).toEqual(["old", "new"]);
    expect(boards.find((m) => m.id === "b")?.tags).toEqual(["keep", "new", "old"]);

    res = await POST(
      request(
        { action: "tag", ids: ["a", "b"], tags: ["old"], mode: "remove" },
        "admin-key",
      ),
    );
    expect(res.status).toBe(200);
    boards = await readMoodboards(cwd);
    expect(boards.find((m) => m.id === "a")?.tags).toEqual(["new"]);
    expect(boards.find((m) => m.id === "b")?.tags).toEqual(["keep", "new"]);
  });

  it("merges boards into the target and removes sources", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-bulk-route-"));
    const cwd = path.join(tmp, "app");
    await fs.mkdir(cwd);
    await writeMoodboards(cwd, [
      {
        ...moodboard("target", "Target"),
        images: [
          { url: "a.png", weight: 1 },
          { url: "b.png", weight: 1 },
        ],
      },
      {
        ...moodboard("source", "Source"),
        images: [
          { url: "b.png", weight: 2 },
          { url: "c.png", weight: 1 },
        ],
      },
    ]);
    const { POST } = await loadRoute(cwd, "admin-key");

    const res = await POST(
      request(
        { action: "merge", ids: ["target", "source"], targetId: "target" },
        "admin-key",
      ),
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, deleted: ["source"] });
    expect(data.target.images).toEqual([
      { url: "a.png", weight: 1 },
      { url: "b.png", weight: 1 },
      { url: "c.png", weight: 1 },
    ]);
    const boards = await readMoodboards(cwd);
    expect(boards.map((m) => m.id)).toEqual(["target"]);
  });
});
