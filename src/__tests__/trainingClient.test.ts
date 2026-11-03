import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deployTrainingJob,
  getTrainingJob,
  listTrainingBackends,
  startTrainingJob,
} from "@/lib/sref/apiClient";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

describe("StyleVault training client", () => {
  it("lists trainer backends through the vault proxy", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          backends: [
            {
              name: "musubi-tuner",
              installed: true,
              version: "1.0.0",
              model_families: ["krea2"],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const backends = await listTrainingBackends();

    expect(fetchMock).toHaveBeenCalledWith("/api/vault/training/backends", undefined);
    expect(backends).toEqual([
      {
        name: "musubi-tuner",
        installed: true,
        version: "1.0.0",
        model_families: ["krea2"],
      },
    ]);
  });

  it("starts a Krea2 training job with cluster dataset and params", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ job_id: "job-123", status: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await startTrainingJob({
      backend: "ai-toolkit",
      model_family: "krea2",
      run_name: "ink-lines",
      dataset: { cluster_id: 42 },
      params: { steps: 900, rank: 16, trigger_word: "inkline" },
    });

    expect(result).toEqual({ job_id: "job-123", status: "queued" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/vault/training/jobs",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          backend: "ai-toolkit",
          model_family: "krea2",
          run_name: "ink-lines",
          dataset: { cluster_id: 42 },
          params: { steps: 900, rank: 16, trigger_word: "inkline" },
        }),
      }),
    );
  });

  it("polls and deploys a finished training job", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            job_id: "job-123",
            backend: "musubi-tuner",
            model_family: "krea2",
            status: "done",
            created_at: "2026-07-01T00:00:00Z",
            progress: 100,
            output_lora_path: "/tmp/out.safetensors",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            deployed_path: "/home/user/ComfyUI/models/loras/ink.safetensors",
            lora_name: "ink.safetensors",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const detail = await getTrainingJob("job-123");
    const deployed = await deployTrainingJob("job-123", {
      lora_dir: "~/projects/ComfyUI/models/loras",
      name: "ink",
    });

    expect(detail.status).toBe("done");
    expect(deployed.lora_name).toBe("ink.safetensors");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/vault/training/jobs/job-123",
      undefined,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/vault/training/jobs/job-123/deploy",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          lora_dir: "~/projects/ComfyUI/models/loras",
          name: "ink",
        }),
      }),
    );
  });
});
