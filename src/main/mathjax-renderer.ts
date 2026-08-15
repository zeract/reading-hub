/**
 * Local MathJax 4 adapter for pages that author their formulas for MathJax.
 * It intentionally runs only in the main process and returns inert SVG. SVG
 * keeps every delimiter as a path, so the reader never depends on MathJax
 * CHTML's stylesheet to hide its internal stretch spacer text.
 */
export class ScientificMathRenderer {
  private runtime?: MathJaxRuntime;
  private startup?: Promise<void>;

  async ready(): Promise<void> {
    if (!this.startup) this.startup = this.start();
    return this.startup;
  }

  isReady(): boolean {
    return Boolean(this.runtime);
  }

  render(tex: string, displayMode: boolean, macros: Record<string, string>): string | undefined {
    if (!this.runtime || !tex.trim()) return undefined;
    try {
      const prelude = Object.entries(macros)
        .map(([name, definition]) => `\\newcommand{${name}}{${definition}}`)
        .join("");
      const node = this.runtime.tex2svg(`${prelude}${tex}`, { display: displayMode });
      // MathJax annotates most SVG groups with the source TeX for debugging.
      // The attributes are not needed after local rendering and can expose raw
      // commands through selection or inspection, so retain paths only.
      const html = this.runtime.startup.adaptor.outerHTML(node).replace(/\sdata-latex="[^"]*"/g, "");
      // MathJax represents parse failures in this explicit node. Keep the
      // caller's safe TeX fallback rather than exposing a red MathJax error.
      // A few malformed, browser-mutated source fragments do not produce an
      // merror: MathJax can leave a literal TeX tail next to a partly rendered
      // expression. Let KaTeX's strict fallback handle those as one block
      // instead of showing the user a visually plausible but corrupted formula.
      const renderedText = html.replace(/<[^>]*>/g, "");
      if (/<mjx-merror\b|<mjx-spacer\b/i.test(html)) return undefined;
      return /\\(?:[A-Za-z]+|[{}\[\]\\])/i.test(renderedText) ? undefined : html;
    } catch {
      return undefined;
    }
  }

  private async start(): Promise<void> {
    // MathJax publishes a Node-safe CommonJS entry specifically for local
    // renderers. Loading that entry keeps this Electron main-process module
    // compatible with both production and the Electron-as-Node test runner.
    const runtime = require("mathjax") as MathJaxRuntime;
    if (!runtime) throw new Error("MathJax 未能加载。");
    await runtime.init({
      loader: { load: ["input/tex", "output/svg"] },
      tex: { packages: { "[+]": ["base", "ams", "newcommand", "configmacros"] } }
    });
    this.runtime = runtime;
  }
}

type MathJaxRuntime = {
  init(config: unknown): Promise<void>;
  tex2svg(tex: string, options: { display: boolean }): unknown;
  startup: {
    adaptor: { outerHTML(node: unknown): string };
  };
};
