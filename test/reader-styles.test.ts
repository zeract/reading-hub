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
    expect(styles).toMatch(/\.reader-scroll\s*\{[^}]*scrollbar-width:\s*thin;[^}]*scrollbar-color:\s*var\(--scroll-thumb\)\s+transparent/s);
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
    expect(styles).toMatch(/\.reader-toolbar\s+\.favorite-button\s*\{[^}]*color:\s*var\(--accent-deep\)/s);
    expect(styles).toMatch(/\.reader-toolbar\s+\.favorite-button\.is-favorite\s*\{[^}]*background:\s*var\(--accent-wash\)/s);
  });

  it("uses a muted paper palette for selection and keeps translation as a separate soft signal", () => {
    expect(styles).toContain("--accent: #6a7d63;");
    expect(styles).toContain("--selection-surface: #edede8;");
    expect(styles).toMatch(/\.entry-card\.selected,\s*\.entry-card\.selected:hover\s*\{[^}]*background:\s*var\(--selection-surface\);[^}]*color:\s*var\(--ink\)/s);
    expect(styles).toMatch(/\.source-filter\.selected\s*\{[^}]*background:\s*var\(--selection-surface\);[^}]*color:\s*var\(--ink\)/s);
    expect(styles).toMatch(/\.library-filter\.selected\s*\{[^}]*background:\s*var\(--selection-surface-strong\)/s);
    expect(styles).toContain(".reader-selection-underlines span { position: fixed; height: 1px; background: rgba(106,125,99,.56);");
    expect(styles).toMatch(/\.selection-assistant-card\s*\{[^}]*border-radius:\s*22px;[^}]*box-shadow:\s*0\s+16px\s+38px\s+rgba\(40,40,36,\.1\)/s);
    expect(styles).toMatch(/\.selection-assistant-card\[data-intent="translate"\]\s*>\s*header\s+p\s*\{[^}]*color:\s*var\(--danger\)/s);
    expect(styles).toMatch(/\.status\.active\s*\{[^}]*color:\s*var\(--ink\)/s);
    expect(styles).not.toContain("#dc3c22");
    expect(styles).not.toContain("#d9ed72");
    expect(styles).not.toContain("#c7dd65");
  });

  it("supports a reader-only view while keeping source rows intentionally compact", () => {
    expect(styles).toContain(".shell--reader-only { grid-template-columns: 0 0 minmax(0,1fr); }");
    expect(styles).toContain(".shell--reader-only > .sidebar, .shell--reader-only > .timeline { display: none; }");
    expect(styles).toMatch(/\.source-filter\s*\{[^}]*display:\s*flex;[^}]*min-height:\s*33px;[^}]*border-radius:\s*7px/s);
    expect(styles).toMatch(/\.source-title\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/s);
    expect(styles).toMatch(/\.source-icon\s*\{[^}]*flex:\s*0\s+0\s+17px/s);
    expect(styles).toMatch(/\.folder-icon::before\s*\{[^}]*content:\s*""/s);
    expect(styles).toContain(".settings-shell { --titlebar-leading-inset: 96px;");
  });

  it("keeps library filters and source names below their local category hierarchy", () => {
    expect(styles).toMatch(/\.section-title\s*\{[^}]*margin:\s*2px\s+7px\s+0;[^}]*font-size:\s*11px/s);
    expect(styles).toMatch(/\.source-group-heading\s*\{[^}]*font-size:\s*11px/s);
    expect(styles).toMatch(/\.library-filter\s*\{[^}]*font-size:\s*11px/s);
    expect(styles).toMatch(/\.source-title\s*\{[^}]*font-size:\s*11px/s);
    expect(styles).not.toContain("margin: 2px 7px -8px");
  });
});
