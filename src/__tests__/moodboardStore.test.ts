import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { Moodboard } from "@/types";

async function loadStore(cwd: string) {
  vi.resetModules();
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  return import("@/lib/moodboards/store");
}

async function writeMoodboards(cwd: string, moodboards: Moodboard[]) {
  await fs.mkdir(path.join(cwd, "data"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, "data/moodboards.json"),
    JSON.stringify({ version: 1, moodboards }, null, 2),
    "utf-8",
  );
}

function moodboard(id: string, name: string): Moodboard {
  return {
    id,
    name,
    images: [],
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("moodboard store", () => {
  it("serializes concurrent mutations without losing writes", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-store-"));
    const cwd = path.join(tmp, "app");
    await fs.mkdir(cwd);
    await writeMoodboards(cwd, [
      moodboard("a", "A"),
      moodboard("b", "B"),
      moodboard("c", "C"),
    ]);
    const { createMoodboardEntry, loadMoodboardsDB, saveMoodboardsDB } = await loadStore(cwd);

    const update = async () => {
      const db = await loadMoodboardsDB();
      await delay(5);
      const board = db.moodboards.find((m) => m.id === "a")!;
      board.name = "A updated";
      await saveMoodboardsDB(db);
    };
    const remove = async () => {
      const db = await loadMoodboardsDB();
      await delay(1);
      db.moodboards = db.moodboards.filter((m) => m.id !== "b");
      await saveMoodboardsDB(db);
    };
    const creates = Array.from({ length: 25 }, (_, i) =>
      createMoodboardEntry({ name: `Created ${i}` }),
    );

    await Promise.all([update(), remove(), ...creates]);

    const db = await loadMoodboardsDB();
    expect(db.moodboards).toHaveLength(27);
    expect(db.moodboards.find((m) => m.id === "a")?.name).toBe("A updated");
    expect(db.moodboards.some((m) => m.id === "b")).toBe(false);
    expect(db.moodboards.find((m) => m.id === "c")?.name).toBe("C");
    expect(db.moodboards.filter((m) => m.name.startsWith("Created "))).toHaveLength(25);
    expect(new Set(db.moodboards.map((m) => m.id)).size).toBe(27);
  });

  it("keeps moodboards.json intact when an atomic temp write fails", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-store-"));
    const cwd = path.join(tmp, "app");
    await fs.mkdir(cwd);
    const original = [moodboard("stable", "Stable")];
    await writeMoodboards(cwd, original);
    const dbPath = path.join(cwd, "data/moodboards.json");
    const before = await fs.readFile(dbPath, "utf-8");
    const { loadMoodboardsDB, saveMoodboardsDB } = await loadStore(cwd);
    const db = await loadMoodboardsDB();
    db.moodboards[0]!.name = "Changed";
    const realWriteFile = fs.writeFile.bind(fs);

    vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
      if (String(file).includes(".moodboards.")) {
        await realWriteFile(file, String(data).slice(0, 10), options);
        throw new Error("simulated write failure");
      }
      return realWriteFile(file, data, options);
    });

    await expect(saveMoodboardsDB(db)).rejects.toThrow("simulated write failure");

    const after = await fs.readFile(dbPath, "utf-8");
    expect(after).toBe(before);
    expect(JSON.parse(after)).toEqual({ version: 1, moodboards: original });
    const files = await fs.readdir(path.dirname(dbPath));
    expect(files.filter((file) => file.endsWith(".tmp"))).toHaveLength(0);
  });

  it("drops duplicate moodboard ids on read (first row wins)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-store-"));
    const cwd = path.join(tmp, "app");
    await fs.mkdir(cwd);
    await writeMoodboards(cwd, [
      moodboard("a", "A"),
      moodboard("b", "B"),
      moodboard("a", "A dup"),
      moodboard("b", "B dup"),
    ]);
    const { loadMoodboardsDB, getMoodboard } = await loadStore(cwd);

    const db = await loadMoodboardsDB();
    expect(db.moodboards.map((m) => m.name)).toEqual(["A", "B"]);
    expect((await getMoodboard("a"))?.name).toBe("A");
  });

  it("deletes moodboards in one batch", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-store-"));
    const cwd = path.join(tmp, "app");
    await fs.mkdir(cwd);
    await writeMoodboards(cwd, [
      moodboard("a", "A"),
      moodboard("b", "B"),
      moodboard("c", "C"),
    ]);
    const { deleteMoodboardsBatch, loadMoodboardsDB } = await loadStore(cwd);

    const result = await deleteMoodboardsBatch(["a", "missing", "c"]);

    expect(result.deleted).toEqual(["a", "c"]);
    const db = await loadMoodboardsDB();
    expect(db.moodboards.map((m) => m.id)).toEqual(["b"]);
  });

  it("adds and removes tags in one batch", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-store-"));
    const cwd = path.join(tmp, "app");
    await fs.mkdir(cwd);
    await writeMoodboards(cwd, [
      { ...moodboard("a", "A"), tags: ["old"] },
      { ...moodboard("b", "B"), tags: ["keep"] },
      moodboard("c", "C"),
    ]);
    const { tagMoodboardsBatch, loadMoodboardsDB } = await loadStore(cwd);

    await tagMoodboardsBatch(["a", "c"], ["new", "old"], "add");
    let db = await loadMoodboardsDB();
    expect(db.moodboards.find((m) => m.id === "a")?.tags).toEqual(["old", "new"]);
    expect(db.moodboards.find((m) => m.id === "c")?.tags).toEqual(["new", "old"]);
    expect(db.moodboards.find((m) => m.id === "b")?.tags).toEqual(["keep"]);

    await tagMoodboardsBatch(["a", "c"], ["old"], "remove");
    db = await loadMoodboardsDB();
    expect(db.moodboards.find((m) => m.id === "a")?.tags).toEqual(["new"]);
    expect(db.moodboards.find((m) => m.id === "c")?.tags).toEqual(["new"]);
  });

  it("merges boards into the target and dedupes images by url", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-store-"));
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
        ...moodboard("source-1", "Source 1"),
        images: [
          { url: "b.png", weight: 2 },
          { url: "c.png", weight: 1 },
        ],
      },
      {
        ...moodboard("source-2", "Source 2"),
        images: [{ url: "d.png", weight: 1 }],
      },
    ]);
    const { mergeMoodboardsBatch, loadMoodboardsDB } = await loadStore(cwd);

    const result = await mergeMoodboardsBatch(
      ["target", "source-1", "source-2"],
      "target",
    );

    expect(result.deleted).toEqual(["source-1", "source-2"]);
    expect(result.target.images).toEqual([
      { url: "a.png", weight: 1 },
      { url: "b.png", weight: 1 },
      { url: "c.png", weight: 1 },
      { url: "d.png", weight: 1 },
    ]);
    const db = await loadMoodboardsDB();
    expect(db.moodboards.map((m) => m.id)).toEqual(["target"]);
  });
});

