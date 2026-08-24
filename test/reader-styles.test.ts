import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/renderer/styles.css"), "utf8");

describe("reader display-equation layout", () => {
  it("owns equation tag layout outside KaTeX's private DOM", () => {
    expect(styles).toMatch(/\.article-body\s+\[data-reader-equation\]\s*>\s*\.reader-equation\s*\{[^}]*display:\s*flex;[^}]*width:\s*100%;[^}]*min-width:\s*max-content/s);
    expect(styles).toMatch(/\.article-body\s+\.reader-equation__content\s*\{[^}]*display:\s*flex;[^}]*min-width:\s*0;[^}]*flex:\s*1\s+0\s+auto/s);
    expect(styles).toMatch(/\.article-body\s+\.reader-equation__tag\s*\{[^}]*flex:\s*0\s+0\s+auto;[^}]*margin-left:\s*\.75em;[^}]*white-space:\s*nowrap/s);
    expect(styles).toContain(".article-body [data-reader-equation] { display: block;");
    expect(styles).toContain(".article-body > mjx-container[display=\"true\"] { display: block;");
    expect(styles).not.toContain(".article-body [data-reader-equation], .article-body mjx-container[display=\"true\"]");
    expect(styles).toMatch(/\.reader-equation--mathjax\s+\.reader-equation__content\s*>\s*mjx-container\s*\{[^}]*overflow:\s*visible/s);
    expect(styles).not.toContain(".article-body .katex-display > .katex > .katex-html > .base");
    expect(styles).not.toContain(".article-body .katex-display > .katex > .katex-html > .tag");
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
    expect(styles).toContain("padding: 0 16px 0 var(--titlebar-leading-inset);");
    expect(styles).toContain(".shell:not(.shell--fullscreen) .app-titlebar-actions, .settings-shell:not(.settings-shell--fullscreen) .app-titlebar-actions { transform: translateY(-9px); }");
    expect(styles).toMatch(/\.app-titlebar-button:hover:not\(:disabled\),\s*\.app-titlebar-button:active:not\(:disabled\)\s*\{[^}]*background:\s*transparent/s);
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

  it("visually identifies a locally supplied feed summary without presenting it as full-page content", () => {
    expect(styles).toMatch(/\.reader-content-notice\s*\{[^}]*border-left:\s*3px\s+solid\s+var\(--accent\);[^}]*background:\s*var\(--selection-surface\)/s);
  });

  it("keeps the article title proportional to the adjustable body size", () => {
    expect(styles).toMatch(/\.reader-article h1\s*\{[^}]*font-size:\s*2em;[^}]*line-height:\s*1\.16/s);
    expect(styles).not.toContain(".reader-article h1 { margin: 0; color: var(--ink); font-family: \"Iowan Old Style\",\"Songti SC\",\"STSong\",Georgia,serif; font-size: clamp(32px,3.8vw,51px);");
  });

  it("uses a restrained native-blue palette for selection and keeps translation as a separate soft signal", () => {
    expect(styles).toContain("--accent: #4f7ea8;");
    expect(styles).toContain("--selection-surface: #dce8f5;");
    expect(styles).toMatch(/\.entry-card\.selected,\s*\.entry-card\.selected:hover\s*\{[^}]*background:\s*var\(--selection-surface\);[^}]*color:\s*var\(--ink\)/s);
    expect(styles).toMatch(/\.source-filter\.selected\s*\{[^}]*background:\s*var\(--selection-surface\);[^}]*color:\s*var\(--accent-ink\)/s);
    expect(styles).toMatch(/\.library-filter\.selected\s*\{[^}]*background:\s*var\(--selection-surface-strong\)/s);
    expect(styles).toContain(".reader-selection-underlines span { position: fixed; height: 1px; background: rgba(79,126,168,.60);");
    expect(styles).toMatch(/\.selection-assistant-card\s*\{[^}]*border-radius:\s*10px;[^}]*box-shadow:\s*0\s+16px\s+38px\s+rgba\(27,32,39,\.12\)/s);
    expect(styles).toMatch(/\.selection-assistant-card\[data-intent="translate"\]\s*>\s*header\s+p\s*\{[^}]*color:\s*var\(--danger\)/s);
    expect(styles).toMatch(/\.status\.active\s*\{[^}]*color:\s*var\(--ink\)/s);
    expect(styles).not.toContain("#dc3c22");
    expect(styles).not.toContain("#d9ed72");
    expect(styles).not.toContain("#c7dd65");
  });

  it("supports a reader-only view while keeping source rows intentionally compact", () => {
    expect(styles).toContain(".shell--reader-only { grid-template-columns: 0 0 minmax(0,1fr); }");
    expect(styles).toContain(".shell--reader-only > .sidebar, .shell--reader-only > .timeline { display: none; }");
    expect(styles).toMatch(/\.source-filter\s*\{[^}]*display:\s*flex;[^}]*min-height:\s*34px;[^}]*border-radius:\s*6px/s);
    expect(styles).toMatch(/\.source-title\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/s);
    expect(styles).toMatch(/\.source-icon\s*\{[^}]*flex:\s*0\s+0\s+18px/s);
    expect(styles).toMatch(/\.source-icon--favicon\s*\{[^}]*border:\s*1px\s+solid/s);
    expect(styles).toMatch(/\.source-icon img\s*\{[^}]*object-fit:\s*contain/s);
    expect(styles).toMatch(/\.source-group-label svg\s*\{[^}]*width:\s*13px/s);
    expect(styles).toContain(".settings-shell { --titlebar-leading-inset: 96px;");
  });

  it("keeps the source collection directly beneath the reading filters with a compact local hierarchy", () => {
    expect(styles).toMatch(/\.sidebar\s*\{[^}]*gap:\s*9px/s);
    expect(styles).toMatch(/\.source-section\s*\{[^}]*flex:\s*1\s+1\s+auto;[^}]*flex-direction:\s*column;[^}]*gap:\s*1px/s);
    expect(styles).toMatch(/\.section-title\s*\{[^}]*margin:\s*1px\s+8px\s+2px;[^}]*font-size:\s*10px/s);
    expect(styles).toMatch(/\.source-group-heading\s*\{[^}]*font-size:\s*12px/s);
    expect(styles).toMatch(/\.library-filter\s*\{[^}]*font-size:\s*12px/s);
    expect(styles).toMatch(/\.source-title\s*\{[^}]*font-size:\s*12px/s);
    expect(styles).not.toContain("margin: 2px 7px -8px");
  });

  it("clips timeline titles and summaries to the card width and two lines", () => {
    expect(styles).toMatch(/\.entry-card h2\s*\{[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;[^}]*overflow-wrap:\s*anywhere;[^}]*-webkit-line-clamp:\s*2/s);
    expect(styles).toMatch(/\.summary\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*max-height:\s*calc\(1\.48em\s*\*\s*2\);[^}]*overflow:\s*hidden;[^}]*overflow-wrap:\s*anywhere;[^}]*-webkit-line-clamp:\s*2/s);
  });
});
