#!/usr/bin/env node
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { v5 as uuidv5 } from "uuid";

// Defaults to ~/krea-moodboards; override with KREA_MOODBOARDS_DIR.
const DEFAULT_ROOT = path.join(os.homedir(), "krea-moodboards");
const DEFAULT_OUT = "data/moodboards.json";
export const KREA_MOODBOARD_NAMESPACE = "90d8fe5e-9ecd-4ce5-8c56-f6a4bf219755";

// Board dirs use alphanumeric prefixes.
// Match any safe alnum-led name; non-board JSONs (ALL_MOODBOARDS.json, indexes) are excluded
// below by requiring a matching _images directory.
const BOARD_JSON_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*\.json$/;
const IMAGE_FILE_RE = /^[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/i;

export function expandHome(input) {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function truncate(input, max) {
  return String(input ?? "").slice(0, max);
}

export function buildDescription(tasteProfile, keywords) {
  const cleanKeywords = Array.isArray(keywords)
    ? keywords
        .filter((keyword) => typeof keyword === "string" && keyword.trim())
        .slice(0, 6)
    : [];
  const keywordText = cleanKeywords.length
    ? ` · ${cleanKeywords.join(", ")}`
    : "";
  const suffix = keywordText.slice(0, 500);
  return `${truncate(tasteProfile, Math.max(0, 500 - suffix.length))}${suffix}`.slice(
    0,
    500,
  );
}

export function buildKreaMoodboardEntry(
  board,
  boardDirName,
  imageFiles,
  now = Date.now(),
) {
  const images = imageFiles
    .filter((file) => IMAGE_FILE_RE.test(file))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 20)
    .map((file) => ({
      url: `/api/moodboards/krea?board=${encodeURIComponent(boardDirName)}&file=${encodeURIComponent(file)}`,
      weight: 1,
    }));

  return {
    id: uuidv5(String(board.uuid ?? board.id), KREA_MOODBOARD_NAMESPACE),
    name: truncate(board.name || boardDirName.replace(/_images$/, ""), 100),
    description: buildDescription(board.taste_profile, board.keywords),
    images,
    isDefault: false,
    createdAt: now,
    updatedAt: now,
  };
}

function parseArgs(argv) {
  const args = {
    root: process.env.KREA_MOODBOARDS_DIR || DEFAULT_ROOT,
    limit: Number.POSITIVE_INFINITY,
    out: DEFAULT_OUT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      args.root = argv[++index];
    } else if (arg === "--limit") {
      const value = Number.parseInt(argv[++index], 10);
      if (!Number.isFinite(value) || value < 0)
        throw new Error("--limit must be a non-negative integer");
      args.limit = value;
    } else if (arg === "--out") {
      args.out = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.root || !args.out)
    throw new Error("--root and --out require values");
  return args;
}

async function loadMoodboards(outPath) {
  try {
    const raw = await fs.readFile(outPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      version: typeof parsed.version === "number" ? parsed.version : 1,
      moodboards: Array.isArray(parsed.moodboards) ? parsed.moodboards : [],
    };
  } catch (error) {
    if (error && error.code === "ENOENT") return { version: 1, moodboards: [] };
    throw error;
  }
}

async function writeAtomic(outPath, data) {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tmp, outPath);
}

async function importKreaMoodboards(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const root = path.resolve(expandHome(args.root));
  const outPath = path.resolve(args.out);
  const names = (await fs.readdir(root))
    .filter((name) => BOARD_JSON_RE.test(name))
    .sort((a, b) => a.localeCompare(b));

  const imported = [];
  let scanned = 0;
  let imagesLinked = 0;
  const now = Date.now();

  for (const filename of names) {
    if (imported.length >= args.limit) break;
    const stem = filename.slice(0, -".json".length);
    const boardDirName = `${stem}_images`;
    // A real board has a matching _images dir; this excludes index files
    // (ALL_MOODBOARDS.json etc) that also end in .json.
    let imageFiles = [];
    try {
      imageFiles = await fs.readdir(path.join(root, boardDirName));
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    const board = JSON.parse(
      await fs.readFile(path.join(root, filename), "utf8"),
    );
    // Numbered/preset boards carry `uuid`; full-gallery (gNNNN_) boards carry `id`.
    const boardKey = board?.uuid ?? board?.id;
    if (typeof boardKey !== "string" || !boardKey) continue;
    scanned += 1;
    const entry = buildKreaMoodboardEntry(board, boardDirName, imageFiles, now);
    imagesLinked += entry.images.length;
    imported.push(entry);
  }

  const db = await loadMoodboards(outPath);
  const importIds = new Set(imported.map((entry) => entry.id));
  db.moodboards = [
    ...imported,
    ...db.moodboards.filter((entry) => !importIds.has(entry.id)),
  ];
  await writeAtomic(outPath, db);

  const stat = await fs.stat(outPath);
  console.log(
    JSON.stringify(
      {
        boardsScanned: scanned,
        imported: imported.length,
        imagesLinked,
        output: outPath,
        outputBytes: stat.size,
      },
      null,
      2,
    ),
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  importKreaMoodboards().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
