/**
 * Tools page accessibility + copy checks.
 *
 * No DOM test library in devDeps, so the components are rendered to static
 * markup (react-dom/server) and the HTML is scanned: every button needs an
 * accessible name (text, aria-label, aria-labelledby or title) and every
 * visible form control a label. Copy rules cover every hub card.
 */
import { describe, it, expect } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolsPage } from "@/components/tools/ToolsPage";
import { ToolRunner } from "@/components/tools/ToolRunner";
import { TemplateRunner } from "@/components/tools/TemplateRunner";
import { AppRunner } from "@/components/tools/AppRunner";
import { RunnerCardContext } from "@/components/tools/ToolCover";
import { ColorGrade } from "@/components/tools/ColorGrade";
import { SoulCast } from "@/components/tools/SoulCast";
import { StylePresets } from "@/components/tools/StylePresets";
import { CharacterProfiles } from "@/components/tools/CharacterProfiles";
import { MotionDesigner } from "@/components/tools/MotionDesigner";
import { StoryboardRunner } from "@/components/tools/StoryboardRunner";
import { PipelineRunner } from "@/components/tools/PipelineRunner";
import { ClipCutRunner } from "@/components/tools/ClipCutRunner";
import { DubRunner } from "@/components/tools/DubRunner";
import { VoiceChangerRunner } from "@/components/tools/VoiceChangerRunner";
import { OverlayRunner } from "@/components/tools/OverlayRunner";
import { BoardRunner } from "@/components/tools/BoardRunner";
import {
  ACTION_TOOLS,
  buildToolCards,
  type CatalogTool,
  type EditLoraListResponse,
} from "@/lib/tools/toolsPage";
import { buildHubCards, modelLine, type HubCard } from "@/lib/tools/hub";
import { getEditTools, toPublicTool } from "@/lib/tools/editTools";
import { TEMPLATES, type EngineContext } from "@/lib/tools/templates";
import { APP_TEMPLATES } from "@/lib/tools/apps";

const editLoras: EditLoraListResponse = {
  families: { krea2edit: { label: "Krea 2 Edit" } },
  loras: [
    {
      id: "k1",
      name: "K1",
      file: "k1.safetensors",
      family: "krea2edit",
      base: "krea2",
      defaultStrength: 0.9,
      installed: true,
    },
  ] as EditLoraListResponse["loras"],
};

const catalog = getEditTools().map((t) =>
  toPublicTool(t, { installed: true, packAvailable: true } as never),
) as unknown as CatalogTool[];

const packIds = new Set([
  "qwen-image-edit",
  "krea2-edit",
  "qwen-image-21",
  "flux3",
  "audio",
]);
const ctx: EngineContext = { catalog, packIds, editLoras };
const toolCards = buildToolCards({
  catalog,
  packIds,
  editLoras,
  modelStatus: { tools: {} },
});
const hubCards = buildHubCards({ toolCards, ctx });
const hubCard = (key: string): HubCard => {
  const c = hubCards.find((h) => h.key === key);
  if (!c) throw new Error(`no hub card ${key}`);
  return c;
};

const noop = () => {};

function render(el: ReactElement, card?: HubCard): string {
  return renderToStaticMarkup(
    card ? createElement(RunnerCardContext.Provider, { value: card }, el) : el,
  );
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : null;
}

const textOf = (html: string) =>
  html
    .replace(/<[^>]*\balt="([^"]*)"[^>]*>/g, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, "x")
    .trim();

/** Buttons without an accessible name, as short HTML snippets. */
function unnamedButtons(html: string): string[] {
  const bad: string[] = [];
  for (const m of html.matchAll(/(<button\b[^>]*>)([\s\S]*?)<\/button>/g)) {
    const [, open, inner] = m;
    const named =
      !!attr(open, "aria-label")?.trim() ||
      !!attr(open, "aria-labelledby") ||
      !!attr(open, "title")?.trim() ||
      textOf(inner).length > 0;
    if (!named) bad.push(m[0].slice(0, 160));
  }
  return bad;
}

