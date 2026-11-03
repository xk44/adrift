/** B15: stopWarm only signals a PID whose command line is the warm ComfyUI. */
import { describe, expect, it } from "vitest";
import { isWarmProcess } from "@/lib/comfy/warmBackend";

const cmd = (c: string) => () => c;

describe("isWarmProcess", () => {
  it("accepts the exec'd ComfyUI on the warm port", () => {
    expect(
      isWarmProcess(1, "8189", cmd("/opt/venv/bin/python /opt/ComfyUI/main.py --listen 127.0.0.1 --port 8189 --enable-cors-header")),
    ).toBe(true);
    expect(isWarmProcess(1, "8189", cmd("python main.py --port=8189"))).toBe(true);
  });

  it("accepts the launcher script before it execs", () => {
    expect(isWarmProcess(1, "8189", cmd("/bin/bash /app/scripts/start-comfyui.sh"))).toBe(true);
  });

  it("rejects a reused PID belonging to something else", () => {
    expect(isWarmProcess(1, "8189", cmd("/usr/sbin/sshd -D"))).toBe(false);
    expect(isWarmProcess(1, "8189", cmd("node server.js --port 8189"))).toBe(false);
  });

  it("rejects the main ComfyUI on a different port", () => {
    expect(isWarmProcess(1, "8189", cmd("python main.py --port 8188"))).toBe(false);
    expect(isWarmProcess(1, "8189", cmd("python main.py --port 81890"))).toBe(false);
  });

  it("refuses when the command can't be read", () => {
    expect(
      isWarmProcess(1, "8189", () => {
        throw new Error("no such process");
      }),
    ).toBe(false);
  });
});
