import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import path from "path";
import type { Moodboard, MoodboardImage, MoodboardTrainingRun } from "@/types";
import { adriftDataPath } from "@/lib/paths/resolveDirs";

export interface MoodboardDB {
  version: number;
  moodboards: Moodboard[];
}

export const MOODBOARDS_DB_PATH = adriftDataPath("moodboards.json");

const dbSnapshots = new WeakMap<MoodboardDB, MoodboardDB>();
let mutationQueue = Promise.resolve();

function cloneDB(db: MoodboardDB): MoodboardDB {
  return {
    version: db.version,
    moodboards: db.moodboards.map((m) => ({
      ...m,
      images: m.images.map((image) => ({ ...image })),
      tags: m.tags ? [...m.tags] : undefined,
      trainingRuns: m.trainingRuns
        ? m.trainingRuns.map((run) => ({ ...run }))
        : undefined,
      captionSettings: m.captionSettings
        ? { ...m.captionSettings }
        : undefined,
    })),
  };
}

async function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const previous = mutationQueue;
  let release!: () => void;
  mutationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

// Older sv imports could append the same deterministic id twice; React keys
// and id lookups assume uniqueness, so keep the first row per id on read.
export function dedupeMoodboardsById(db: MoodboardDB): MoodboardDB {
  if (!Array.isArray(db.moodboards)) return { ...db, moodboards: [] };
  const seen = new Set<string>();
  const moodboards = db.moodboards.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  return moodboards.length === db.moodboards.length ? db : { ...db, moodboards };
}

async function readMoodboardsDB(): Promise<MoodboardDB> {
  try {
    await fs.mkdir(path.dirname(MOODBOARDS_DB_PATH), { recursive: true });
    const content = await fs.readFile(MOODBOARDS_DB_PATH, "utf-8");
    return dedupeMoodboardsById(JSON.parse(content) as MoodboardDB);
  } catch {
    return { version: 1, moodboards: [] };
  }
}

