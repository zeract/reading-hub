import { load } from "cheerio";

/** A safe, parsed macro declaration passed from the reader Formula IR. */
export interface MathMacroDefinition {
  body: string;
  /** MathJax's optional array/config arity, constrained by the parser to 0–9. */
  argumentCount?: number;
  /** Optional first-argument default from `\\newcommand` / MathJax config. */
  defaultValue?: string;
}

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
    if (!this.startup) {
      this.startup = this.start().catch((error) => {
        // A temporary module/package load failure must not poison this local
        // renderer forever. Keep the failure isolated to the current read and
        // allow a later user action to start a fresh, safe runtime attempt.
        this.startup = undefined;
        throw error;
      });
    }
    return this.startup;
  }

  isReady(): boolean {
    return Boolean(this.runtime);
  }

  render(tex: string, displayMode: boolean, macros: Record<string, MathMacroDefinition>): string | undefined {
    if (!this.runtime || !tex.trim()) return undefined;
    try {
      const node = this.runtime.tex2svg(this.withMacroPrelude(tex, macros), { display: displayMode });
      return this.serializeRenderedNode(node);
    } catch {
      return undefined;
    }
  }

  /**
   * Render through MathJax's promise API when the expression may cause an
   * on-demand package load. MathJax 4 intentionally rejects such work from
   * `tex2svg()` with a retry signal; the reader must await this path rather
   * than degrading valid authored formulas to raw TeX fallback cards.
   */
  async renderAsync(
    tex: string,
    displayMode: boolean,
    macros: Record<string, MathMacroDefinition>
  ): Promise<string | undefined> {
    if (!this.runtime || !tex.trim()) return undefined;
    try {
      const node = await this.runtime.tex2svgPromise(this.withMacroPrelude(tex, macros), {
        display: displayMode
      });
      return this.serializeRenderedNode(node);
    } catch {
      return undefined;
    }
  }

  private withMacroPrelude(tex: string, macros: Record<string, MathMacroDefinition>): string {
    const prelude = Object.entries(macros)
      .map(([name, definition]) => mathJaxMacroDeclaration(name, definition))
      .join("");
    return `${prelude}${tex}`;
  }

  private serializeRenderedNode(node: unknown): string | undefined {
    if (!this.runtime) return undefined;
    // MathJax annotates most SVG groups with the source TeX for debugging.
    // The attributes are not needed after local rendering and can expose raw
    // commands through selection or inspection, so retain paths only.
    const html = sanitizeMathJaxSvg(this.runtime.startup.adaptor.outerHTML(node));
    if (!html) return undefined;
    // MathJax represents parse failures in this explicit node. Keep the
    // caller's safe TeX fallback rather than exposing a red MathJax error.
    // A few malformed, browser-mutated source fragments do not produce an
    // merror: MathJax can leave a literal TeX tail next to a partly rendered
    // expression. Let KaTeX's strict fallback handle those as one block
    // instead of showing the user a visually plausible but corrupted formula.
    const renderedText = html.replace(/<[^>]*>/g, "");
    if (/<mjx-merror\b|<mjx-spacer\b/i.test(html)) return undefined;
    return /\\(?:[A-Za-z]+|[{}\[\]\\])/i.test(renderedText) ? undefined : html;
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

/**
 * MathJax is a local renderer, but the TeX and macro declarations still come
 * from an untrusted remote article.  Its SVG output is inserted after the
 * regular reader HTML pass, so it needs a dedicated structural sanitizer
 * rather than relying on the reader's ordinary HTML allowlist.
 *
 * In particular, MathJax preserves `\\href` as an SVG `<a>`.  Reader View does
 * not need interactive links inside formulas, and allowing one would create a
 * second URL-bearing markup path that bypasses `safeUrl()`.  Unwrap anchors to
 * retain the rendered glyphs while dropping all link behaviour.  Any SVG node
 * outside MathJax's small rendering vocabulary causes a safe formula fallback.
 */
const SAFE_MATHJAX_SVG_TAGS = new Set([
  "mjx-container", "svg", "defs", "g", "path", "use", "rect", "line",
  "polygon", "polyline", "circle", "ellipse", "text", "tspan"
]);

const SAFE_MATHJAX_SVG_ATTRIBUTES = new Set([
  "class", "jax", "overflow", "display", "xmlns", "xmlns:xlink", "width", "height", "viewBox",
  "preserveAspectRatio", "role", "focusable", "id", "d", "x", "y", "x1", "x2", "y1", "y2",
  "cx", "cy", "r", "rx", "ry", "points", "transform", "fill", "fill-opacity", "fill-rule",
  "stroke", "stroke-opacity", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit",
  "opacity", "font-size", "font-family", "href", "xlink:href"
]);

const SAFE_DIMENSION = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:ex|em|px|pt|pc|cm|mm|in|%|)?$/i;
const SAFE_NUMBER_LIST = /^\s*-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?(?:[\s,]+-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?){0,7}\s*$/;
const SAFE_PATH_DATA = /^[a-zA-Z0-9,\s.\-+]+$/;
const SAFE_TRANSFORM = /^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\(\s*[-+0-9.eE,\s]+\)\s*)+$/;
const SAFE_MATHJAX_ID = /^MJX-[A-Za-z0-9_.:-]+$/;
const SAFE_MATHJAX_REFERENCE = /^#MJX-[A-Za-z0-9_.:-]+$/;

