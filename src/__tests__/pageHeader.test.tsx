import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageHeader } from "@/components/PageHeader";

describe("PageHeader", () => {
  it("renders one h1 with optional subtitle and actions", () => {
    const html = renderToStaticMarkup(
      createElement(PageHeader, {
        title: "Help",
        subtitle: "Server status",
        actions: createElement("button", null, "Go"),
      }),
    );
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain(">Help");
    expect(html).toContain("Server status");
    expect(html).toContain("<button>Go</button>");
  });

  it("omits the subtitle and actions rows when not given", () => {
    const html = renderToStaticMarkup(
      createElement(PageHeader, { title: "Updates" }),
    );
    expect(html).not.toContain("<p");
    expect(html).not.toContain("mt-5");
  });
});
