import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/renderer/styles.css"), "utf8");

describe("reader display-equation layout", () => {
  it("keeps KaTeX formula bases in flow and places an equation tag afterwards", () => {
    expect(styles).toMatch(/\.article-body\s+\.katex-display\s*>\s*\.katex\s*\{[^}]*display:\s*block/s);
    expect(styles).toMatch(/\.katex-html\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap/s);
    expect(styles).toMatch(/\.article-body\s+\.katex-display\s*>\s*\.katex\s*>\s*\.katex-html\s*>\s*\.base\s*\{[^}]*flex:\s*0\s+0\s+auto;[^}]*order:\s*1/s);
    expect(styles).toMatch(/\.article-body\s+\.katex-display\s*>\s*\.katex\s*>\s*\.katex-html\s*>\s*\.tag\s*\{[^}]*position:\s*static;[^}]*flex:\s*0\s+0\s+auto;[^}]*order:\s*2/s);
    expect(styles).toMatch(/\.tag\s*\{[^}]*margin-left:\s*1em/s);
    expect(styles).not.toContain(".article-body .katex-display > .katex { display: inline-block;");
    expect(styles).not.toContain(".article-body .katex-display > .katex > .katex-html > .base {\n  grid-column");
  });

  it("constrains reader images and keeps the main scrolling regions intentional", () => {
    expect(styles).toContain(".article-body img { display: block; width: auto; height: auto; max-width: min(100%, 34em);");
    expect(styles).toContain(".article-body img[data-reader-zoomable=\"true\"] { cursor: zoom-in; }");
    expect(styles).toMatch(/\.reader-image-lightbox\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*30;[^}]*inset:\s*0/s);
    expect(styles).toContain(".reader-image-lightbox[hidden] { display: none; }");
    expect(styles).toContain("max-height: calc(100vh - 32px);");
    expect(styles).toMatch(/\.reader-scroll\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*auto/s);
    expect(styles).toMatch(/\.source-list\s*\{[^}]*flex:\s*1\s+1\s+auto;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;[^}]*overflow-x:\s*hidden/s);
  });

  it("reclaims the macOS traffic-light inset while the native window is fullscreen", () => {
    expect(styles).toContain(".shell { --titlebar-leading-inset: 96px;");
    expect(styles).toContain(".shell--fullscreen { --titlebar-leading-inset: 16px; }");
    expect(styles).toContain("padding: 0 20px 0 var(--titlebar-leading-inset);");
  });

  it("keeps the selected-text actions above the article without introducing a page scroll region", () => {
    expect(styles).toMatch(/\.reader-selection-toolbar\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*25;[^}]*transform:\s*translate\(-50%,-100%\)/s);
    expect(styles).toMatch(/\.reader-selection-toolbar\s+input\s*\{[^}]*width:\s*min\(210px,45vw\)/s);
  });
});