/** Exported for deterministic SVG-safety regression tests. */
export function sanitizeMathJaxSvg(rawHtml: string): string | undefined {
  const $ = load(rawHtml, { xmlMode: true }, false);
  const root = $.root();
  const container = root.children("mjx-container");
  if (container.length !== 1 || root.children().length !== 1 || container.children("svg").length !== 1) return undefined;
  const containerNode = container.get(0);
  if (!containerNode) return undefined;

  // MathJax uses `<a>` for `\href`. It is not needed in Reader View, so unwrap
  // it before validating the remaining graph. This retains the glyphs but
  // prevents TeX from creating a second link/URL execution surface.
  container.find("a").each((_index, node) => {
    const anchor = $(node);
    anchor.replaceWith(anchor.contents());
  });

  // `<use>` is the only URL-bearing SVG feature that MathJax needs. Bind it
  // to actual glyph paths in this SVG's own <defs>, never merely to a string
  // that happens to look like an internal fragment.
  const definedGlyphIds = new Set(
    container.find("svg defs [id]").toArray()
      .map((node) => $(node).attr("id") || "")
      .filter((id) => SAFE_MATHJAX_ID.test(id))
  );

  // Process the container as well as descendants. Cheerio serialises all
  // attributes safely, and the explicit allowlist prevents generated SVG from
  // carrying active browser features into the renderer.
  const nodes = [containerNode, ...container.find("*").toArray()];
  for (const node of nodes) {
    const element = $(node);
    const tag = node.tagName?.toLowerCase();
    if (!tag) continue;
    if (!SAFE_MATHJAX_SVG_TAGS.has(tag)) return undefined;
    for (const [name, value] of Object.entries(node.attribs || {})) {
      if (name.toLowerCase() === "style") {
        const safeStyle = sanitizeMathJaxSvgStyle(tag, value);
        if (safeStyle) element.attr(name, safeStyle);
        else element.removeAttr(name);
        continue;
      }
      if (!isSafeMathJaxSvgAttribute(tag, name, value, definedGlyphIds)) {
        // A missing glyph/path/reference can make an otherwise plausible
        // formula visually incorrect.  Prefer the safe TeX fallback over a
        // partial SVG when a geometry-bearing attribute is malformed.
        if (isCriticalMathJaxSvgAttribute(tag, name)) return undefined;
        element.removeAttr(name);
      }
    }
  }

  const output = root.html() || "";
  return /<mjx-container\b[^>]*><svg\b/i.test(output) ? output : undefined;
}

