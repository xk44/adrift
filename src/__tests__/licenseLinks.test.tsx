import React from "react";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  LICENSE_URLS,
  licenseNameKnown,
  licenseUrlFor,
} from "@/lib/models/licenseLinks";
import {
  STARTER_PACKS,
  resolvePack,
  slotOptions,
  type StarterPacksDoc,
} from "@/lib/onboarding/starterPacks";
import {
  isHttpsUrl,
  validatePackLicenses,
} from "@/lib/onboarding/packLicenseSchema";
import { MODEL_FAMILIES, familyFor } from "@/lib/tools/toolsDoc";
import { licenseCell, MODEL_SIZES } from "@/lib/tools/modelsDoc";
import { resolveToolSetup } from "@/lib/tools/setupRequirements";
import { LicenseLink } from "@/components/models/LicenseLink";
import {
  PackCard,
  packLicenseLinks,
  restrictiveLicense,
} from "@/components/onboarding/PacksStep";
import { OptionBody } from "@/components/tools/SetupDrawer";
import type { PackView } from "@/components/onboarding/api";
import type { Workflow } from "@/types";

const KREA = "https://huggingface.co/krea/Krea-2-Turbo/blob/main/LICENSE.pdf";
const APACHE = "https://www.apache.org/licenses/LICENSE-2.0";

describe("license link table", () => {
  it("every link is https (null = no verified link)", () => {
    for (const [name, url] of Object.entries(LICENSE_URLS))
      if (url !== null) expect(isHttpsUrl(url), name).toBe(true);
  });

  it("knows every model family and by-name license", () => {
    for (const f of MODEL_FAMILIES)
      expect(licenseNameKnown(f.license), f.license).toBe(true);
    for (const m of MODEL_SIZES.byName)
      expect(licenseNameKnown(m.license), m.license).toBe(true);
  });

  it("links composite names to the base model and strips notes", () => {
    expect(licenseUrlFor("MIT (LoRA); Qwen Research License (base)")).toBe(
      LICENSE_URLS["Qwen Research License"],
    );
    expect(licenseUrlFor("CC BY-NC 4.0 (weights)")).toBe(
      LICENSE_URLS["CC BY-NC 4.0"],
    );
    expect(licenseUrlFor("Apache-2.0")).toBe(APACHE);
    expect(licenseUrlFor("Unstated")).toBeNull();
    expect(licenseUrlFor("Some Made Up License")).toBeNull();
    expect(licenseUrlFor(null)).toBeNull();
    expect(licenseNameKnown("Some Made Up License")).toBe(false);
  });
});

describe("starter pack license schema", () => {
  it("every pack and every file has a license name + https link or explicit null", () => {
    expect(validatePackLicenses(STARTER_PACKS)).toEqual([]);
  });

  it("file licenses match the model family registry", () => {
    for (const pack of STARTER_PACKS.packs)
      for (const slot of pack.files)
        for (const o of slotOptions(slot)) {
          const fam = familyFor(o.dest);
          expect(fam, o.dest).toBeDefined();
          expect(o.licenseName, o.dest).toBe(fam!.license);
          expect(o.licenseUrl, o.dest).toBe(licenseUrlFor(fam!.license));
        }
  });

  it("a pack carries its main model's license", () => {
    for (const pack of STARTER_PACKS.packs) {
      const main = slotOptions(pack.files[0])[0];
      expect(pack.licenseName, pack.id).toBe(main.licenseName);
      expect(pack.licenseUrl, pack.id).toBe(main.licenseUrl);
    }
  });

  it("flags missing names, missing links and non-https links", () => {
    const doc = {
      packs: [
        {
          id: "p",
          licenseName: "",
          files: [
            { dest: "a/x", licenseName: "MIT" },
            {
              dest: "a/y",
              licenseName: "MIT",
              licenseUrl: "http://example.com/l",
            },
            { dest: "a/z", licenseName: "MIT", licenseUrl: null },
          ],
        },
      ],
    } as unknown as StarterPacksDoc;
    expect(validatePackLicenses(doc)).toEqual([
      "pack p: missing licenseName",
      "pack p: missing licenseUrl (use null when unknown)",
      "pack p file a/x: missing licenseUrl (use null when unknown)",
      "pack p file a/y: licenseUrl must be an https link or null",
    ]);
  });

  it("resolvePack attaches the link to each file and the pack", () => {
    const pack = STARTER_PACKS.packs.find((p) => p.id === "images-best")!;
    const r = resolvePack(pack, null, null, (dest) => {
      const fam = familyFor(dest);
      return fam && { license: fam.license, commercial: fam.commercial };
    });
    expect(r.licenseName).toBe("Krea 2 Community License");
    expect(r.licenseUrl).toBe(KREA);
    expect(r.files[0].license?.url).toBe(KREA);
    expect(r.licenses.every((l) => l.url && isHttpsUrl(l.url))).toBe(true);
  });
});