/** Visible input/select/textarea elements without a label. */
function unlabeledControls(html: string): string[] {
  const bad: string[] = [];
  const labelFor = new Set(
    [...html.matchAll(/<label\b[^>]*\sfor="([^"]+)"/g)].map((m) => m[1]),
  );
  // Ranges of <label>…</label> so wrapped controls count as labeled.
  const wrapped: [number, number][] = [];
  for (const m of html.matchAll(/<label\b[\s\S]*?<\/label>/g))
    wrapped.push([m.index!, m.index! + m[0].length]);
  for (const m of html.matchAll(/<(input|select|textarea)\b[^>]*>/g)) {
    const tag = m[0];
    const type = attr(tag, "type");
    if (type === "hidden") continue;
    if (/\sclass="(?:[^"]*\s)?hidden(?:\s[^"]*)?"/.test(tag)) continue;
    const id = attr(tag, "id");
    const named =
      !!attr(tag, "aria-label")?.trim() ||
      !!attr(tag, "aria-labelledby") ||
      !!attr(tag, "title")?.trim() ||
      (id !== null && labelFor.has(id)) ||
      wrapped.some(([a, b]) => m.index! > a && m.index! < b);
    if (!named) bad.push(tag.slice(0, 160));
  }
  return bad;
}

function expectAccessible(name: string, html: string) {
  expect(html.length, name).toBeGreaterThan(0);
  expect(unnamedButtons(html), `${name}: buttons without a name`).toEqual([]);
  expect(unlabeledControls(html), `${name}: unlabeled controls`).toEqual([]);
}

describe("tools a11y (static markup)", () => {
  it("scanner flags icon-only buttons and bare inputs", () => {
    expect(
      unnamedButtons(
        '<button type="button"><svg aria-hidden="true"></svg></button>',
      ),
    ).toHaveLength(1);
    expect(
      unnamedButtons('<button aria-label="Close"><svg></svg></button>'),
    ).toEqual([]);
    expect(unlabeledControls('<input type="text"/>')).toHaveLength(1);
    expect(
      unlabeledControls('<label>Name <input type="text"/></label>'),
    ).toEqual([]);
  });

  it("ToolsPage hub shell", () => {
    expectAccessible("ToolsPage", render(createElement(ToolsPage)));
  });

  it.each(ACTION_TOOLS.filter((s) => !s.hidden).map((s) => [s.id]))(
    "action runner %s",
    (id) => {
    const base = toolCards.find((c) => c.key === `action:${id}`)!;
    const card = hubCard(base.key);
    const spec = ACTION_TOOLS.find((s) => s.id === id)!;
    expectAccessible(
      id,
      render(
        createElement(ToolRunner, {
          card: { ...base, title: card.title },
          actionSpec: spec,
          editLoras,
          model: card.model,
          onBack: noop,
        }),
        card,
      ),
    );
    },
  );

  it.each(catalog.map((t) => [t.id]))("catalog runner %s", (id) => {
    const tool = catalog.find((t) => t.id === id)!;
    const base = toolCards.find((c) => c.key === `catalog:${id}`) ?? {
      ...toolCards[0],
      key: `catalog:${id}`,
      kind: "catalog" as const,
      id,
      title: tool.label,
      subtitle: tool.description,
    };
    expectAccessible(
      id,
      render(
        createElement(ToolRunner, {
          card: base,
          catalogTool: tool,
          editLoras,
          onBack: noop,
        }),
      ),
    );
  });

  it.each(TEMPLATES.map((t) => [t.id]))("template runner %s", (id) => {
    const card = hubCard(`template:${id}`);
    const template = TEMPLATES.find((t) => t.id === id)!;
    expectAccessible(
      id,
      render(
        createElement(TemplateRunner, { template, card, ctx, onBack: noop }),
        card,
      ),
    );
  });

  it("special runners", () => {
    const by = (key: string) =>
      hubCards.find((c) => c.key.endsWith(key)) ?? hubCards[0];
    const runners: [string, ReactElement, HubCard?][] = [
      ["ColorGrade", createElement(ColorGrade, { onBack: noop })],
      ["SoulCast", createElement(SoulCast, { onBack: noop })],
      ["StylePresets", createElement(StylePresets, { onBack: noop })],
      ["CharacterProfiles", createElement(CharacterProfiles, { onBack: noop })],
      ["MotionDesigner", createElement(MotionDesigner, { onBack: noop })],
      [
        "StoryboardRunner",
        createElement(StoryboardRunner, {
          card: by(":storyboard"),
          ctx,
          onBack: noop,
        }),
      ],
      [
        "PipelineRunner",
        createElement(PipelineRunner, {
          kind: "shorts",
          card: by(":shorts_studio"),
          ctx,
          onBack: noop,
        }),
      ],
      [
        "ClipCutRunner",
        createElement(ClipCutRunner, {
          variant: "studio",
          card: by(":clipcut"),
          ctx,
          onBack: noop,
        }),
      ],
      [
        "DubRunner",
        createElement(DubRunner, { card: by(":dub_video"), ctx, onBack: noop }),
      ],
      [
        "VoiceChangerRunner",
        createElement(VoiceChangerRunner, {
          card: by(":voice_changer"),
          ctx,
          onBack: noop,
        }),
      ],
      [
        "OverlayRunner",
        createElement(OverlayRunner, {
          card: by(":overlay_composite"),
          ctx,
          onBack: noop,
        }),
      ],
      [
        "BoardRunner",
        createElement(BoardRunner, {
          card: by(":board"),
          hubCards,
          editLoras,
          onBack: noop,
        }),
      ],
    ];
    for (const [name, el] of runners) expectAccessible(name, render(el));
  });

  it.each(APP_TEMPLATES.map((a) => [a.id]))("app runner %s", (id) => {
    const card = hubCard(`app:${id}`);
    const app = APP_TEMPLATES.find((a) => a.id === id)!;
    expectAccessible(
      id,
      render(createElement(AppRunner, { app, card, ctx, onBack: noop }), card),
    );
  });
});

