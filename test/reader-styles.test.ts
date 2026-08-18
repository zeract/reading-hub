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
    expect(styles).toMatch(/\.reader-scroll\s*\{[^}]*scrollbar-width:\s*thin;[^}]*scrollbar-color:\s*#99998b\s+transparent/s);
    expect(styles).toContain(".reader-scroll::-webkit-scrollbar-thumb");
  });

  it("reclaims the macOS traffic-light inset while the native window is fullscreen", () => {
    expect(styles).toContain(".shell { --titlebar-leading-inset: 96px;");
    expect(styles).toContain(".shell--fullscreen { --titlebar-leading-inset: 16px; }");
    expect(styles).toContain("padding: 0 20px 0 var(--titlebar-leading-inset);");
  });

  it("keeps selected-text actions and the local answer inside the reader without introducing a page scroll region", () => {
    expect(styles).toMatch(/\.reader-selection-toolbar\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*26/s);
    expect(styles).toMatch(/\.reader-selection-toolbar\s+input\s*\{[^}]*width:\s*min\(210px,45vw\)/s);
    expect(styles).toContain(".reader-selection-underlines span { position: fixed;");
    expect(styles).toContain(".selection-assistant-card { position: fixed;");
    expect(styles).toContain(".selection-assistant-answer { min-height: 72px;");
  });

  it("gives the reader a persistent, stateful favourite control", () => {
    expect(styles).toMatch(/\.reader-toolbar\s+\.favorite-button\s*\{[^}]*color:\s*#8d5a42/s);
    expect(styles).toMatch(/\.reader-toolbar\s+\.favorite-button\.is-favorite\s*\{[^}]*background:\s*#f3e9ce/s);
  });

  it("uses the paper palette for persistent selections instead of a large dark-green fill", () => {
    expect(styles).toContain("--selection-surface: #faf7ef;");
    expect(styles).toMatch(/\.entry-card\.selected(?:,\s*\.entry-card\.selected:hover)?\s*\{[^}]*background:\s*var\(--selection-surface\);[^}]*color:\s*#2f3029/s);
    expect(styles).toMatch(/\.source-filter\.selected\s*\{[^}]*background:\s*var\(--selection-surface\);[^}]*color:\s*#30312a/s);
    expect(styles).toMatch(/\.library-filter\.selected\s*\{[^}]*background:\s*var\(--selection-surface-strong\)/s);
    expect(styles).not.toContain(".entry-card.selected { background: var(--olive-deep);");
  });
});
