/**
 * Setup wizard deep links (openOnboarding("packs", { focus })), first-run
 * step choice, the insecure-address acknowledgement, the Connect radio group
 * keys, and the Character pill's refresh / Anima override UI.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { openOnboarding, useOnboardingStore } from "@/store/onboardingStore";
import { PacksStep } from "@/components/onboarding/PacksStep";
import type { PacksResponse, PackView } from "@/components/onboarding/api";
import { firstRunStep } from "@/components/onboarding/firstRun";
import { nextChoice } from "@/components/onboarding/ConnectStep";
import {
  INSECURE_HTTP_WARNING,
  insecureUrlWarning,
  normalizeComfyUrl,
} from "@/lib/onboarding/comfyUrl";
import { resolveAllPacks, STARTER_PACKS } from "@/lib/onboarding/starterPacks";
import { profileFromSystemStats } from "@/lib/models/compat";
import { CharacterPicker } from "@/components/characters/CharacterPicker";

const src = (p: string) =>
  readFileSync(path.resolve(__dirname, "..", p), "utf8");

const GiB = 1024 ** 3;
const SMALL_GPU = profileFromSystemStats({
  system: { os: "linux", ram_total: 32 * GiB },
  devices: [
    {
      name: "cuda:0 NVIDIA GeForce RTX 3060 Ti",
      type: "cuda",
      vram_total: 8 * GiB,
    },
  ],
})!;

function packsResponse(): PacksResponse {
  const packs: PackView[] = resolveAllPacks(SMALL_GPU, null).map((p) => ({
    ...p,
    command: null,
    files: p.files.map((f) => ({ ...f, hfCommand: null })),
  }));
  return {
    ok: true,
    connected: true,
    profile: SMALL_GPU,
    tier: "le8",
    tierLabel: "8 GB",
    installedKnown: true,
    comfyDir: "/path/to/ComfyUI",
    comfyDirKnown: false,
    preselected: [...STARTER_PACKS.tiers.le8],
    packs,
  };
}

const noop = () => {};

describe("openOnboarding focus (D10 / G4)", () => {
  afterEach(() => useOnboardingStore.getState().close());

  it("carries the focused pack and opens on the Models step", () => {
    openOnboarding("packs", { focus: "audio-sa3" });
    const s = useOnboardingStore.getState();
    expect(s).toMatchObject({ open: true, step: "packs", focus: "audio-sa3" });
  });

  it("close and a plain open drop the focus", () => {
    openOnboarding("packs", { focus: "audio-sa3" });
    useOnboardingStore.getState().close();
    expect(useOnboardingStore.getState().focus).toBeNull();
    openOnboarding("packs", { focus: "audio-sa3" });
    openOnboarding();
    expect(useOnboardingStore.getState()).toMatchObject({
      step: "connect",
      focus: null,
    });
  });

  it("the SA3 hint deep-links to its pack", () => {
    expect(src("components/tools/Sa3PackHint.tsx")).toContain(
      'openOnboarding("packs", { focus: "audio-sa3" })',
    );
    expect(src("components/onboarding/OnboardingWizard.tsx")).toMatch(
      /focus=\{focus\}/,
    );
  });
});

describe("PacksStep focus", () => {
  it("an off-tier pack is hidden by default (the D10 bug)", () => {
    const data = packsResponse();
    expect(data.preselected).not.toContain("audio-sa3");
    const html = renderToStaticMarkup(
      <PacksStep
        data={data}
        loading={false}
        onReload={noop}
        selected={data.preselected}
        onSelect={noop}
      />,
    );
    expect(html).not.toContain('id="pack-card-audio-sa3"');
    expect(html).toMatch(/Show all \d+ packs/);
  });

  it("focus shows every pack, including the focused one", () => {
    const data = packsResponse();
    const html = renderToStaticMarkup(
      <PacksStep
        data={data}
        loading={false}
        onReload={noop}
        selected={data.preselected}
        onSelect={noop}
        focus="audio-sa3"
      />,
    );
    expect(html).toContain('id="pack-card-audio-sa3"');
    for (const p of data.packs)
      expect(html).toContain(`id="pack-card-${p.id}"`);
    expect(html).not.toMatch(/Show all \d+ packs/);
  });

  it("an unknown focus id changes nothing", () => {
    const data = packsResponse();
    const html = renderToStaticMarkup(
      <PacksStep
        data={data}
        loading={false}
        onReload={noop}
        selected={data.preselected}
        onSelect={noop}
        focus="no-such-pack"
      />,
    );
    expect(html).toMatch(/Show all \d+ packs/);
  });
});

describe("firstRunStep (G1)", () => {
  it("reachable ComfyUI opens on Folders, then the starter models", () => {
    expect(firstRunStep({ configured: true, reachable: true })).toBe("folders");
    expect(firstRunStep({ configured: false, reachable: true })).toBe("folders");
  });
  it("unreachable or unconfigured starts at Connect; unknown opens nothing", () => {
    expect(firstRunStep({ configured: true, reachable: false })).toBe(
      "connect",
    );
    expect(firstRunStep({ configured: false, reachable: false })).toBe(
      "connect",
    );
    expect(firstRunStep(null)).toBeNull();
  });
  it("the host uses it", () => {
    expect(src("components/onboarding/OnboardingHost.tsx")).toContain(
      "firstRunStep(latest)",
    );
  });
});

describe("insecure address acknowledgement (G2)", () => {
  it("plain http to a public host warns in every mode", () => {
    for (const mode of ["lan", "wan", "local"] as const) {
      const r = normalizeComfyUrl("http://203.0.113.5:8188", mode);
      expect(r.ok && r.warning, mode).toBe(INSECURE_HTTP_WARNING);
      expect(insecureUrlWarning("http://203.0.113.5:8188", mode)).toBe(
        INSECURE_HTTP_WARNING,
      );
    }
  });
  it("private hosts, https and invalid input don't", () => {
    expect(insecureUrlWarning("http://gpu-box.local:8188", "lan")).toBeNull();
    expect(insecureUrlWarning("10.0.0.5:8188", "lan")).toBeNull();
    expect(insecureUrlWarning("https://203.0.113.5", "wan")).toBeNull();
    expect(insecureUrlWarning("", "wan")).toBeNull();
    expect(insecureUrlWarning("ftp://x", "wan")).toBeNull();
  });
  it("Save without testing is gated on the acknowledgement", () => {
    const c = src("components/onboarding/ConnectStep.tsx");
    expect(c).toContain("insecureUrlWarning(url, mode)");
    expect(c).toMatch(/disabled=\{disabled \|\| !url\.trim\(\) \|\| blocked\}/);
    // A server warning nobody acknowledged keeps the user on the step.
    expect(c).toContain(
      "if (r.warning && !acknowledged) return setSavedWarning(r.warning);",
    );
  });
});

describe("Connect radio group keys (G6)", () => {
  it("arrows wrap, Home/End jump, other keys are ignored", () => {
    expect(nextChoice("local", "ArrowRight")).toBe("lan");
    expect(nextChoice("local", "ArrowDown")).toBe("lan");
    expect(nextChoice("local", "ArrowLeft")).toBe("none");
    expect(nextChoice("none", "ArrowRight")).toBe("local");
    expect(nextChoice("wan", "ArrowUp")).toBe("lan");
    expect(nextChoice("wan", "Home")).toBe("local");
    expect(nextChoice("lan", "End")).toBe("none");
    expect(nextChoice("lan", "Tab")).toBeNull();
    expect(nextChoice("lan", "Enter")).toBeNull();
  });
  it("one tab stop: only the checked radio is tabbable", () => {
    expect(src("components/onboarding/ConnectStep.tsx")).toContain(
      "tabIndex={on ? 0 : -1}",
    );
  });
  it("the checklist dialog is a native modal", () => {
    const d = src("components/setup/SetupDialog.tsx");
    expect(d).toContain("<dialog");
    expect(d).toContain("showModal()");
    expect(d).toContain("First-run checklist");
  });
});

describe("Character pill (G5 / G7)", () => {
  it("the picker has a Refresh button and revalidates on open", () => {
    const html = renderToStaticMarkup(
      <CharacterPicker open onClose={noop} triggerId="pill" />,
    );
    expect(html).toContain('aria-label="Refresh LoRA list"');
    const c = src("components/characters/CharacterPicker.tsx");
    // No early return on a warm cache: every open refetches in the background.
    expect(c).not.toMatch(/if \(listCache && !force\)/);
    expect(c).toContain("wideEnoughToAutofocus()");
  });
});