describe("training run records + kinds", () => {
  it("recordTrainingRun appends, dedups by jobId, and nextTrainingVersion advances", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-store-"));
    await writeMoodboards(tmp, [
      { ...moodboard("b1", "Board"), kind: "style" },
    ]);
    const { recordTrainingRun, nextTrainingVersion, getMoodboard } =
      await loadStore(tmp);

    const run = {
      jobId: "9",
      runName: "style-board",
      version: 1,
      triggerWord: "sty",
      startedAt: "2026-07-05T00:00:00Z",
      status: "queued",
    };
    await recordTrainingRun("b1", run);
    // Re-recording the same jobId replaces rather than duplicates.
    await recordTrainingRun("b1", { ...run, status: "running" });

    const board = (await getMoodboard("b1"))!;
    expect(board.trainingRuns).toHaveLength(1);
    expect(board.trainingRuns![0]!.status).toBe("running");
    expect(nextTrainingVersion(board)).toBe(2);
    expect(board.kind).toBe("style");
  });

  it("updateTrainingRun patches status/output and returns null for unknown jobs", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-store-"));
    await writeMoodboards(tmp, [
      {
        ...moodboard("b1", "Board"),
        trainingRuns: [
          {
            jobId: "9",
            runName: "moodboard-board",
            version: 1,
            triggerWord: "t",
            startedAt: "2026-07-05T00:00:00Z",
            status: "running",
          },
        ],
      },
    ]);
    const { updateTrainingRun } = await loadStore(tmp);

    const updated = await updateTrainingRun("b1", "9", {
      status: "done",
      outputLoraPath: "/x/lora.safetensors",
    });
    expect(updated?.trainingRuns?.[0]).toMatchObject({
      status: "done",
      outputLoraPath: "/x/lora.safetensors",
    });
    expect(await updateTrainingRun("b1", "nope", { status: "done" })).toBeNull();
  });

  it("createMoodboardEntry persists kind", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-store-"));
    await writeMoodboards(tmp, []);
    const { createMoodboardEntry, getMoodboard } = await loadStore(tmp);

    const created = await createMoodboardEntry({
      name: "OC set",
      kind: "character",
    });
    expect((await getMoodboard(created.id))?.kind).toBe("character");
  });
});