describe("tools copy", () => {
  it("every card description is one short sentence-case line", () => {
    const bad = hubCards
      .filter(
        (c) =>
          c.subtitle.length > 90 ||
          /^[a-z]/.test(c.subtitle) ||
          /\.$/.test(c.subtitle.trim()),
      )
      .map((c) => `${c.key} (${c.subtitle.length}): ${c.subtitle}`);
    expect(bad).toEqual([]);
  });

  it("every catalog tool description fits a card", () => {
    const bad = getEditTools()
      .filter((t) => t.description.length > 90 || /\.$/.test(t.description))
      .map((t) => t.id);
    expect(bad).toEqual([]);
  });

  it("model credit lines read 'Model · license' with one license", () => {
    for (const c of hubCards) {
      const line = modelLine(c.model);
      if (!line) continue;
      expect(line, c.key).toMatch(/^[^·]+ · /);
      expect(line.split("open weights").length, c.key).toBeLessThanOrEqual(2);
    }
    expect(modelLine("Krea 2")).toBe("Krea 2 · open weights");
    expect(modelLine("Chatterbox VC (Resemble AI) · MIT")).toBe(
      "Chatterbox VC (Resemble AI) · MIT",
    );
  });

  it("uses US spelling in user-facing tool text", () => {
    const text = JSON.stringify([
      hubCards.map((c) => [c.title, c.subtitle, c.model]),
      ACTION_TOOLS.map((s) => [s.text, s.secondText, s.pickers]),
      getEditTools().map((t) => [t.label, t.description, t.promptHint]),
    ]);
    expect(text).not.toMatch(/\b(colours?|labelled|stylised)\b/i);
  });
});

describe("Segmented hint", () => {
  it("describes the radiogroup and turns option hints into tooltips", async () => {
    const { Segmented } = await import("@/components/tools/ToolRunner");
    const html = renderToStaticMarkup(
      createElement(Segmented, {
        label: "Long clip method",
        value: "a",
        options: [
          { id: "a", label: "A", hint: "first" },
          { id: "b", label: "B" },
        ],
        onChange: () => {},
        hint: "Trade-off line",
      }),
    );
    const id = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/title="first"/);
    const bare = renderToStaticMarkup(
      createElement(Segmented, {
        label: "X",
        value: "a",
        options: [{ id: "a", label: "A" }],
        onChange: () => {},
      }),
    );
    expect(bare).not.toContain("aria-describedby");
  });
});
