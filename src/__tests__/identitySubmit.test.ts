import { describe, expect, it, vi } from "vitest";
import { buildIdentityJob } from "@/lib/training/identityJob";
import {
  TrainerNotConfiguredError,
  getTrainerStatus,
  submitIdentityTraining,
  uploadIdentityPhoto,
} from "@/lib/training/identitySubmit";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const spec = buildIdentityJob({ name: "Ana", photoCount: 10 });
const photos = Array.from({ length: 10 }, () => ({
  blob: new Blob(["x"], { type: "image/png" }),
}));

/** Fake Adrift server; records every call. */
function fakeServer(opts: {
  status?: unknown;
  train?: { body: unknown; status?: number };
}) {
  let uploads = 0;
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (url === "/api/identity-lora" && method === "GET")
      return json(
        opts.status ?? { ok: true, configured: true, families: ["krea2"] },
      );
    if (url === "/api/moodboards/upload")
      return json({
        ok: true,
        url: `/api/moodboards/upload?file=u${uploads++}.png`,
      });
    if (url === "/api/identity-lora" && method === "POST")
      return json({
        ok: true,
        moodboard: { id: "b1", name: spec.boardName, images: [] },
      });
    if (url === "/api/moodboards/b1/train")
      return json(
        opts.train?.body ?? { job_id: "j1", status: "queued", version: 1 },
        opts.train?.status ?? 200,
      );
    throw new Error(`unexpected ${method} ${url}`);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("getTrainerStatus", () => {
  it("surfaces the not-configured message", async () => {
    const { fetchImpl } = fakeServer({
      status: {
        ok: true,
        configured: false,
        families: [],
        error: "Trainer not configured: unreachable",
      },
    });
    expect(await getTrainerStatus(fetchImpl)).toEqual({
      configured: false,
      families: [],
      error: "Trainer not configured: unreachable",
    });
  });

  it("treats a network failure as not configured", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const s = await getTrainerStatus(fetchImpl);
    expect(s.configured).toBe(false);
    expect(s.error).toMatch(/status check failed/);
  });
});

describe("uploadIdentityPhoto", () => {
  it("passes already-uploaded URLs through without a request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const url = "/api/moodboards/upload?file=a.png";
    expect(await uploadIdentityPhoto({ url }, fetchImpl)).toBe(url);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("submitIdentityTraining", () => {
  it("stops before uploading when the trainer is not configured", async () => {
    const { fetchImpl, calls } = fakeServer({
      status: {
        ok: true,
        configured: false,
        families: [],
        error: "Trainer not configured: no backend installed.",
      },
    });
    await expect(
      submitIdentityTraining(spec, photos, { fetchImpl }),
    ).rejects.toBeInstanceOf(TrainerNotConfiguredError);
    expect(calls).toHaveLength(1);
  });

  it("stops when the trainer lacks the requested family", async () => {
    const { fetchImpl, calls } = fakeServer({
      status: { ok: true, configured: true, families: ["moss_image"] },
    });
    await expect(
      submitIdentityTraining(spec, photos, { fetchImpl }),
    ).rejects.toThrow(/not configured for krea2/);
    expect(calls).toHaveLength(1);
  });

  it("uploads, creates the dataset with captions, then starts training", async () => {
    const { fetchImpl, calls } = fakeServer({});
    const stages: string[] = [];
    const res = await submitIdentityTraining(spec, photos, {
      fetchImpl,
      onStage: (s) => stages.push(s),
    });
    expect(res.board.id).toBe("b1");
    expect(res.train.job_id).toBe("j1");
    expect(
      calls.filter((c) => c.url === "/api/moodboards/upload"),
    ).toHaveLength(10);
    const dataset = calls.find(
      (c) => c.url === "/api/identity-lora" && c.method === "POST",
    );
    expect(dataset?.body).toMatchObject({ name: "Identity: Ana" });
    const images = (dataset?.body as { images: unknown[] }).images;
    expect(images[0]).toEqual({
      url: "/api/moodboards/upload?file=u0.png",
      caption: "zxana person",
    });
    const train = calls.find((c) => c.url === "/api/moodboards/b1/train");
    expect(train?.body).toEqual(spec.request);
    expect(stages[0]).toBe("check");
    expect(stages.at(-1)).toBe("train");
  });

  it("reports a failed start and keeps the saved dataset name", async () => {
    const { fetchImpl } = fakeServer({
      train: {
        body: { ok: false, error: "StyleVault is unreachable" },
        status: 502,
      },
    });
    await expect(
      submitIdentityTraining(spec, photos, { fetchImpl }),
    ).rejects.toThrow(/StyleVault is unreachable.*Identity: Ana" was saved/);
  });

  it("rejects a photo list that no longer matches the spec", async () => {
    const { fetchImpl, calls } = fakeServer({});
    await expect(
      submitIdentityTraining(spec, photos.slice(1), { fetchImpl }),
    ).rejects.toThrow(/Photo count changed/);
    expect(calls).toHaveLength(0);
  });
});
