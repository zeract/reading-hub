import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function rendererFile(name: string): string {
  return readFileSync(resolve(process.cwd(), "src/renderer", name), "utf8");
}

const app = rendererFile("App.tsx");
const libraryPane = rendererFile("library-pane.tsx");
const readerView = rendererFile("reader-view.tsx");
const sourceDialogs = rendererFile("source-dialogs.tsx");
const icons = rendererFile("ui-icons.tsx");
const libraryData = rendererFile("use-library-data.ts");

describe("application shell source controls", () => {
  it("uses the reader focus control instead of a duplicate titlebar back button", () => {
    expect(app).not.toContain('aria-label="返回列表"');
    expect(readerView).toContain("onToggleReaderOnly");
    expect(readerView).toContain("reader-focus-toggle");
  });

  it("renders source metadata icons and folder headings in the unified source list", () => {
    expect(libraryPane).toContain('className="source-section"');
    expect(libraryPane).toContain('id="source-heading"');
    expect(libraryPane).toContain('className="source-group-label"');
    expect(libraryPane).toContain('<AppIcon name="folder" />');
    expect(icons).toContain("sourceIconKind(source)");
    expect(icons).toContain("window.reader.loadSourceIcon(source.id)");
    expect(icons).toContain('source-icon--');
    expect(icons).toContain('function AppIcon({ name }');
    expect(sourceDialogs).not.toContain("RSSHub 路由");
  });

  it("offers OPML import alongside a single public source probe", () => {
    expect(sourceDialogs).toContain("导入 OPML…");
    expect(app).toContain("window.reader.importOpml()");
  });

  it("keeps the shell as composition rather than a second feature implementation", () => {
    expect(app).toContain('from "./library-pane"');
    expect(app).toContain('from "./reader-view"');
    expect(app).toContain('from "./source-dialogs"');
    expect(app).toContain('from "./settings-view"');
    expect(app).toContain('from "./use-library-data"');
    expect(app).not.toContain("function ReaderAssistant");
    expect(app).not.toContain("function SourceSettingsDialog");
    expect(libraryData).toContain("reloadSequence");
    expect(libraryData).toContain("requiresSourceReload");
  });

  it("keeps keyword search local to the selected source timeline", () => {
    expect(libraryPane).toContain('className="entry-search"');
    expect(libraryPane).toContain("搜索 ${activeSource.title} 中的帖子");
    expect(libraryPane).toContain("不会读取或保存文章全文");
    expect(libraryData).toContain("setEntrySearchState(\"\")");
    expect(libraryData).toContain("resetEntryPages();\n    setEntrySearchState(search)");
  });
});