describe("LicenseLink", () => {
  it("opens the license in a new tab, safely", () => {
    const html = renderToStaticMarkup(
      <LicenseLink name="MIT" url="https://opensource.org/license/mit" />,
    );
    expect(html).toContain('href="https://opensource.org/license/mit"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('data-testid="license-link"');
    expect(html).toContain("MIT");
  });

  it("shows plain text with no link, or a non-https link", () => {
    for (const url of [
      null,
      undefined,
      "http://example.com",
      "javascript:alert(1)",
    ]) {
      const html = renderToStaticMarkup(
        <LicenseLink name="Unstated" url={url} />,
      );
      expect(html).not.toContain("<a");
      expect(html).toContain("Unstated");
    }
  });
});

describe("license links in the UI", () => {
  const noop = () => {};

  it("pack card links the pack license and each file license", () => {
    const pack = STARTER_PACKS.packs.find((p) => p.id === "images-best")!;
    const r = resolvePack(pack, null, null, (dest) => {
      const fam = familyFor(dest);
      return (
        fam && {
          license: fam.license,
          commercial: fam.commercial,
          url: licenseUrlFor(fam.license),
        }
      );
    });
    const view = {
      ...r,
      command: null,
      files: r.files.map((f) => ({ ...f, hfCommand: null })),
    } as PackView;
    expect(packLicenseLinks(view).map((l) => l.name)).toContain(
      "Krea 2 Community License",
    );
    const html = renderToStaticMarkup(
      <PackCard
        pack={view}
        selected={false}
        onToggle={noop}
        copied={null}
        onCopy={noop}
      />,
    );
    expect(html).toContain(`href="${KREA}"`);
    expect(html).toContain(`href="${APACHE}"`);
    expect(html).toContain('rel="noopener noreferrer"');
    // pack chip + size line + one per Krea file at least
    expect(
      html.split('data-testid="license-link"').length - 1,
    ).toBeGreaterThanOrEqual(4);
  });

  it("warning chip links the restrictive license, not the main one", () => {
    const nc = "https://example.org/nc";
    expect(
      restrictiveLicense({
        licenseName: "Apache-2.0",
        licenseUrl: APACHE,
        licenses: [
          { license: "Apache-2.0", commercial: "yes", url: APACHE },
          { license: "Some License", commercial: "restricted", url: null },
          { license: "NC License", commercial: "no", url: nc },
        ],
      }),
    ).toEqual({ name: "NC License", url: nc });
    expect(
      restrictiveLicense({
        licenseName: "Krea 2 Community License",
        licenseUrl: KREA,
        licenses: [],
      }),
    ).toEqual({ name: "Krea 2 Community License", url: KREA });
  });

  it("Tools setup drawer links each file's license", () => {
    const WF = path.resolve(__dirname, "../../public/workflows");
    const load = (rel: string): Workflow | null => {
      const p = path.join(WF, rel);
      return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
    };
    const s = resolveToolSetup("action:upscale", load);
    expect(s).not.toBeNull();
    const opt = s!.options[0];
    expect(opt.files.length).toBeGreaterThan(0);
    for (const f of opt.files)
      expect(f.licenseUrl, f.file).toBe(licenseUrlFor(f.license));
    const html = renderToStaticMarkup(
      <OptionBody
        opt={{
          ...opt,
          backend: "default",
          missingNodes: [],
          missingOptionalNodes: [],
          nodeSources: {},
          files: opt.files.map((f) => ({ ...f, status: "missing" as const })),
        }}
        copied={null}
        onCopy={noop}
      />,
    );
    const linked = opt.files.find((f) => f.licenseUrl);
    expect(linked).toBeDefined();
    expect(html).toContain(`href="${linked!.licenseUrl}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe("models doc license column", () => {
  it("links known licenses and leaves unknown ones as text", () => {
    expect(licenseCell("Apache-2.0")).toBe(`[Apache-2.0](${APACHE})`);
    expect(licenseCell("Unstated")).toBe("Unstated");
    expect(licenseCell("a | b")).toBe("a \\| b");
  });

  it("docs/models.md has the links", () => {
    const md = readFileSync(
      path.resolve(__dirname, "../../docs/models.md"),
      "utf8",
    );
    expect(md).toContain(`[Krea 2 Community License](${KREA})`);
    expect(md).toContain(`[MIT](https://opensource.org/license/mit)`);
  });
});