async function writeMoodboardsDB(db: MoodboardDB): Promise<void> {
  await fs.mkdir(path.dirname(MOODBOARDS_DB_PATH), { recursive: true });
  const tmp = path.join(
    path.dirname(MOODBOARDS_DB_PATH),
    `.moodboards.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );

  try {
    await fs.writeFile(tmp, JSON.stringify(db, null, 2), "utf-8");
    await fs.rename(tmp, MOODBOARDS_DB_PATH);
  } catch (error) {
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
}

function mergeLoadedChanges(
  base: MoodboardDB,
  next: MoodboardDB,
  current: MoodboardDB,
): MoodboardDB {
  const baseById = new Map(base.moodboards.map((m) => [m.id, m]));
  const nextById = new Map(next.moodboards.map((m) => [m.id, m]));
  const deletedIds = new Set(
    base.moodboards.filter((m) => !nextById.has(m.id)).map((m) => m.id),
  );
  const additions = next.moodboards.filter((m) => !baseById.has(m.id));
  const updates = next.moodboards.filter((m) => {
    const baseMoodboard = baseById.get(m.id);
    return baseMoodboard && JSON.stringify(baseMoodboard) !== JSON.stringify(m);
  });
  const updateById = new Map(updates.map((m) => [m.id, m]));
  const defaultMoodboard = [...additions, ...updates].find((m) => m.isDefault);

  let moodboards = current.moodboards
    .filter((m) => !deletedIds.has(m.id))
    .map((m) => updateById.get(m.id) ?? m);

  for (let i = additions.length - 1; i >= 0; i -= 1) {
    const moodboard = additions[i]!;
    if (!moodboards.some((m) => m.id === moodboard.id)) {
      moodboards = [moodboard, ...moodboards];
    }
  }

  if (defaultMoodboard) {
    moodboards = moodboards.map((m) => ({
      ...m,
      isDefault: m.id === defaultMoodboard.id,
    }));
  }

  return { version: next.version, moodboards };
}

export async function loadMoodboardsDB(): Promise<MoodboardDB> {
  await mutationQueue;
  const db = await readMoodboardsDB();
  const snapshot = cloneDB(db);
  dbSnapshots.set(db, snapshot);
  return db;
}

export async function saveMoodboardsDB(db: MoodboardDB): Promise<void> {
  await runExclusive(async () => {
    const snapshot = dbSnapshots.get(db);
    const next = snapshot
      ? mergeLoadedChanges(snapshot, db, await readMoodboardsDB())
      : db;
    await writeMoodboardsDB(next);
  });
}

export async function getMoodboard(id: string): Promise<Moodboard | null> {
  const db = await loadMoodboardsDB();
  return db.moodboards.find((m) => m.id === id) ?? null;
}

export async function createMoodboardEntry(data: {
  name: string;
  description?: string;
  images?: MoodboardImage[];
  isDefault?: boolean;
  kind?: Moodboard["kind"];
}): Promise<Moodboard> {
  return runExclusive(async () => {
    const db = await readMoodboardsDB();
    const now = Date.now();
    const isDefault = data.isDefault ?? false;

    let moodboards = db.moodboards;
    if (isDefault) {
      moodboards = moodboards.map((m) => ({ ...m, isDefault: false }));
    }

    const moodboard: Moodboard = {
      id: uuidv4(),
      name: data.name,
      description: data.description ?? undefined,
      images: data.images ?? [],
      isDefault,
      kind: data.kind ?? undefined,
      createdAt: now,
      updatedAt: now,
    };

    db.moodboards = [moodboard, ...moodboards];
    await writeMoodboardsDB(db);
    return moodboard;
  });
}

export async function deleteMoodboardsBatch(ids: string[]): Promise<{
  deleted: string[];
  moodboards: Moodboard[];
}> {
  return runExclusive(async () => {
    const db = await readMoodboardsDB();
    const idSet = new Set(ids);
    const deleted = db.moodboards
      .filter((m) => idSet.has(m.id))
      .map((m) => m.id);

    db.moodboards = db.moodboards.filter((m) => !idSet.has(m.id));
    await writeMoodboardsDB(db);

    return { deleted, moodboards: db.moodboards };
  });
}

export async function tagMoodboardsBatch(
  ids: string[],
  tags: string[],
  mode: "add" | "remove",
): Promise<{ updated: string[]; moodboards: Moodboard[] }> {
  return runExclusive(async () => {
    const db = await readMoodboardsDB();
    const now = Date.now();
    const idSet = new Set(ids);
    const tagSet = new Set(tags);
    const updated: string[] = [];

    db.moodboards = db.moodboards.map((m) => {
      if (!idSet.has(m.id)) return m;
      const current = m.tags ?? [];
      const nextTags =
        mode === "add"
          ? Array.from(new Set([...current, ...tags]))
          : current.filter((tag) => !tagSet.has(tag));

      updated.push(m.id);
      return {
        ...m,
        tags: nextTags.length ? nextTags : undefined,
        updatedAt: now,
      };
    });

    await writeMoodboardsDB(db);
    return { updated, moodboards: db.moodboards };
  });
}

export async function mergeMoodboardsBatch(
  ids: string[],
  targetId: string,
): Promise<{ target: Moodboard; deleted: string[]; moodboards: Moodboard[] }> {
  return runExclusive(async () => {
    const db = await readMoodboardsDB();
    const target = db.moodboards.find((m) => m.id === targetId);
    if (!target) throw new Error("Target moodboard not found");

    const sourceIds = new Set(ids.filter((id) => id !== targetId));
    const sourceBoards = db.moodboards.filter((m) => sourceIds.has(m.id));
    const imageByUrl = new Map<string, MoodboardImage>();

    for (const image of target.images) {
      imageByUrl.set(image.url, image);
    }
    for (const board of sourceBoards) {
      for (const image of board.images) {
        if (!imageByUrl.has(image.url)) imageByUrl.set(image.url, image);
      }
    }

    const now = Date.now();
    const mergedTarget: Moodboard = {
      ...target,
      images: Array.from(imageByUrl.values()),
      updatedAt: now,
    };
    const deleted = sourceBoards.map((m) => m.id);

    db.moodboards = db.moodboards
      .filter((m) => !sourceIds.has(m.id))
      .map((m) => (m.id === targetId ? mergedTarget : m));

    await writeMoodboardsDB(db);
    return { target: mergedTarget, deleted, moodboards: db.moodboards };
  });
}

export async function recordTrainingRun(
  boardId: string,
  run: MoodboardTrainingRun,
): Promise<Moodboard> {
  return runExclusive(async () => {
    const db = await readMoodboardsDB();
    const board = db.moodboards.find((m) => m.id === boardId);
    if (!board) throw new Error("Moodboard not found");
    const runs = (board.trainingRuns ?? []).filter(
      (r) => r.jobId !== run.jobId,
    );
    board.trainingRuns = [...runs, run];
    board.updatedAt = Date.now();
    await writeMoodboardsDB(db);
    return board;
  });
}

export async function updateTrainingRun(
  boardId: string,
  jobId: string,
  patch: Partial<Pick<MoodboardTrainingRun, "status" | "outputLoraPath">>,
): Promise<Moodboard | null> {
  return runExclusive(async () => {
    const db = await readMoodboardsDB();
    const board = db.moodboards.find((m) => m.id === boardId);
    if (!board?.trainingRuns?.some((r) => r.jobId === jobId)) return null;
    board.trainingRuns = board.trainingRuns.map((r) =>
      r.jobId === jobId ? { ...r, ...patch } : r,
    );
    board.updatedAt = Date.now();
    await writeMoodboardsDB(db);
    return board;
  });
}

/** Next LoRA version for a board: 1 + highest recorded version (v1 if none). */
export function nextTrainingVersion(board: Moodboard): number {
  const versions = (board.trainingRuns ?? []).map((r) => r.version || 1);
  return versions.length ? Math.max(...versions) + 1 : 1;
}
