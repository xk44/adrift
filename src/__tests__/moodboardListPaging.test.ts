import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { Moodboard } from "@/types";

function board(i: number, kind?: Moodboard["kind"]): Moodboard {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    name: i % 2 ? `Grainy ${i}` : `Clean ${i}`,
    description: i === 4 ? "has GRAIN in description" : null,
    images: Array.from({ length: 10 }, (_, j) => ({ url: `/api/moodboards/upload?file=${i}-${j}.png`, weight: 1 })),
    createdAt: 1,
    updatedAt: 1,
    ...(kind ? { kind } : {}),
  };
}

async function loadGET(boards: Moodboard[]) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-mb-page-"));
  await fs.mkdir(path.join(tmp, "data"));
  await fs.writeFile(path.join(tmp, "data/moodboards.json"), JSON.stringify({ version: 1, moodboards: boards }));
  vi.resetModules();
  vi.spyOn(process, "cwd").mockReturnValue(tmp);
  vi.doMock("@/lib/env", () => ({
    env: { ADMIN_API_KEY: "", COMFY_HTTP_URL: "http://127.0.0.1:8188", STYLEVAULT_API_URL: "http://127.0.0.1:8000", NODE_ENV: "test" },
  }));
  return (await import("@/app/api/moodboards/route")).GET;
}

const get = (GET: (r: NextRequest) => Promise<Response>, qs: string) =>
  GET(new NextRequest(`http://localhost:3000/api/moodboards${qs}`)).then((r) => r.json());

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/moodboards paging", () => {
  const boards = [...Array.from({ length: 7 }, (_, i) => board(i)), board(7, "style")];

  it("is unchanged without paging params (no total/nextOffset, full images)", async () => {
    const body = await get(await loadGET(boards), "");
    expect(body.moodboards).toHaveLength(8);
    expect(body.total).toBeUndefined();
    expect(body.moodboards[0].images).toHaveLength(10);
  });

  it("pages with limit/offset and reports nextOffset", async () => {
    const GET = await loadGET(boards);
    const p1 = await get(GET, "?kind=moodboard&limit=3");
    expect(p1.total).toBe(7);
    expect(p1.nextOffset).toBe(3);
    const p3 = await get(GET, "?kind=moodboard&limit=3&offset=6");
    expect(p3.moodboards).toHaveLength(1);
    expect(p3.nextOffset).toBeNull();
  });

  it("searches name/description case-insensitively", async () => {
    const body = await get(await loadGET(boards), "?kind=moodboard&q=grain");
    expect(body.moodboards.map((m: Moodboard) => m.name).sort()).toEqual(["Clean 4", "Grainy 1", "Grainy 3", "Grainy 5"]);
  });

  it("summary trims images to 4 and keeps imageCount", async () => {
    const body = await get(await loadGET(boards), "?summary=1&limit=1");
    expect(body.moodboards[0].images).toHaveLength(4);
    expect(body.moodboards[0].imageCount).toBe(10);
  });

  it("fetches one full board by id, 404 otherwise", async () => {
    const GET = await loadGET(boards);
    const hit = await get(GET, `?id=${boards[2].id}&summary=1`);
    expect(hit.moodboard.name).toBe("Clean 2");
    expect(hit.moodboard.images).toHaveLength(10);
    const res = await GET(new NextRequest("http://localhost:3000/api/moodboards?id=nope"));
    expect(res.status).toBe(404);
  });

  it("clamps silly limits", async () => {
    const body = await get(await loadGET(boards), "?limit=-5&offset=abc");
    expect(body.moodboards).toHaveLength(1);
    expect(body.nextOffset).toBe(1);
  });
});
