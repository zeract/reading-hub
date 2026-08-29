import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PreviewDialog } from "../src/renderer/source-dialogs";

const styles = readFileSync(resolve(process.cwd(), "src/renderer/styles.css"), "utf8");

describe("source preview dialog", () => {
  it("keeps the scrolling preview body separate from the fixed confirmation actions", () => {
    const html = renderToStaticMarkup(<PreviewDialog
      busy={false}
      onCancel={() => undefined}
      onConfirm={() => undefined}
      pending={{
        token: "preview-token",
        probe: {
          confidence: 0.9,
          kind: "generic",
          preview: [{
            title: "A deliberately very long source item title that must not widen the preview dialog beyond its available space",
            summary: "A deliberately very long source item summary that must stay inside the preview list instead of creating a horizontal scrollbar.",
            url: "https://example.com/an-entry"
          }],
          requiresReview: false,
          title: "Example source",
          url: "https://example.com"
        }
      }}
    />);

    expect(html).toContain('class="dialog dialog--preview"');
    expect(html).toContain('class="preview-dialog__body"');
    expect(html).toContain('class="preview-list preview-list--source"');
    expect(html).toContain('class="preview-source-title"');
    expect(html).toContain('class="dialog-actions dialog-actions--fixed"');
    expect(html).toContain('title="A deliberately very long source item title');
    expect(html).toContain('role="listitem"');
  });

  it("constrains preview content to its own vertical scroller without allowing a horizontal one", () => {
    expect(styles).toMatch(/\.dialog--preview\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/\.preview-dialog__body\s*\{[^}]*min-width:\s*0;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto/s);
    expect(styles).toMatch(/\.preview-list\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*grid-template-columns:\s*minmax\(0,1fr\);[^}]*overflow-x:\s*hidden/s);
    expect(styles).toMatch(/\.preview-list strong\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/s);
    expect(styles).toMatch(/\.preview-source-title\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/s);
    expect(styles).toMatch(/\.dialog-actions--fixed\s*\{[^}]*flex:\s*0\s+0\s+auto;[^}]*border-top:/s);
  });
});
