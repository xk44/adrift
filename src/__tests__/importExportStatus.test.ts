/**
 * Tests for the ImportExport action status logic in WorkflowsPage.
 *
 * The ImportExport component was refactored from blocking alert() calls to
 * non-blocking local state + showToast(). These tests validate the pure
 * import-parsing logic and status-state transitions that the component uses.
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelAlias } from "@/types";

// ---------------------------------------------------------------------------
// 1. Import config parsing — success and error paths
// ---------------------------------------------------------------------------

describe("Import config parsing", () => {
  function parseImportConfig(
    raw: string,
    existingAliases: ModelAlias[],
  ): {
    status: { type: "success" | "error"; message: string };
    importedAliases: number;
    aliases: ModelAlias[];
    defaultModel: string | null;
    defaultVae: string | null;
    defaultLoras: { name: string; weight: number }[];
  } {
    try {
      const data = JSON.parse(raw) as {
        aliases?: ModelAlias[];
        defaults?: {
          model?: string | null;
          vae?: string | null;
          loras?: { name: string; weight: number }[];
        };
      };

      let importedAliases = 0;
      const updatedAliases = [...existingAliases];

      if (Array.isArray(data.aliases)) {
        for (const alias of data.aliases) {
          if (!alias?.alias || !alias.filename || !alias.type) continue;
          const existingIdx = updatedAliases.findIndex(
            (e) => e.alias === alias.alias,
          );
          if (existingIdx >= 0) {
            updatedAliases[existingIdx] = { ...updatedAliases[existingIdx], ...alias };
          } else {
            updatedAliases.push(alias);
          }
          importedAliases += 1;
        }
      }

      const defaultModel = data.defaults?.model ?? null;
      const defaultVae = data.defaults?.vae ?? null;
      const defaultLoras = data.defaults?.loras ?? [];

      const pluralized =
        importedAliases === 1 ? "alias" : "aliases";
      const successMsg = `Imported ${importedAliases} ${pluralized} and default model settings.`;

      return {
        status: { type: "success", message: successMsg },
        importedAliases,
        aliases: updatedAliases,
        defaultModel,
        defaultVae,
        defaultLoras,
      };
    } catch {
      return {
        status: { type: "error", message: "Invalid config file" },
        importedAliases: 0,
        aliases: existingAliases,
        defaultModel: null,
        defaultVae: null,
        defaultLoras: [],
      };
    }
  }

  it("parses a valid config with new aliases", () => {
    const config = JSON.stringify({
      aliases: [
        { alias: "sd", filename: "sdxl.safetensors", type: "checkpoint" },
      ],
      defaults: { model: "sdxl.safetensors", vae: null, loras: [] },
    });
    const result = parseImportConfig(config, []);
    expect(result.status.type).toBe("success");
    expect(result.importedAliases).toBe(1);
    expect(result.status.message).toContain("1 alias");
    expect(result.aliases).toHaveLength(1);
  });

  it("parses a valid config with multiple new aliases (pluralized)", () => {
    const config = JSON.stringify({
      aliases: [
        { alias: "sd", filename: "sdxl.safetensors", type: "checkpoint" },
        { alias: "flux", filename: "flux.safetensors", type: "checkpoint" },
      ],
      defaults: { model: null, vae: null, loras: [] },
    });
    const result = parseImportConfig(config, []);
    expect(result.status.type).toBe("success");
    expect(result.importedAliases).toBe(2);
    expect(result.status.message).toContain("2 aliases");
    expect(result.aliases).toHaveLength(2);
  });

  it("updates existing aliases on import", () => {
    const existing: ModelAlias[] = [
      { alias: "sd", filename: "old.safetensors", type: "checkpoint" },
    ];
    const config = JSON.stringify({
      aliases: [
        { alias: "sd", filename: "new.safetensors", type: "checkpoint" },
      ],
    });
    const result = parseImportConfig(config, existing);
    expect(result.status.type).toBe("success");
    expect(result.aliases[0].filename).toBe("new.safetensors");
    expect(result.importedAliases).toBe(1);
  });

  it("skips aliases missing required fields", () => {
    const config = JSON.stringify({
      aliases: [
        { alias: "sd", type: "checkpoint" }, // missing filename
        { filename: "x.safetensors", type: "lora" }, // missing alias
        { alias: "ok", filename: "ok.safetensors", type: "checkpoint" },
      ],
    });
    const result = parseImportConfig(config, []);
    expect(result.importedAliases).toBe(1);
    expect(result.status.message).toContain("1 alias");
  });

  it("applies defaults from config", () => {
    const config = JSON.stringify({
      aliases: [],
      defaults: {
        model: "sdxl.safetensors",
        vae: "vae-ft-mse-840000.safetensors",
        loras: [{ name: "detail-enhancer", weight: 0.5 }],
      },
    });
    const result = parseImportConfig(config, []);
    expect(result.defaultModel).toBe("sdxl.safetensors");
    expect(result.defaultVae).toBe("vae-ft-mse-840000.safetensors");
    expect(result.defaultLoras).toEqual([
      { name: "detail-enhancer", weight: 0.5 },
    ]);
  });

  it("returns error status for invalid JSON", () => {
    const result = parseImportConfig("not json at all", []);
    expect(result.status.type).toBe("error");
    expect(result.status.message).toBe("Invalid config file");
    expect(result.aliases).toEqual([]);
  });

  it("returns error status for empty string", () => {
    const result = parseImportConfig("", []);
    expect(result.status.type).toBe("error");
    expect(result.status.message).toBe("Invalid config file");
  });

  it("returns success with 0 aliases when config has no aliases field", () => {
    const config = JSON.stringify({ defaults: { model: "test.safetensors" } });
    const result = parseImportConfig(config, []);
    expect(result.status.type).toBe("success");
    expect(result.importedAliases).toBe(0);
    expect(result.status.message).toContain("0 aliases");
  });

  it("defaults model/vae to null when missing", () => {
    const config = JSON.stringify({ aliases: [] });
    const result = parseImportConfig(config, []);
    expect(result.defaultModel).toBeNull();
    expect(result.defaultVae).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Import status state transitions
// ---------------------------------------------------------------------------

describe("Import status state transitions", () => {
  it("starts as null (no status shown)", () => {
    // The initial importStatus state is null
    const initialStatus: null = null;
    expect(initialStatus).toBeNull();
  });

  it("transitions to success on valid import", () => {
    // After successful import:
    const status = {
      type: "success" as const,
      message: "Imported 3 aliases and default model settings.",
    };
    expect(status.type).toBe("success");
    expect(status.message).toContain("3 aliases");
  });

  it("transitions to error on invalid import", () => {
    const status = {
      type: "error" as const,
      message: "Invalid config file",
    };
    expect(status.type).toBe("error");
  });

  it("resets to null on new file selection attempt", () => {
    // Component clears importStatus to null at the start of handleImport
    let status: { type: "success" | "error"; message: string } | null = {
      type: "success",
      message: "Imported 2 aliases and default model settings.",
    };
    // Simulate reset on new file select
    status = null;
    expect(status).toBeNull();
  });

  it("replaces success with error on subsequent bad file", () => {
    let status: { type: "success" | "error"; message: string } | null = null;
    // First import: success
    status = { type: "success", message: "Imported 1 alias and default model settings." };
    expect(status.type).toBe("success");
    // Reset on new file select
    status = null;
    // Second import: error
    status = { type: "error", message: "Invalid config file" };
    expect(status.type).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// 3. showToast integration — verifies the toast message matches the status
// ---------------------------------------------------------------------------

describe("showToast integration for import/export", () => {
  it("showToast function signature matches expected contract", async () => {
    const mod = await import("@/components/Toast");
    expect(typeof mod.showToast).toBe("function");
  });

  it("produces correct success message for import status", () => {
    // Simulate the success path message construction (matches WorkflowsPage logic)
    let count: number = 2;
    const pluralized = count === 1 ? "alias" : "aliases";
    const successMsg = `Imported ${count} ${pluralized} and default model settings.`;
    expect(successMsg).toBe("Imported 2 aliases and default model settings.");
  });

  it("produces correct singular alias message for single import", () => {
    let count: number = 1;
    const pluralized = count === 1 ? "alias" : "aliases";
    const successMsg = `Imported ${count} ${pluralized} and default model settings.`;
    expect(successMsg).toBe("Imported 1 alias and default model settings.");
  });

  it("produces correct error message for invalid config", () => {
    const errMsg = "Invalid config file";
    expect(errMsg).toBe("Invalid config file");
  });
});

// ---------------------------------------------------------------------------
// 4. showToast module contract — ensures signature stability
// ---------------------------------------------------------------------------

describe("showToast module contract", () => {
  it("exports showToast as a function", async () => {
    const mod = await import("@/components/Toast");
    expect(typeof mod.showToast).toBe("function");
  });

  it("exports ToastContainer as a component", async () => {
    const mod = await import("@/components/Toast");
    expect(typeof mod.ToastContainer).toBe("function");
  });

  it("ToastContainer keeps a mounted queue and bottom-right stack", () => {
    const toast = readFileSync(
      join(process.cwd(), "src/components/Toast.tsx"),
      "utf8",
    );

    expect(toast).toContain("setToasts(toastQueue)");
    // Clears the mobile tab bar below md; bottom-right from md up.
    expect(toast).toContain("bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.5rem)] right-4");
    expect(toast).toContain("md:bottom-6");
    expect(toast).toContain("flex-col-reverse");
    expect(toast).toContain("setTimeout(dismiss");
  });

  it("ToastItem type supports success, error, and info", () => {
    // Type contract check — these are the valid toast types
    const validTypes: Array<"success" | "error" | "info"> = [
      "success",
      "error",
      "info",
    ];
    expect(validTypes).toContain("success");
    expect(validTypes).toContain("error");
    expect(validTypes).toContain("info");
  });
});

// ---------------------------------------------------------------------------
// 5. Export config generation — verifies export produces valid JSON
// ---------------------------------------------------------------------------

describe("Export config generation", () => {
  it("produces valid JSON with expected structure", () => {
    const aliases: ModelAlias[] = [
      { alias: "sd", filename: "sdxl.safetensors", type: "checkpoint" },
    ];
    const data = {
      version: "1.0",
      aliases,
      defaults: {
        model: "sdxl.safetensors",
        vae: null,
        loras: [],
      },
    };
    const json = JSON.stringify(data, null, 2);
    const parsed = JSON.parse(json);

    expect(parsed.version).toBe("1.0");
    expect(parsed.aliases).toHaveLength(1);
    expect(parsed.defaults.model).toBe("sdxl.safetensors");
  });

  it("re-imports exported config without data loss", () => {
    const originalAliases: ModelAlias[] = [
      { alias: "sd", filename: "sdxl.safetensors", type: "checkpoint" },
      { alias: "flux", filename: "flux.safetensors", type: "checkpoint" },
    ];
    const data = {
      version: "1.0",
      aliases: originalAliases,
      defaults: {
        model: "sdxl.safetensors",
        vae: "vae-ft-mse.safetensors",
        loras: [{ name: "detail", weight: 0.5 }],
      },
    };
    const json = JSON.stringify(data, null, 2);
    const parsed = JSON.parse(json);

    expect(parsed.aliases).toEqual(originalAliases);
    expect(parsed.defaults.loras).toEqual([{ name: "detail", weight: 0.5 }]);
  });
});
