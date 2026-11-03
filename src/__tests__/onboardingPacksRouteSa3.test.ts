import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const GiB = 1024 ** 3;
const { comfy, listings } = vi.hoisted(() => ({
  comfy: vi.fn(),
  listings: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireAdmin: () => ({ ok: true }) }));
vi.mock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
vi.mock("@/lib/comfy/comfyFetch", () => ({ comfyFetch: () => comfy() }));
vi.mock("@/lib/tools/modelListing", () => ({
  modelListings: (types: Iterable<string>) => listings([...types]),
}));

import { GET } from "@/app/api/onboarding/packs/route";

const req = () => new NextRequest("http://127.0.0.1/api/onboarding/packs");

describe("GET /api/onboarding/packs: Stable Audio 3 pack", () => {
  beforeEach(() => {
    comfy.mockReset().mockResolvedValue(
      new Response(
        JSON.stringify({
          system: { os: "linux", ram_total: 64 * GiB },
          devices: [
            { name: "cuda:0 NVIDIA GeForce RTX 4080", type: "cuda", vram_total: 15.6 * GiB },
          ],
        }),
      ),
    );
    listings.mockReset().mockImplementation(async (types: string[]) => {
      const out: Record<string, Set<string>> = {};
      for (const t of types) out[t] = new Set();
      out.checkpoints.add("stable_audio_3_medium.safetensors");
      out.text_encoders.add("t5gemma_b_b_ul2.safetensors");
      return out;
    });
  });

  it("is in the 16 GB picks, installed without the optional Quality file, with its license note", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.tier).toBe("16");
    const p = j.packs.find((x: { id: string }) => x.id === "audio-sa3");
    expect(p).toBeTruthy();
    expect(p.allInstalled).toBe(true);
    expect(p.command).toBeNull();
    expect(p.optionalBytes).toBe(9222116660);
    expect(p.licenseNote).toMatch(/\$1M/);
    expect(p.nonCommercial).toBe(true);
    expect(p.licenses.every((l: { commercial: string }) => l.commercial === "restricted")).toBe(true);
    const base = p.files.find((f: { dest: string }) => f.dest.endsWith("medium_base.safetensors"));
    expect(base).toMatchObject({ optional: true, installed: false });
    expect(base.hfCommand).toContain("--revision ");
    // Installed packs are not preselected.
    expect(j.preselected).not.toContain("audio-sa3");
  });

  it("not installed: preselected on 16 GB with a pack-only command", async () => {
    listings.mockImplementation(async (types: string[]) =>
      Object.fromEntries(types.map((t) => [t, new Set()])),
    );
    const j = await (await GET(req())).json();
    const p = j.packs.find((x: { id: string }) => x.id === "audio-sa3");
    expect(p.verdict).toBe("fits");
    expect(p.command).toMatch(/--pack audio-sa3 /);
    expect(p.command).not.toContain("--use");
    expect(j.preselected).toContain("audio-sa3");
  });
});
