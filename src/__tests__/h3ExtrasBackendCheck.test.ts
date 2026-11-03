import { beforeEach, describe, expect, it, vi } from "vitest";

const remote = vi.hoisted(() => ({
  loras: null as Set<string> | null,
  unets: null as Set<string> | null,
  disk: new Set<string>(),
}));

vi.mock("@/lib/comfy/backendModels", () => ({
  backendLoraFiles: vi.fn(async () => remote.loras),
  backendUnetFiles: vi.fn(async () => remote.unets),
}));
vi.mock("@/lib/tools/editTools", () => ({
  listModelFiles: vi.fn(async () => remote.disk),
}));

import { missingH3ExtraLoras } from "@/lib/oj/mossImageDefaults";

const MOTION = "Motion_Repair_V2.safetensors";
const params = { motionRepair: true };

describe("H3 extras are checked where the job runs", () => {
  beforeEach(() => {
    remote.loras = null;
    remote.unets = null;
    remote.disk = new Set();
  });

  it("trusts the main backend's object_info over the local disk", async () => {
    remote.loras = new Set([MOTION.toLowerCase()]);
    const miss = await missingH3ExtraLoras("/nowhere", params, undefined, {
      backendUrl: "http://lan-box:8188",
    });
    expect(miss).toEqual([]);
  });

  it("reports a file the backend lacks even if the local disk has it", async () => {
    remote.loras = new Set();
    remote.disk = new Set([MOTION.toLowerCase()]);
    const miss = await missingH3ExtraLoras("/nowhere", params, undefined, {
      backendUrl: "http://lan-box:8188",
    });
    expect(miss).toEqual([`loras/${MOTION}`]);
  });

  it("falls back to the local folder when the main backend is unreachable", async () => {
    remote.disk = new Set([MOTION.toLowerCase()]);
    const miss = await missingH3ExtraLoras("/nowhere", params, undefined, {
      backendUrl: "http://lan-box:8188",
    });
    expect(miss).toEqual([]);
  });

  it("a strict (routed video) host that is unreachable counts as missing", async () => {
    remote.disk = new Set([MOTION.toLowerCase()]);
    const miss = await missingH3ExtraLoras("/nowhere", params, undefined, {
      backendUrl: "http://video-box:8188",
      strict: true,
    });
    expect(miss).toEqual([`loras/${MOTION}`]);
  });

  it("no host: local folder only", async () => {
    remote.loras = new Set([MOTION.toLowerCase()]);
    const miss = await missingH3ExtraLoras("/nowhere", params);
    expect(miss).toEqual([`loras/${MOTION}`]);
  });
});
