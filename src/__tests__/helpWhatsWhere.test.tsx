import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WhatsWhere } from "@/components/HelpPage";
import { NAV_DESTINATIONS, whatsWhereEntries } from "@/lib/ui/navRegistry";

describe("Help: what's where (C15)", () => {
  it("lists every non-account destination plus Setup, in nav order", () => {
    const keys = whatsWhereEntries().map((d) => d.key);
    expect(keys).toEqual(
      NAV_DESTINATIONS.filter(
        (d) => d.group !== "account" || d.key === "setup",
      ).map((d) => d.key),
    );
    expect(keys).toContain("create");
    expect(keys).toContain("tools");
    expect(keys).toContain("setup");
    expect(keys).not.toContain("help");
  });

  it("renders each hint plus a Run setup guide button", () => {
    const html = renderToStaticMarkup(createElement(WhatsWhere));
    expect(html).toContain("What&#x27;s where");
    expect(html).toContain("Run setup guide");
    for (const d of whatsWhereEntries()) {
      expect(html).toContain(d.label);
      expect(html).toContain(d.hint);
    }
  });

  it("HelpPage renders the section", () => {
    const src = readFileSync(
      path.join(process.cwd(), "src/components/HelpPage.tsx"),
      "utf8",
    );
    expect(src).toContain("<WhatsWhere />");
    expect(src).toContain("openOnboarding()");
    // Offline: a plain button to fix the address; the env var is the
    // advanced route, not the headline.
    expect(src).toContain('openOnboarding("connect")');
    expect(src).toContain("Change connection");
    expect(src).not.toContain("address set in COMFY_HTTP_URL");
  });
});
