import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { integrationsFromEnv } from "@/lib/integrations";
import { buildPaletteCommands } from "@/components/CommandPalette";
import { buildPromptOverflowItems } from "@/components/settings/promptControls";
import { buildToolCards } from "@/lib/tools/toolsPage";

const paletteDeps = {
  setActiveNav: vi.fn(),
  setStylesHubTab: vi.fn(),
  toggleSettings: vi.fn(),
  toggleTheme: vi.fn(),
  onClose: vi.fn(),
  onShowKeyboardHelp: vi.fn(),
  onDescribe: vi.fn(),
};

describe("optional integrations (StyleVault, NEvo)", () => {
  it("count as configured only when their URL is set explicitly", () => {
    expect(integrationsFromEnv({})).toEqual({ styleVault: false, nevo: false });
    expect(
      integrationsFromEnv({ STYLEVAULT_API_URL: "  ", NEVO_BACKEND_URL: "" }),
    ).toEqual({ styleVault: false, nevo: false });
    expect(
      integrationsFromEnv({
        STYLEVAULT_API_URL: "http://127.0.0.1:8000",
        NEVO_BACKEND_URL: "http://127.0.0.1:8791",
      }),
    ).toEqual({ styleVault: true, nevo: true });
  });

  it("GET /api/integrations reports the env", async () => {
    vi.stubEnv("STYLEVAULT_API_URL", "http://127.0.0.1:8000");
    vi.stubEnv("NEVO_BACKEND_URL", "");
    try {
      const { GET } = await import("@/app/api/integrations/route");
      const res = await GET(new NextRequest("http://127.0.0.1:3000/api/integrations"));
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.integrations).toEqual({ styleVault: true, nevo: false });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("Describe leaves the palette and the tool grid without StyleVault", () => {
    const ids = (on: boolean) =>
      buildPaletteCommands({ ...paletteDeps, describeAvailable: on }).map((c) => c.id);
    expect(ids(true)).toContain("describe-image");
    expect(ids(false)).not.toContain("describe-image");

    const keys = (on: boolean) =>
      buildToolCards({
        catalog: null,
        packIds: null,
        editLoras: null,
        describeAvailable: on,
      }).map((c) => c.key);
    expect(keys(true)).toContain("action:describe");
    expect(keys(false)).not.toContain("action:describe");
  });

  it("the NEvo menu item needs the NEvo backend", () => {
    const ids = (nevoAvailable: boolean) =>
      buildPromptOverflowItems({
        hasHistory: false,
        runNext: false,
        nevoEnabled: false,
        nevoAvailable,
      }).map((i) => i.id);
    expect(ids(true)).toContain("nevo");
    expect(ids(false)).not.toContain("nevo");
    expect(ids(false)).toContain("import");
  });
});
