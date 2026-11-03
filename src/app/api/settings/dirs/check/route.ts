/**
 * POST { key, path, create? } -> { ok, check }
 *
 * Checks one folder typed into the Folders step: exists, is a folder,
 * readable / writable as that folder needs, looks like ComfyUI (main.py +
 * models/) for the install folder. Never lists the folder's contents.
 * `create: true` (the "Create folder" button) makes a missing folder; nothing
 * else creates one. System folders (/, /System, /etc, /usr, C:\Windows, …)
 * are refused. ComfyUI-side folders on a remote ComfyUI come back "remote"
 * (not checked, not created).
 *
 * Same access rule as saving settings (src/lib/onboarding/settingsAuth.ts):
 * it touches the server's disk.
 */
import { NextRequest, NextResponse } from "next/server";
import { withRateLimit } from "@/lib/rateLimit";
import { requireSettingsWrite } from "@/lib/onboarding/settingsAuth";
import { DIR_KEYS, comfyIsLocalMachine, type DirKey } from "@/lib/paths/resolveDirs";
import { checkDir } from "@/lib/paths/validateDir";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = requireSettingsWrite(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;
  let body: Record<string, unknown>;
  try {
    const raw = (await req.json()) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error();
    body = raw as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const key = body.key;
  if (typeof key !== "string" || !(DIR_KEYS as string[]).includes(key))
    return NextResponse.json(
      { ok: false, error: "Unknown folder" },
      { status: 400 },
    );
  const check = checkDir(key as DirKey, body.path, {
    comfyLocal: comfyIsLocalMachine(),
    create: body.create === true,
  });
  return NextResponse.json({ ok: true, check });
}
