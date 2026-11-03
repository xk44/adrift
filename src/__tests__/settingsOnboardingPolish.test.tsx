/**
 * Settings + setup wizard polish: actionable connection errors, folder
 * messages that say what to do, and no dead ends (Done step, System card,
 * main ComfyUI row).
 */
import { readFileSync } from "fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  localProbeFailure,
  probeComfy,
  type ProbeResult,
} from "@/lib/onboarding/comfyProbe";
import { checkDir } from "@/lib/paths/validateDir";
import { systemErrorText } from "@/components/settings/SystemCard";

const src = (p: string) =>
  readFileSync(path.resolve(__dirname, "..", p), "utf8");

/** What undici's fetch throws: TypeError("fetch failed") with a coded cause. */
function netError(code: string): () => never {
  return () => {
    const e = new TypeError("fetch failed") as TypeError & { cause: unknown };
    e.cause = Object.assign(new Error(code), { code });
    throw e;
  };
}

describe("probeComfy: actionable network errors", () => {
  it.each([
    ["ENOTFOUND", /name wasn't found.*IP address/],
    ["EAI_AGAIN", /name wasn't found/],
    ["ECONNREFUSED", /nothing is listening on that port/],
    ["EHOSTUNREACH", /Can't reach that computer/],
    ["ENETUNREACH", /same network/],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", /certificate isn't trusted/],
    ["ERR_TLS_CERT_ALTNAME_INVALID", /certificate/],
    ["ECONNRESET", /try http:\/\//],
  ])(
    "%s gets its own advice and keeps code 'unreachable'",
    async (code, re) => {
      const r = await probeComfy(
        "http://h:8188",
        null,
        vi.fn(netError(code)) as never,
      );
      expect(r).toMatchObject({ ok: false, code: "unreachable" });
      expect(!r.ok && r.error).toMatch(re);
    },
  );

  it("an unknown cause falls back to the general message", async () => {
    const r = await probeComfy(
      "http://h:8188",
      null,
      vi.fn(netError("EWHATEVER")) as never,
    );
    expect(!r.ok && r.error).toMatch(/Is ComfyUI running/);
  });
});

describe("localProbeFailure", () => {
  const fail = (code: "unreachable" | "timeout" | "auth"): ProbeResult => ({
    ok: false,
    url: "http://127.0.0.1:8000",
    code,
    error: "x",
  });

  it("explains 'This computer' without the other-computer --listen hint", () => {
    for (const code of ["unreachable", "timeout"] as const) {
      const r = localProbeFailure(fail(code));
      expect(!r.ok && r.error).toMatch(/on this computer.*8188 and 8000/);
      expect(!r.ok && r.error).not.toMatch(/--listen/);
      expect(r).toMatchObject({ code });
    }
  });

  it("leaves specific failures (auth etc.) alone", () => {
    expect(localProbeFailure(fail("auth"))).toMatchObject({ error: "x" });
  });

  it("the test route uses it for the probeLocal path", () => {
    expect(src("app/api/settings/comfy-connection/test/route.ts")).toMatch(
      /localProbeFailure\(result\)/,
    );
  });
});

describe("folder checks say what to do", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-polish-"));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("a missing ComfyUI folder suggests a fix", () => {
    const r = checkDir("comfyRoot", path.join(root, "nope"), {
      comfyLocal: true,
    });
    expect(r.status).toBe("error");
    expect(r.reason).toMatch(/Folder not found\. Check the spelling/);
  });

  it("a folder without main.py says which folder to pick", () => {
    const r = checkDir("comfyRoot", root, { comfyLocal: true });
    expect(r.status).toBe("warn");
    expect(r.reason).toMatch(/Pick the folder that has main\.py in it/);
  });
});

describe("no dead ends", () => {
  it("System card turns 'ComfyUI unreachable' into plain advice", () => {
    expect(systemErrorText("ComfyUI unreachable")).toMatch(
      /Can't reach ComfyUI\. Make sure it's running/,
    );
    expect(systemErrorText("HTTP 418")).toMatch(/HTTP 418.*Try again/);
    expect(src("components/settings/SystemCard.tsx")).toMatch(
      /openOnboarding\("connect"\)[\s\S]*Set up connection/,
    );
  });

  it("Done step offers Connect ComfyUI instead of a disabled Try a prompt", () => {
    const w = src("components/onboarding/OnboardingWizard.tsx");
    expect(w).toMatch(/onClick=\{\(\) => setStep\("connect"\)\}/);
    expect(w).toContain("Connect ComfyUI");
    expect(w).not.toMatch(/disabled=\{!status\?\.reachable\}/);
    expect(w).toContain('data-testid="onboarding-next-step"');
  });

  it("footer Next with 'I don't have ComfyUI yet' continues without it", () => {
    const w = src("components/onboarding/OnboardingWizard.tsx");
    expect(w).toMatch(
      /step === "connect" && connectChoice === "none"\)\s*return continueWithout\(\)/,
    );
    expect(w).toContain("onChoiceChange={setConnectChoice}");
    expect(src("components/onboarding/ConnectStep.tsx")).toMatch(
      /onChoiceChange\?\.\(choice\)/,
    );
  });

  it("the main ComfyUI row can change its address", () => {
    const s = src("components/settings/ComfyInstancesSettings.tsx");
    expect(s).toMatch(
      /row\.primary && row\.source !== "env" && !compact[\s\S]*openOnboarding\("connect"\)[\s\S]*Change address/,
    );
  });
});

describe("connect step copy", () => {
  const c = src("components/onboarding/ConnectStep.tsx");

  it("errors render before the optional sections, advanced errors inside", () => {
    const err = c.indexOf("{error && (");
    expect(err).toBeGreaterThan(0);
    expect(err).toBeLessThan(c.indexOf("I know what I&apos;m doing"));
    expect(c.indexOf("{advError && (")).toBeLessThan(
      c.indexOf("Add another machine"),
    );
  });

  it("uses a hostname placeholder, not a LAN IP", () => {
    expect(c).not.toMatch(/192\.168\./);
    expect(c).toContain("my-pc.local:8188");
  });

  it("packs step explains what models are", () => {
    expect(src("components/onboarding/PacksStep.tsx")).toMatch(
      /Models are the large files ComfyUI uses/,
    );
  });
});
