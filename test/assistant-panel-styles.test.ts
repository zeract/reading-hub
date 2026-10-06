import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(import.meta.dirname, "../src/renderer/styles.css"), "utf8");

describe("assistant panel minimization", () => {
  it("keeps a dedicated symbolic minimized launcher outside the responsive sidebar layout", () => {
    expect(styles).toContain(".reader-ai-panel.is-minimized { display: none; }");
    expect(styles).toContain(".assistant-launcher { position: absolute;");
    expect(styles).toContain("right: 20px; bottom: 20px;");
    expect(styles).toContain("border-radius: 50%;");
    expect(styles).toContain(".assistant-header-actions { display: flex;");
  });

  it("keeps module recovery compact and uses the shared action controls", () => {
    expect(styles).toMatch(/\.ai-markdown-load-error\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*align-items:\s*center;[^}]*gap:\s*8px;[^}]*font:\s*400 11px\/1\.5 var\(--font-ui\)/s);
    expect(styles).toMatch(/\.ai-markdown-load-error p\s*\{[^}]*min-width:\s*0;[^}]*margin:\s*0;[^}]*overflow-wrap:\s*anywhere/s);
    expect(styles).toMatch(/\.ai-message-content--plain\s*\{\s*white-space:\s*pre-wrap;/);
    expect(styles).toMatch(/\.ai-markdown-load-error\s*\{[^}]*color:\s*var\(--ink-soft\)/s);
    expect(styles).not.toMatch(/\.ai-markdown-load-error button\s*\{[^}]*(?:font:|border-radius:|background:)/s);
  });
});
