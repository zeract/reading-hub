import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/renderer/styles.css"), "utf8");

describe("reader display-equation layout", () => {
  it("keeps KaTeX formula bases in flow and places an equation tag afterwards", () => {
    expect(styles).toContain(".article-body .katex-display > .katex {\n  display: block;");
    expect(styles).toContain("display: flex;\n  flex-wrap: nowrap;");
    expect(styles).toContain(".article-body .katex-display > .katex > .katex-html > .base {\n  flex: 0 0 auto;\n  order: 1;");
    expect(styles).toContain(".article-body .katex-display > .katex > .katex-html > .tag {\n  position: static;\n  flex: 0 0 auto;\n  order: 2;");
    expect(styles).toContain("margin-left: 1em;");
    expect(styles).not.toContain(".article-body .katex-display > .katex { display: inline-block;");
    expect(styles).not.toContain(".article-body .katex-display > .katex > .katex-html > .base {\n  grid-column");
  });

  it("constrains reader images and keeps the main scrolling regions intentional", () => {
    expect(styles).toContain(".article-body img { display: block; width: auto; height: auto; max-width: min(100%, 34em);");
    expect(styles).toContain(".article-body img[data-reader-zoomable=\"true\"] { cursor: zoom-in; }");
    expect(styles).toContain(".reader-image-lightbox {\n  position: fixed;\n  z-index: 30;\n  inset: 0;");
    expect(styles).toContain("max-height: calc(100vh - 32px);");
    expect(styles).toContain(".reader-scroll { min-height: 0; overflow: auto;");
    expect(styles).toContain(".source-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;");
  });

  it("reclaims the macOS traffic-light inset while the native window is fullscreen", () => {
    expect(styles).toContain(".shell { --titlebar-leading-inset: 96px;");
    expect(styles).toContain(".shell--fullscreen { --titlebar-leading-inset: 16px; }");
    expect(styles).toContain("padding: 0 16px 0 var(--titlebar-leading-inset);");
  });
});
