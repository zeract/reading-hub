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
});