function isSafeMathJaxSvgAttribute(tag: string, name: string, value: string, definedGlyphIds: Set<string>): boolean {
  if (/^(?:on|data-)/i.test(name) || name.toLowerCase() === "style") return false;
  if (!SAFE_MATHJAX_SVG_ATTRIBUTES.has(name)) return false;
  if (name === "href" || name === "xlink:href") {
    return tag === "use" && SAFE_MATHJAX_REFERENCE.test(value) && definedGlyphIds.has(value.slice(1));
  }
  if (name === "xmlns") return tag === "svg" && value === "http://www.w3.org/2000/svg";
  if (name === "xmlns:xlink") return tag === "svg" && value === "http://www.w3.org/1999/xlink";
  if (name === "class") return tag === "mjx-container" && value === "MathJax";
  if (name === "jax") return tag === "mjx-container" && value === "SVG";
  if (name === "overflow") return tag === "mjx-container" && value === "overflow";
  if (name === "display") return tag === "mjx-container" && /^(?:true|false)$/.test(value);
  if (name === "role") return tag === "svg" && value === "img";
  if (name === "focusable") return tag === "svg" && value === "false";
  if (name === "id") return SAFE_MATHJAX_ID.test(value);
  if (["width", "height", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "stroke-width", "stroke-miterlimit"].includes(name)) {
    return SAFE_DIMENSION.test(value);
  }
  if (name === "viewBox" || name === "points") return SAFE_NUMBER_LIST.test(value);
  if (name === "d") return tag === "path" && SAFE_PATH_DATA.test(value);
  if (name === "transform") return SAFE_TRANSFORM.test(value);
  if (["opacity", "fill-opacity", "stroke-opacity"].includes(name)) return SAFE_DIMENSION.test(value);
  if (name === "fill" || name === "stroke") return /^(?:none|currentColor|#[0-9a-f]{3,8}|[a-z]+)$/i.test(value);
  if (name === "fill-rule") return /^(?:nonzero|evenodd)$/.test(value);
  if (name === "stroke-linecap") return /^(?:butt|round|square)$/.test(value);
  if (name === "stroke-linejoin") return /^(?:miter|round|bevel)$/.test(value);
  if (name === "font-size") return (tag === "text" || tag === "tspan") && SAFE_DIMENSION.test(value);
  if (name === "font-family") return (tag === "text" || tag === "tspan") && /^(?:serif|sans-serif|monospace)$/.test(value);
  if (name === "preserveAspectRatio") return /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/.test(value);
  return false;
}

function isCriticalMathJaxSvgAttribute(tag: string, name: string): boolean {
  if (name === "href" || name === "xlink:href") return tag === "use";
  if (name === "d") return tag === "path";
  if (name === "transform") return true;
  return ["width", "height", "viewBox", "points", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry"].includes(name);
}

/**
 * MathJax uses a tiny amount of inline SVG presentation for baseline and
 * line-weight fidelity.  Accept only one known declaration per appropriate
 * tag; arbitrary CSS (including url(), fixed positioning or variables) never
 * crosses this boundary.
 */
function sanitizeMathJaxSvgStyle(tag: string, value: string): string | undefined {
  const verticalAlign = value.match(/^\s*vertical-align\s*:\s*(-?(?:\d+(?:\.\d+)?|\.\d+)(?:ex|em|px))\s*;?\s*$/i);
  if (tag === "svg" && verticalAlign) return `vertical-align: ${verticalAlign[1]};`;
  const strokeWidth = value.match(/^\s*stroke-width\s*:\s*(-?(?:\d+(?:\.\d+)?|\.\d+)(?:ex|em|px))\s*;?\s*$/i);
  if (tag === "path" && strokeWidth) return `stroke-width: ${strokeWidth[1]};`;
  return undefined;
}

/**
 * Emit declarations rather than relying on an object-shaped MathJax config.
 * This preserves macro arity in the isolated renderer without evaluating any
 * source JavaScript. Names and bodies were validated by the reader parser.
 */
function mathJaxMacroDeclaration(name: string, definition: MathMacroDefinition): string {
  const macroName = name.startsWith("\\") ? name : `\\${name}`;
  const arity = Number.isInteger(definition.argumentCount) && definition.argumentCount! > 0
    ? `[${definition.argumentCount}]`
    : "";
  const defaultValue = arity && definition.defaultValue !== undefined
    ? `[${definition.defaultValue}]`
    : "";
  return `\\newcommand{${macroName}}${arity}${defaultValue}{${definition.body}}`;
}

type MathJaxRuntime = {
  init(config: unknown): Promise<void>;
  tex2svg(tex: string, options: { display: boolean }): unknown;
  tex2svgPromise(tex: string, options: { display: boolean }): Promise<unknown>;
  startup: {
    adaptor: { outerHTML(node: unknown): string };
  };
};
