import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { adriftDataPath } from "@/lib/paths/resolveDirs";

export const MOODBOARD_UPLOAD_DIR = adriftDataPath("moodboard-uploads");
export const MOODBOARD_TRAINING_DIR = adriftDataPath("moodboard-training");

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function invalidPart(value: string | null, pattern: RegExp): boolean {
  return (
    !value ||
    value.includes("\0") ||
    value.includes("..") ||
    path.isAbsolute(value) ||
    !pattern.test(value)
  );
}

export async function realpath(value: string): Promise<string> {
  return fs.realpath(value);
}

export function uploadUrl(filename: string): string {
  return `/api/moodboards/upload?file=${filename}`;
}

export async function copyImageToMoodboardUploads(sourcePath: string): Promise<{
  filename: string;
  url: string;
  path: string;
}> {
  await fs.mkdir(MOODBOARD_UPLOAD_DIR, { recursive: true });
  const ext = path.extname(sourcePath).toLowerCase();
  const filename = `${uuidv4()}${ext}`;
  const target = path.join(MOODBOARD_UPLOAD_DIR, filename);
  await fs.copyFile(sourcePath, target);
  return { filename, url: uploadUrl(filename), path: target };
}
