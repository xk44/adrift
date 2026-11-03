/** What the shared library panel shows in each state. */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EmptyLibrary,
  IndexProgress,
  ServiceOffline,
} from "@/components/style/library/LibraryStatus";

const noop = () => {};

describe("LibraryStatus states", () => {
  it("offline shows the setup and start commands", () => {
    const html = renderToStaticMarkup(
      React.createElement(ServiceOffline, { onRetry: noop }),
    );
    expect(html).toContain("bash scripts/stylevault.sh setup");
    expect(html).toContain("bash scripts/stylevault.sh start");
    expect(html).toContain("Retry");
  });

  it("empty library offers a folder and ComfyUI outputs", () => {
    const html = renderToStaticMarkup(
      React.createElement(EmptyLibrary, {
        job: { state: "idle" },
        busy: false,
        error: null,
        onIndex: noop,
      }),
    );
    expect(html).toContain("Add a folder");
    expect(html).toContain("Use my ComfyUI outputs");
    expect(html).not.toContain('data-testid="library-index-progress"');
  });

  it("empty after a finished run says nothing was found", () => {
    const html = renderToStaticMarkup(
      React.createElement(EmptyLibrary, {
        job: { state: "done", assets: 0 },
        busy: false,
        error: null,
        onIndex: noop,
      }),
    );
    expect(html).toContain("found no images");
  });

  it("progress shows step and count", () => {
    const html = renderToStaticMarkup(
      React.createElement(IndexProgress, {
        job: { state: "running", step: "Embedding", done: 3, total: 12 },
      }),
    );
    expect(html).toContain("Embedding");
    expect(html).toContain("3 of 12");
    expect(html).toContain("width:25%");
  });

  it("errors are shown", () => {
    const html = renderToStaticMarkup(
      React.createElement(IndexProgress, {
        job: { state: "error", error: "disk full" },
      }),
    );
    expect(html).toContain("disk full");
  });
});
