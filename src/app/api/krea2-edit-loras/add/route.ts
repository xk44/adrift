import { NextRequest, NextResponse } from "next/server";
import { mkdir, rename, readFile, writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/auth";
import { withLock } from "@/lib/locks";
import { isMissingDbError } from "@/lib/jsonDbLoad";
import { withRateLimit } from "@/lib/rateLimit";
import { apiCorsHeaders } from "@/lib/api";
import { isEditFamily, type EditLora } from "@/lib/krea2/editLoras";
import {
  inspectDest,
  resolveContainedDir,
  validateLeafName,
} from "@/lib/fs/safeDest";
import {
  downloadErrorStatus,
  downloadHfFile,
  validDisplayName,
} from "@/lib/net/hfFileDownload";
import { comfyModelsPath } from "@/lib/paths/resolveDirs";

const CORS_HEADERS = apiCorsHeaders(null, "POST, OPTIONS");
const USER_DATA = "data/edit-loras.json";

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/** Only allow direct-download safetensors from Hugging Face. */
function parseHfUrl(url: string): { filename: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "huggingface.co") return null;
  let base: string;
  try {
    base = validateLeafName(decodeURIComponent(path.basename(u.pathname)), [
      ".safetensors",
    ]);
  } catch {
    return null;
  }
  return { filename: base };
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

async function loadUser(): Promise<EditLora[]> {
  try {
    const parsed = JSON.parse(await readFile(path.resolve(USER_DATA), "utf8"));
    return Array.isArray(parsed?.loras) ? parsed.loras : [];
  } catch (err) {
    // Missing file = no user LoRAs yet; anything else must not be masked or
    // the save below would overwrite the user's list with one entry.
    if (!isMissingDbError(err)) throw err;
    return [];
  }
}

async function saveUser(loras: EditLora[]): Promise<void> {
  const out = path.resolve(USER_DATA);
  await mkdir(path.dirname(out), { recursive: true });
  const tmp = `${out}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ loras }, null, 2)}\n`, "utf8");
  await rename(tmp, out);
}

export async function POST(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 10 });
  if (!rl.ok) return rl.response;

  let body: {
    url?: unknown;
    family?: unknown;
    name?: unknown;
    strength?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const url = typeof body.url === "string" ? body.url : "";
  const parsed = parseHfUrl(url);
  if (!parsed) {
    return NextResponse.json(
      { error: "url must be a https://huggingface.co/.../*.safetensors link" },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  if (!isEditFamily(body.family)) {
    return NextResponse.json(
      { error: "family must be 'krea2edit' or 'ostris'" },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  const family = body.family;
  const { filename } = parsed;
  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim()
      : filename.replace(/\.safetensors$/, "");
  if (!validDisplayName(name)) {
    return NextResponse.json(
      { error: "name must be 1-80 characters on one line" },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  const strength =
    typeof body.strength === "number" && body.strength > 0 && body.strength <= 2
      ? body.strength
      : 1.0;

  let result: { entry: EditLora; alreadyPresent: boolean };
  try {
    result = await withLock(`krea2-edit-lora:${filename}`, async () => {
      // models/loras may itself link to another drive; nothing below it may.
      const destDir = await resolveContainedDir(
        comfyModelsPath(env.COMFY_ROOT, "loras"),
      );
      const alreadyPresent =
        (await inspectDest(path.join(destDir, filename))).kind === "file";
      if (!alreadyPresent) {
        // Idle timeout + request signal: a stalled or cancelled download
        // fails fast and releases this lock instead of holding it forever.
        await downloadHfFile({
          url,
          dir: destDir,
          name: filename,
          signal: req.signal,
        });
      }

      const entry: EditLora = {
        id: slugify(name) || slugify(filename),
        name,
        file: filename,
        family,
        base: "krea2-raw",
        defaultStrength: strength,
        url,
        custom: true,
      };
      // The per-file lock above doesn't serialize the shared user list: two
      // different files added at once would each load→save and drop the other.
      await withLock("krea2-edit-loras-user", async () => {
        const user = await loadUser();
        await saveUser([...user.filter((l) => l.id !== entry.id), entry]);
      });
      return { entry, alreadyPresent };
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: downloadErrorStatus(err), headers: CORS_HEADERS },
    );
  }

  return NextResponse.json(
    { ...result.entry, installed: true, alreadyPresent: result.alreadyPresent },
    { headers: CORS_HEADERS },
  );
}
