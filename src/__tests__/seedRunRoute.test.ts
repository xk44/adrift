import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

async function loadRoute(adminKey?: string) {
  vi.resetModules();
  if (adminKey) vi.stubEnv("ADMIN_API_KEY", adminKey);
  const route = await import("@/app/api/jobs/seed-run/route");
  const runs = await import("@/lib/comfy/runs");
  return { ...route, runs };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3000/api/jobs/seed-run", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("parseInputRef", () => {
  it("accepts input uploads and rejects traversal / other dirs", async () => {
    const { parseInputRef } = await import("@/lib/seedRun");
    expect(parseInputRef("cj_ref.png [input]")).toEqual({
      filename: "cj_ref.png",
      subfolder: "",
    });
    expect(parseInputRef("cj/upload_1.JPG [input]")).toEqual({
      filename: "upload_1.JPG",
      subfolder: "cj",
    });
    for (const bad of [
      "cj_ref.png [output]",
      "../secret.png [input]",
      "a/../b.png [input]",
      "/etc/passwd.png [input]",
      "x.txt [input]",
      "sp ace.png [input]",
      42,
      undefined,
    ]) {
      expect(parseInputRef(bad)).toBeNull();
    }
  });
});

describe("POST /api/jobs/seed-run", () => {
  it("registers a finished run whose only image is the upload's view URL", async () => {
    const { POST, runs } = await loadRoute();
    const res = await POST(
      post({ ref: "cj/photo.png [input]", width: 832, height: 1216, prompt: " a cat " }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const run = body.run;
    expect(run).toMatchObject({
      prompt: "a cat",
      width: 832,
      height: 1216,
      status: "done",
      params: { seed_upload: true },
    });
    expect(run.jobs).toHaveLength(1);
    const url = new URL(run.jobs[0].images[0]);
    expect(url.pathname.endsWith("/view")).toBe(true);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      filename: "photo.png",
      subfolder: "cj",
      type: "input",
    });
    expect(runs.getActiveRun(run.run_id)).toEqual(run);
  });

  it("round-trips into the LoadImage ref the action engine uses", async () => {
    const { POST } = await loadRoute();
    const { comfyImageRefFromViewUrl } = await import("@/lib/oj/engine");
    const res = await POST(post({ ref: "cj_ref.png [input]" }));
    const { run } = await res.json();
    expect(comfyImageRefFromViewUrl(run.jobs[0].images[0])).toBe(
      "cj_ref.png [input]",
    );
    expect(run.width).toBe(1024);
    expect(run.height).toBe(1024);
  });

  it("seeds an uploaded clip into job.videos with its duration", async () => {
    const { POST } = await loadRoute();
    const { comfyImageRefFromViewUrl } = await import("@/lib/oj/engine");
    const res = await POST(
      post({ ref: "cj/clip.mp4 [input]", width: 1280, height: 720, duration: 6.5 }),
    );
    expect(res.status).toBe(200);
    const { run } = await res.json();
    expect(run.jobs[0].images).toEqual([]);
    expect(run.jobs[0].videos).toHaveLength(1);
    expect(comfyImageRefFromViewUrl(run.jobs[0].videos[0])).toBe("cj/clip.mp4 [input]");
    expect(run.params).toEqual({ seed_upload: true, video_seconds: 6.5 });
    // bad duration is dropped, not fatal; images ignore duration
    const r2 = await (await POST(post({ ref: "c.mov [input]", duration: 999 }))).json();
    expect(r2.run.params).toEqual({ seed_upload: true });
    const r3 = await (await POST(post({ ref: "c.png [input]", duration: 3 }))).json();
    expect(r3.run.params).toEqual({ seed_upload: true });
    expect(r3.run.jobs[0].videos).toBeUndefined();
  });

  it("rejects bad refs and bad JSON", async () => {
    const { POST } = await loadRoute();
    expect((await POST(post({ ref: "../x.png [input]" }))).status).toBe(400);
    expect((await POST(post({}))).status).toBe(400);
    expect((await POST(post("{nope"))).status).toBe(400);
    expect((await POST(post([1, 2]))).status).toBe(400);
  });

  it("is admin-gated when a key is configured", async () => {
    const { POST } = await loadRoute("test-admin-key");
    expect((await POST(post({ ref: "cj_ref.png [input]" }))).status).toBe(401);
    const ok = await POST(
      post(
        { ref: "cj_ref.png [input]" },
        { Authorization: "Bearer test-admin-key" },
      ),
    );
    expect(ok.status).toBe(200);
  });
});
