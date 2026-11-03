import { describe, expect, it, vi } from "vitest";
import { fetchRunImages } from "@/lib/sourceRun";

const run = {
  run_id: "run-src",
  prompt: "amber lantern",
  parsedPrompt: "amber lantern",
  width: 1024,
  height: 768,
  createdAt: "2026-10-01T00:00:00.000Z",
  params: { ar: "4:3" },
  jobs: [
    { index: 0, seed: 7, status: "done", progress: 1, images: ["/a.png", "/b.png"] },
  ],
};

function stub(body: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("fetchRunImages", () => {
  it("requests the run by id and maps it to gallery images", async () => {
    const fetchImpl = stub({ ok: true, runs: [run], nextOffset: null });
    const images = await fetchRunImages("run-src", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("/api/jobs/recent?run_id=run-src");
    expect(images.map((i) => i.url)).toEqual(["/a.png", "/b.png"]);
    expect(images[0]).toMatchObject({
      runId: "run-src", jobIndex: 0, seed: 7, width: 1024, height: 768,
      historySource: "server", id: "server:run-src:0:0",
    });
  });

  it("encodes the id", async () => {
    const fetchImpl = stub({ ok: true, runs: [] });
    await fetchRunImages("a b", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("/api/jobs/recent?run_id=a%20b");
  });

  it("returns [] when the run is gone", async () => {
    expect(await fetchRunImages("run-src", stub({ ok: true, runs: [] }))).toEqual([]);
  });

  it("ignores a different run in the response", async () => {
    const other = { ...run, run_id: "other" };
    expect(await fetchRunImages("run-src", stub({ ok: true, runs: [other] }))).toEqual([]);
  });

  it("throws on HTTP errors and malformed bodies", async () => {
    await expect(fetchRunImages("run-src", stub({ ok: false }, 500))).rejects.toThrow("HTTP 500");
    await expect(fetchRunImages("run-src", stub({ ok: true }))).rejects.toThrow("malformed");
  });
});
