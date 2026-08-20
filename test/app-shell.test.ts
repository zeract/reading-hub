import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(process.cwd(), "src/renderer/App.tsx"), "utf8");

describe("application shell source controls", () => {
  it("uses the reader focus control instead of a duplicate titlebar back button", () => {
    expect(app).not.toContain('aria-label="返回列表"');
    expect(app).toContain("onToggleReaderOnly");
    expect(app).toContain("reader-focus-toggle");
  });

  it("renders source metadata icons and folder headings in the unified source list", () => {
    expect(app).toContain('className="source-section"');
    expect(app).toContain('id="source-heading"');
    expect(app).toContain('className="source-group-label"');
    expect(app).toContain('<AppIcon name="folder" />');
    expect(app).toContain("sourceIconKind(source)");
    expect(app).toContain('source-icon--');
    expect(app).toContain('function AppIcon({ name }');
    expect(app).not.toContain("RSSHub 路由");
  });
});
