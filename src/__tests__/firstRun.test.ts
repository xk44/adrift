/**
 * First-run checklist: command builders, row states and the server-side
 * "does Create have a model" assessment (pure; no ComfyUI).
 */
import { describe, expect, it } from "vitest";
import {
  SDXL_STARTER,
  checklistRows,
  comfyMainCommand,
  describeMissing,
  formatBytes,
  isLocalComfyUrl,
  parseFirstRunStatus,
  abbreviateHome,
  shellQuote,
  startComfyCommand,
  starterDownloadCommand,
  type FirstRunStatus,
} from "@/lib/setup/firstRun";
import { assessCreateModel } from "@/lib/setup/firstRunCheck";
import type { Workflow } from "@/types";

function status(over: Partial<FirstRunStatus> = {}): FirstRunStatus {
  return {
    ok: true,
    comfy: { reachable: true, url: "http://127.0.0.1:8188" },
    comfyRoot: "/srv/ComfyUI",
    createModel: { state: "ok", packId: "sdxl", packName: "SDXL", missing: [] },
    ...over,
  };
}

describe("first-run commands", () => {
  it("quotes only when needed", () => {
    expect(shellQuote("/srv/ComfyUI")).toBe("/srv/ComfyUI");
    expect(shellQuote("/home/me/My Comfy")).toBe("'/home/me/My Comfy'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("start command: defaults stay implicit", () => {
    expect(
      startComfyCommand({
        comfyRoot: "/srv/ComfyUI",
        comfyUrl: "http://127.0.0.1:8188",
        origin: "http://localhost:3000",
      }),
    ).toBe("COMFY_DIR=/srv/ComfyUI scripts/start-comfyui.sh");
  });

  it("start command: placeholder root, custom port and origin", () => {
    expect(
      startComfyCommand({
        comfyRoot: "",
        comfyUrl: "http://127.0.0.1:18188",
        origin: "http://127.0.0.1:3121",
      }),
    ).toBe(
      "COMFY_DIR=~/ComfyUI COMFY_PORT=18188 CJ_ORIGIN=http://127.0.0.1:3121 scripts/start-comfyui.sh",
    );
  });

  it("start command never shows the home folder path", () => {
    expect(
      startComfyCommand({ comfyRoot: "/Users/ana/Projects/ComfyUI" }),
    ).toBe("COMFY_DIR=~/Projects/ComfyUI scripts/start-comfyui.sh");
    expect(startComfyCommand({ comfyRoot: "/home/ana/My Comfy" })).toBe(
      "COMFY_DIR=~/'My Comfy' scripts/start-comfyui.sh",
    );
    expect(abbreviateHome("C:\\Users\\ana\\ComfyUI")).toBe(
      "%USERPROFILE%\\ComfyUI",
    );
    expect(abbreviateHome("/srv/ComfyUI")).toBe("/srv/ComfyUI");
    expect(abbreviateHome("/Users/ana")).toBe("~");
  });

  it("main.py fallback carries port and CORS origin", () => {
    expect(
      comfyMainCommand({
        comfyUrl: "http://localhost:18188",
        origin: "http://localhost:3000",
      }),
    ).toBe(
      "python main.py --listen 127.0.0.1 --port 18188 --enable-cors-header http://localhost:3000",
    );
    expect(comfyMainCommand({})).toContain("--port 8188");
  });

  it("knows local from remote ComfyUI", () => {
    expect(isLocalComfyUrl("http://127.0.0.1:8188")).toBe(true);
    expect(isLocalComfyUrl("http://localhost:8188")).toBe(true);
    expect(isLocalComfyUrl("http://[::1]:8188")).toBe(true);
    expect(isLocalComfyUrl(undefined)).toBe(true);
    expect(isLocalComfyUrl("http://192.168.1.20:8188")).toBe(false);
  });

  it("starter download is pinned, resumable and lands in models/checkpoints", () => {
    const cmd = starterDownloadCommand(SDXL_STARTER, "/srv/ComfyUI/");
    expect(cmd).toBe(
      `curl -L -C - -o /srv/ComfyUI/models/checkpoints/sd_xl_base_1.0.safetensors ${SDXL_STARTER.url}`,
    );
    expect(SDXL_STARTER.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
    expect(starterDownloadCommand(SDXL_STARTER, "C:\\ComfyUI")).toContain(
      "'C:\\ComfyUI\\models\\checkpoints\\sd_xl_base_1.0.safetensors'",
    );
    expect(starterDownloadCommand(SDXL_STARTER)).toContain(
      "/path/to/ComfyUI/models/checkpoints/",
    );
  });

  it("formats sizes and missing items in plain words", () => {
    expect(formatBytes(SDXL_STARTER.sizeBytes)).toBe("6.9 GB");
    expect(formatBytes(5_200_000)).toBe("5 MB");
    expect(describeMissing("checkpoints/*")).toBe(
      "a model in models/checkpoints",
    );
    expect(describeMissing("node:KSampler")).toBe("the KSampler node");
    expect(describeMissing("checkpoints/x.safetensors")).toBe(
      "models/checkpoints/x.safetensors",
    );
  });
});

describe("checklistRows", () => {
  it("nothing known yet: all rows unknown", () => {
    expect(checklistRows(null).map((r) => r.state)).toEqual([
      "unknown",
      "unknown",
      "unknown",
    ]);
  });

  it("offline: ComfyUI fails, later rows can't be judged", () => {
    const rows = checklistRows(
      status({
        comfy: { reachable: false, url: "" },
        createModel: {
          state: "unknown",
          packId: "",
          packName: "",
          missing: [],
        },
      }),
    );
    expect(rows.map((r) => r.state)).toEqual(["fail", "unknown", "unknown"]);
  });

  it("no model: model row fails", () => {
    const rows = checklistRows(
      status({
        createModel: {
          state: "fail",
          packId: "sdxl",
          packName: "SDXL",
          missing: ["checkpoints/*"],
        },
      }),
    );
    expect(rows.map((r) => r.state)).toEqual(["ok", "fail", "unknown"]);
  });

  it("all good: sample prompt is the next step", () => {
    expect(checklistRows(status()).map((r) => r.state)).toEqual([
      "ok",
      "ok",
      "todo",
    ]);
  });
});

describe("parseFirstRunStatus", () => {
  it("accepts the route body and rejects junk", () => {
    expect(parseFirstRunStatus(status())).toEqual(status());
    expect(parseFirstRunStatus(null)).toBeNull();
    expect(parseFirstRunStatus({ ok: false })).toBeNull();
    expect(
      parseFirstRunStatus({ ok: true, comfy: { reachable: "yes" } }),
    ).toBeNull();
    expect(
      parseFirstRunStatus({
        ok: true,
        comfy: { reachable: true },
        createModel: {},
      }),
    ).toBeNull();
  });
});

describe("assessCreateModel", () => {
  const t2i = {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "" } },
    "3": { class_type: "KSampler", inputs: { model: ["4", 0] } },
  } as unknown as Workflow;
  const info = (ckpts: string[], legacy = true) => ({
    CheckpointLoaderSimple: {
      input: {
        required: {
          ckpt_name: legacy ? [ckpts] : ["COMBO", { options: ckpts }],
        },
      },
    },
    KSampler: { input: { required: {} } },
    UNETLoader: { input: { required: { unet_name: [["flux.safetensors"]] } } },
  });

  it("empty checkpoint list: any checkpoint is missing", () => {
    expect(assessCreateModel(t2i, info([]))).toEqual({
      state: "fail",
      missing: ["checkpoints/*"],
    });
  });

  it("uses the first checkpoint, legacy and COMBO formats", () => {
    expect(
      assessCreateModel(t2i, info(["a.safetensors", "b.safetensors"])),
    ).toEqual({
      state: "ok",
      using: "a.safetensors",
      missing: [],
    });
    expect(assessCreateModel(t2i, info(["c.safetensors"], false)).using).toBe(
      "c.safetensors",
    );
  });

  it("COMFY_DEFAULT_CHECKPOINT must be installed", () => {
    expect(
      assessCreateModel(t2i, info(["a.safetensors"]), {
        preferredCheckpoint: "sdxl/B.safetensors",
      }),
    ).toEqual({ state: "fail", missing: ["checkpoints/sdxl/B.safetensors"] });
    expect(
      assessCreateModel(t2i, info(["sdxl\\b.safetensors"]), {
        preferredCheckpoint: "sdxl/B.safetensors",
      }).state,
    ).toBe("ok");
  });

  it("a picked model is looked up in checkpoints and diffusion models", () => {
    expect(
      assessCreateModel(t2i, info(["a.safetensors"]), {
        pickedModel: "flux.safetensors",
      }),
    ).toEqual({ state: "ok", using: "flux.safetensors", missing: [] });
    expect(
      assessCreateModel(t2i, info(["a.safetensors"]), {
        pickedModel: "gone.safetensors",
      }),
    ).toEqual({ state: "fail", missing: ["checkpoints/gone.safetensors"] });
  });

  it("a missing node class is reported", () => {
    const res = assessCreateModel(t2i, {
      CheckpointLoaderSimple: info(["a"]).CheckpointLoaderSimple,
    });
    expect(res.state).toBe("fail");
    expect(res.missing).toContain("node:KSampler");
  });
});
