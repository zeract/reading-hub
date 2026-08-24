import path from "node:path";
import { readFile } from "node:fs/promises";
import { BrowserWindow, app } from "electron";
import { load } from "cheerio";
import type { ReaderArticle } from "../shared/types";

type VisualViewport = { name: string; width: number; height: number; zoom: number };
type FormulaGeometry = {
  hasTag: boolean;
  collision: boolean;
  escapesBody: boolean;
  horizontallyScrollable: boolean;
  /** A normal-width tag must be visible without scrolling its equation row. */
  tagEscapesVisibleArea: boolean;
};
type LayoutGeometry = {
  pageOverflow: boolean;
  formulas: FormulaGeometry[];
  imagesEscapeBody: boolean;
};

const VISUAL_VIEWPORTS: VisualViewport[] = [
  { name: "窄窗口", width: 1024, height: 768, zoom: 1 },
  { name: "默认窗口", width: 1280, height: 800, zoom: 1 },
  { name: "125% 字号", width: 1440, height: 900, zoom: 1.25 }
];

// Audits must not trigger an unmediated request for every article image.
// Preserve the intrinsic aspect-ratio/layout path while replacing remote
// sources with a locally-owned inert placeholder.
const AUDIT_IMAGE = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='1800' height='900'><rect width='100%' height='100%' fill='#d6cec0'/></svg>");

/**
 * Runs in the explicit local reader audit mode for any article that contains
 * display math. It receives already sanitised, in-memory HTML, never writes
 * it to disk, and reports layout diagnostics only. Remote images are disabled.
 */
export class ScientificArticleVisualAuditor {
  private window?: BrowserWindow;
  private styles?: Promise<string>;

  async inspect(article: ReaderArticle): Promise<string[]> {
    const articleDom = load(`<div id="reader-audit-math">${article.contentHtml}</div>`);
    if (!articleDom("#reader-audit-math [data-reader-equation], #reader-audit-math .katex-display, #reader-audit-math mjx-container[display='true']").length) return [];
    const visualWindow = this.getWindow();
    const diagnostics: string[] = [];
    const page = await this.page(article.contentHtml);
    for (const viewport of VISUAL_VIEWPORTS) {
      visualWindow.setSize(viewport.width, viewport.height);
      visualWindow.webContents.setZoomFactor(viewport.zoom);
      await visualWindow.loadURL(`data:text/html;base64,${Buffer.from(page).toString("base64")}`);
      const geometry = await visualWindow.webContents.executeJavaScript(`(() => {
        const body = document.querySelector(".article-body");
        if (!body) return { pageOverflow: true, formulas: [], imagesEscapeBody: true };
        const bodyRect = body.getBoundingClientRect();
        const overlaps = (left, right) => Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left)) > .5
          && Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top)) > .5;
        const owned = [...body.querySelectorAll("[data-reader-equation]")];
        const legacyKatex = [...body.querySelectorAll(".katex-display")].filter((formula) => !formula.closest("[data-reader-equation]"));
        const legacyMathJax = [...body.querySelectorAll("mjx-container[display='true']")].filter((formula) => !formula.closest("[data-reader-equation]"));
        const formulas = [...owned, ...legacyKatex, ...legacyMathJax].map((formula) => {
          const rect = formula.getBoundingClientRect();
          const tag = formula.querySelector(".reader-equation__tag");
          const bases = [...formula.querySelectorAll(".reader-equation__content > .katex, .reader-equation__content > mjx-container, :scope > .katex")];
          const tagRect = tag?.getBoundingClientRect();
          const baseRects = bases.map((base) => base.getBoundingClientRect());
          const collision = Boolean(tagRect && baseRects.some((base) => overlaps(tagRect, base)));
          return {
            hasTag: Boolean(tagRect),
            collision,
            escapesBody: rect.left < bodyRect.left - 1 || rect.right > bodyRect.right + 1,
            horizontallyScrollable: formula.scrollWidth > formula.clientWidth + 1,
            tagEscapesVisibleArea: Boolean(tagRect && (tagRect.left < rect.left - 1 || tagRect.right > rect.right + 1))
          };
        });
        const imagesEscapeBody = [...body.querySelectorAll("img")].some((image) => {
          const rect = image.getBoundingClientRect();
          return rect.left < bodyRect.left - 1 || rect.right > bodyRect.right + 1;
        });
        return {
          pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          formulas,
          imagesEscapeBody
        };
      })()`) as LayoutGeometry;
      if (geometry.pageOverflow) diagnostics.push(`${viewport.name}：页面出现非预期横向滚动`);
      if (geometry.imagesEscapeBody) diagnostics.push(`${viewport.name}：图片超出正文列宽`);
      geometry.formulas.forEach((formula, index) => {
        if (formula.collision) diagnostics.push(`${viewport.name}：第 ${index + 1} 个公式编号与主体重叠`);
        if (formula.escapesBody) diagnostics.push(`${viewport.name}：第 ${index + 1} 个公式超出正文列宽`);
        if (formula.hasTag && !formula.horizontallyScrollable && formula.tagEscapesVisibleArea) {
          diagnostics.push(`${viewport.name}：第 ${index + 1} 个公式编号在非超宽公式中被裁切`);
        }
        // A formula that is intrinsically wider than the column is valid only
        // when the formula element itself owns the scrollable overflow.
        if (formula.horizontallyScrollable === false && formula.escapesBody) {
          diagnostics.push(`${viewport.name}：第 ${index + 1} 个超宽公式没有独立横向滚动`);
        }
      });
    }
    return [...new Set(diagnostics)];
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = undefined;
  }

  private getWindow(): BrowserWindow {
    if (!this.window || this.window.isDestroyed()) {
      this.window = new BrowserWindow({
        show: false,
        width: 1280,
        height: 800,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
      });
    }
    return this.window;
  }

  private async page(contentHtml: string): Promise<string> {
    const styles = await this.loadStyles();
    const content = load(`<div id="audit-content">${contentHtml}</div>`);
    content("img").attr("src", AUDIT_IMAGE).removeAttr("srcset");
    return `<!doctype html><html><head><meta charset="utf-8"><style>${styles}</style></head><body>
      <section class="reader-view reader--scientific" data-reader-preset="reading" style="--reader-font-scale: 1">
        <div class="reader-workspace"><div class="reader-scroll"><article class="reader-article"><div class="article-body">${content("#audit-content").html() || ""}</div></article></div></div>
      </section>
    </body></html>`;
  }

  private async loadStyles(): Promise<string> {
    if (!this.styles) {
      const root = app.getAppPath();
      this.styles = Promise.all([
        readFile(path.join(root, "node_modules", "katex", "dist", "katex.min.css"), "utf8"),
        readFile(path.join(root, "src", "renderer", "styles.css"), "utf8")
      ]).then(([katex, reader]) => `${katex}\n${reader}`);
    }
    return this.styles;
  }
}
