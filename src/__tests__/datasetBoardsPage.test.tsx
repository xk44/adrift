import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatasetBoardsPage } from "@/components/DatasetBoardsPage";
import { createMoodboard } from "@/lib/sref/moodboardClient";
import type { Moodboard } from "@/types";

const storeMock = vi.hoisted(() => ({
  activeNav: "create",
  styleVault: true,
}));

vi.mock("@/hooks/useIntegrations", () => ({
  useIntegrations: () => ({ styleVault: storeMock.styleVault, nevo: false }),
}));

vi.mock("@/store", () => ({
  useUIStore: (selector: (state: { activeNav: string }) => unknown) =>
    selector({ activeNav: storeMock.activeNav }),
}));

vi.mock("@/components/training/LoraRunPanel", () => ({
  LoraRunPanel: () => <div data-testid="lora-run-panel" />,
}));

function renderPage(kind: "character" | "style") {
  return renderToStaticMarkup(<DatasetBoardsPage kind={kind} />);
}

function renderDetailPage(kind: "character" | "style", board: Moodboard) {
  return renderToStaticMarkup(
    <DatasetBoardsPage
      kind={kind}
      initialBoards={[board]}
      initialSelectedId={board.id}
    />,
  );
}

describe("DatasetBoardsPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    storeMock.activeNav = "create";
    storeMock.styleVault = true;
  });

  it("renders empty state for kind character", () => {
    storeMock.activeNav = "characters";

    const html = renderPage("character");

    expect(html).toContain("No character datasets yet");
    expect(html).toContain("Create your first character dataset");
  });

  it("create board POSTs kind", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        ok: true,
        moodboard: {
          id: "board-1",
          name: "Hero",
          images: [],
          kind: "character",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await createMoodboard({
      name: "Hero",
      description: "Main character",
      images: [],
      kind: "character",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/moodboards",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Hero",
          description: "Main character",
          images: [],
          kind: "character",
        }),
      }),
    );
  });

  it("styles tab shows Auto-sort button while characters tab does not", () => {
    storeMock.activeNav = "styles";
    const stylesHtml = renderPage("style");

    storeMock.activeNav = "characters";
    const charactersHtml = renderPage("character");

    expect(stylesHtml).toContain("Auto-sort");
    expect(charactersHtml).not.toContain("Auto-sort");
  });

  it("renders caption badge title in detail view markup", () => {
    storeMock.activeNav = "characters";

    const html = renderDetailPage("character", {
      id: "board-1",
      name: "Hero",
      images: [
        {
          url: "/hero.png",
          weight: 1,
          caption: "a jewel-toned coat",
          captionSource: "manual",
        },
      ],
      kind: "character",
    });

    expect(html).toContain('title="a jewel-toned coat"');
  });

  it("renders Auto-caption button in detail view markup", () => {
    storeMock.activeNav = "styles";

    const html = renderDetailPage("style", {
      id: "board-1",
      name: "Painterly",
      images: [{ url: "/style.png", weight: 1 }],
      kind: "style",
    });

    expect(html).toContain("Auto-caption");
  });

  it("hides the StyleVault-only actions when StyleVault is not configured", () => {
    storeMock.styleVault = false;
    storeMock.activeNav = "styles";
    const listHtml = renderPage("style");
    const detailHtml = renderDetailPage("style", {
      id: "board-1",
      name: "Painterly",
      images: [{ url: "/style.png", weight: 1 }],
      kind: "style",
    });

    expect(listHtml).not.toContain("Auto-sort");
    expect(listHtml).not.toContain("Import from StyleVault");
    expect(detailHtml).not.toContain("Auto-caption");
    expect(detailHtml).toContain("Delete dataset");
  });

  it("renders caption knobs and per-image selection in the detail view", () => {
    storeMock.activeNav = "styles";
    const html = renderDetailPage("style", {
      id: "board-1",
      name: "Painterly",
      images: [{ url: "/style.png", weight: 1, caption: "oil paint" }],
      kind: "style",
    });

    expect(html).toContain('data-testid="dataset-caption-panel"');
    expect(html).toContain("Caption dropout percent");
    expect(html).toContain("Select image 1 for caption edits");
    expect(html).toContain("metadata.jsonl");
  });
});
