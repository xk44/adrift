import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs/promises";
import os from "os";
import path from "path";

const fetchMock = vi.fn();

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/moodboards/autosort", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function loadRoute(root: string, cwd: string) {
  vi.resetModules();
  vi.stubEnv("MOODBOARD_IMPORT_ROOT", root);
  vi.stubEnv("STYLEVAULT_API_URL", "http://stylevault.test");
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.stubGlobal("fetch", fetchMock);
  return import("@/app/api/moodboards/autosort/route");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("POST /api/moodboards/autosort", () => {
  it("rejects traversal and outside-root dirs before calling StyleVault", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-autosort-"));
    const cwd = path.join(tmp, "app");
    const root = path.join(tmp, "allowed");
    const outside = path.join(tmp, "outside");
    await fs.mkdir(cwd);
    await fs.mkdir(root);
    await fs.mkdir(outside);
    const { POST } = await loadRoute(root, cwd);

    for (const dir of ["../outside", outside]) {
      const res = await POST(request({ dir }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false });
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
