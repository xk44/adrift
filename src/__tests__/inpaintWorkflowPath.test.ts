/**
 * #28: /api/jobs/inpaint contains workflow_path to public/workflows (or
 * saved:) with realpath checks, and never echoes file contents or paths.
 * ComfyUI is fully mocked; requests stop at the workflow-load step.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/comfy/http", () => ({
  queuePrompt: vi.fn(),
  uploadImage: vi.fn(),
  ComfyAPIError: class ComfyAPIError extends Error {},
}));
vi.mock("@/lib/comfy/comfyFetch", () => ({ comfyFetch: vi.fn() }));
vi.mock("@/lib/comfy/workflows", () => ({
  loadWorkflowFromSelection: vi.fn(),
}));

import { queuePrompt, uploadImage } from "@/lib/comfy/http";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import { loadWorkflowFromSelection } from "@/lib/comfy/workflows";
import { resolveContainedWorkflowPath } from "@/lib/comfy/workflowPathGuard";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==";

function post(workflow_path: string) {
  return new NextRequest("http://localhost/api/jobs/inpaint", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": `wp-${Math.random()}` },
    body: JSON.stringify({
      prompt: "a lake",
      client_id: "c1",
      source_image: PNG,
      mask_data: PNG,
      workflow_path,
    }),
  });
}

describe("resolveContainedWorkflowPath", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adrift-wf-")));
  const base = path.join(tmp, "workflows");
  fs.mkdirSync(path.join(base, "sub"), { recursive: true });
  fs.writeFileSync(path.join(base, "a.json"), "{}");
  fs.writeFileSync(path.join(base, "sub", "b.json"), "{}");
  fs.writeFileSync(path.join(tmp, ".env.local"), "SECRET=1");
  fs.writeFileSync(path.join(tmp, "outside.json"), "{}");
  let symlinked = false;
  try {
    fs.symlinkSync(path.join(tmp, "outside.json"), path.join(base, "link.json"));
    symlinked = true;
  } catch {
    /* symlinks unavailable (Windows without privilege) */
  }

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves files inside the folder", async () => {
    expect(await resolveContainedWorkflowPath("a.json", base)).toBe(path.join(base, "a.json"));
    expect(await resolveContainedWorkflowPath("sub/b.json", base)).toBe(path.join(base, "sub", "b.json"));
    expect(await resolveContainedWorkflowPath("public/workflows/a.json", base)).toBe(
      path.join(base, "a.json"),
    );
    expect(await resolveContainedWorkflowPath("saved:mine.json", base)).toBe("saved:mine.json");
  });

  it("refuses traversal, absolute paths, non-JSON and missing files", async () => {
    for (const p of [
      "../.env.local",
      ".env.local",
      "../outside.json",
      "sub/../../outside.json",
      "..\\outside.json",
      path.join(tmp, "outside.json"),
      "C:\\Windows\\win.ini",
      "a.json\0.png",
      "missing.json",
      "sub",
      "",
    ]) {
      expect(await resolveContainedWorkflowPath(p, base), JSON.stringify(p)).toBeNull();
    }
  });

  it.runIf(symlinked)("refuses a symlink that escapes the folder", async () => {
    expect(await resolveContainedWorkflowPath("link.json", base)).toBeNull();
  });
});

describe("POST /api/jobs/inpaint workflow_path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["../.env.local", ".env.local", "../../package.json", "/etc/passwd", "../src/lib/env.ts"])(
    "rejects %s with a generic 400 and reads nothing",
    async (wp) => {
      const { POST } = await import("@/app/api/jobs/inpaint/route");
      const res = await POST(post(wp));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid workflow_path");
      expect(loadWorkflowFromSelection).not.toHaveBeenCalled();
      expect(uploadImage).not.toHaveBeenCalled();
      expect(queuePrompt).not.toHaveBeenCalled();
      expect(comfyFetch).not.toHaveBeenCalled();
    },
  );

  it("loads a shipped workflow by its contained real path and hides load errors", async () => {
    const shipped = fs.readdirSync(path.join(process.cwd(), "public/workflows")).find((f) => f.endsWith(".json"));
    expect(shipped).toBeTruthy();
    vi.mocked(loadWorkflowFromSelection).mockRejectedValue(
      new Error("Unexpected token S in JSON at position 0: SECRET=abc /Users/someone/app"),
    );
    const { POST } = await import("@/app/api/jobs/inpaint/route");
    const res = await POST(post(shipped!));
    expect(loadWorkflowFromSelection).toHaveBeenCalledWith(
      fs.realpathSync(path.join(process.cwd(), "public/workflows", shipped!)),
    );
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/SECRET|Unexpected token|\/Users\//);
    expect(uploadImage).not.toHaveBeenCalled();
    expect(queuePrompt).not.toHaveBeenCalled();
  });
});
