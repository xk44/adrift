/** HairDeck hub card, setup card and the TOOLS.md section. */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildHubCards } from "@/lib/tools/hub";
import { isOpenWeights } from "@/lib/tools/openWeights";
import { hairdeckCard, hairdeckDocLines } from "@/lib/hairdeck/card";
import { HAIRDECK_KEY, HAIRDECK_LICENSES } from "@/lib/hairdeck/config";
import {
  HairDeckCredits,
  HairDeckSetupCard,
} from "@/components/tools/HairDeckRunner";

describe("HairDeck card", () => {
  it("is on the hub, always openable, as a special card", () => {
    const cards = buildHubCards({
      toolCards: [],
      ctx: { catalog: [], packIds: new Set(), editLoras: null },
    });
    const card = cards.find((c) => c.key === HAIRDECK_KEY);
    expect(card).toMatchObject({ kind: "special", available: true, nc: false });
    // Gated SAM 3 / DINOv3 terms: never counted as commercial OK.
    expect(isOpenWeights(card!)).toBe(false);
    expect(hairdeckCard().aliases).toContain("hair cards");
  });

  it("setup card explains how to run and connect the sidecar", () => {
    const html = renderToStaticMarkup(
      createElement(HairDeckSetupCard, {
        status: { state: "unset", local: true },
        onRetry: () => {},
      }),
    );
    expect(html).toContain("HairDeck is not connected");
    expect(html).toContain("python demo/app.py --port 7860");
    expect(html).toContain("ssh -N -L 7860:127.0.0.1:7860");
    expect(html).toContain("HAIRDECK_BACKEND_URL=http://127.0.0.1:7860");
    const offline = renderToStaticMarkup(
      createElement(HairDeckSetupCard, {
        status: { state: "offline", local: true, error: "Could not reach HairDeck (status check)." },
        onRetry: () => {},
      }),
    );
    expect(offline).toContain("not answering");
    expect(offline).toContain("Could not reach HairDeck");
  });

  it("credits HairDeck and every dependency license, linked", () => {
    const html = renderToStaticMarkup(createElement(HairDeckCredits));
    expect(html).toContain("Apache-2.0");
    for (const l of HAIRDECK_LICENSES.slice(1)) {
      expect(html).toContain(l.license);
      expect(html).toContain(l.url);
    }
    const doc = hairdeckDocLines().join("\n");
    for (const lic of ["Apache-2.0", "SAM License", "DINOv3 License", "MIT", "GPL"])
      expect(doc).toContain(lic);
    expect(doc).toContain("HAIRDECK_BACKEND_URL");
  });
});
