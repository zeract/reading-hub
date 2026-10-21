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
 * One already-sanitised FormulaDocument expression. The reader supplies a
 * lexical macro snapshot for every item. Failed expressions remain explicit
 * results rather than invalidating unrelated formulas. The type deliberately
 * contains no URL, article HTML, or credential
 * material.
 */
export interface MathJaxDocumentExpression {
  tex: string;
  displayMode: boolean;
  macros: Record<string, MathMacroDefinition>;
}

// The component package exports a process-wide runtime, even when callers
// construct separate adapters. Serialize promise conversions so a package/font
// load cannot interleave another expression's macro/label reset.
let conversionQueue: Promise<void> = Promise.resolve();
let runtimeStartup: Promise<MathJaxRuntime> | undefined;

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
      this.runtime.tex2mml("\\begingroupSandbox");
      this.runtime.texReset();
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
    const convert = async () => {
      if (!this.runtime || !tex.trim()) return undefined;
      try {
        this.runtime.tex2mml("\\begingroupSandbox");
        this.runtime.texReset();
        const node = await this.runtime.tex2svgPromise(this.withMacroPrelude(tex, macros), {
          display: displayMode
        });
        return this.serializeRenderedNode(node);
      } catch {
        return undefined;
      }
    };
    const pending = conversionQueue.then(convert);
    conversionQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  /**
   * Render a document-scoped group in authored order.  MathJax's SVG adapter
   * is still invoked for each output anchor so prose can remain interleaved
   * with equations. Macro snapshots and resolved references are supplied by
   * the reader, not derived from successful rendering of earlier expressions.
   * Reject only the failed member; never substitute another math renderer.
   */
  async renderDocumentAsync(expressions: readonly MathJaxDocumentExpression[]): Promise<Array<string | undefined> | undefined> {
    if (!this.runtime) return undefined;
    const rendered: Array<string | undefined> = [];
    for (const expression of expressions) {
      if (!expression.tex.trim()) {
        rendered.push("");
        continue;
      }
      const html = await this.renderAsync(expression.tex, expression.displayMode, expression.macros);
      rendered.push(html);
    }
    return rendered;
  }

  private withMacroPrelude(tex: string, macros: Record<string, MathMacroDefinition>): string {
    const prelude = Object.entries(macros)
      .map(([name, definition]) => mathJaxMacroDeclaration(name, definition))
      .join("");
    return `${prelude}${tex}`;
  }

  private serializeRenderedNode(node: unknown): string | undefined {
    if (!this.runtime) return undefined;
    // MathJax annotates its SVG with source TeX and, on failure, with error
    // nodes. `sanitizeMathJaxSvg()` validates those signals *before* removing
    // data attributes, so an unknown command can never become a visually
    // plausible red SVG in Reader View.
    return sanitizeMathJaxSvg(this.runtime.startup.adaptor.outerHTML(node));
  }

  private async start(): Promise<void> {
    if (!runtimeStartup) {
      runtimeStartup = this.loadRuntime().catch((error) => {
        runtimeStartup = undefined;
        throw error;
      });
    }
    this.runtime = await runtimeStartup;
  }

  private async loadRuntime(): Promise<MathJaxRuntime> {
    // MathJax publishes a Node-safe CommonJS entry specifically for local
    // renderers. Loading that entry keeps this Electron main-process module
    // compatible with both production and the Electron-as-Node test runner.
    const runtime = require("mathjax") as MathJaxRuntime;
    if (!runtime) throw new Error("MathJax 未能加载。");
    await runtime.init({
      loader: { load: ["input/tex", "output/svg", "[tex]/cancel", "[tex]/begingroup"] },
      tex: {
        packages: {
          "[+]": ["base", "ams", "newcommand", "configmacros", "cancel", "begingroup"],
          // MathJax's default `noundefined` extension turns an unknown TeX
          // command into a red text glyph rather than a render failure. That
          // is useful in a browser authoring page, but unsafe for a reader:
          // it can look like a successfully rendered equation. Disable it so
          // unknown commands become explicit MathJax errors and fall back to
          // the reader's formatted TeX card when no safe recovery exists.
          "[-]": ["noundefined"]
        }
      }
    });
    return runtime;
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
  "mjx-container", "mjx-break", "svg", "defs", "g", "path", "use", "rect", "line",
  "polygon", "polyline", "circle", "ellipse", "text", "tspan"
]);

const SAFE_MATHJAX_SVG_ATTRIBUTES = new Set([
  "class", "jax", "overflow", "display", "xmlns", "xmlns:xlink", "width", "height", "viewBox",
  "preserveAspectRatio", "role", "focusable", "id", "d", "x", "y", "x1", "x2", "y1", "y2",
  "cx", "cy", "r", "rx", "ry", "points", "transform", "fill", "fill-opacity", "fill-rule",
  "stroke", "stroke-opacity", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit",
  "opacity", "font-size", "font-family", "href", "xlink:href", "size"
]);

const SAFE_DIMENSION = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:ex|em|px|pt|pc|cm|mm|in|%|)?$/i;
const SAFE_NUMBER_LIST = /^\s*-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?(?:[\s,]+-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?){0,7}\s*$/;
// MathJax emits an empty inert path for U+2061 (function application) in
// operator names such as `\operatorname{softcap}`. Empty geometry is safe;
// rejecting it made an otherwise valid entire scientific document fall back.
const SAFE_PATH_DATA = /^[a-zA-Z0-9,\s.\-+]*$/;
const SAFE_TRANSFORM = /^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\(\s*[-+0-9.eE,\s]+\)\s*)+$/;
const SAFE_MATHJAX_ID = /^MJX-[A-Za-z0-9_.:-]+$/;
const SAFE_MATHJAX_REFERENCE = /^#MJX-[A-Za-z0-9_.:-]+$/;
const SAFE_MATHJAX_BREAK_SIZE = /^(?:[1-9]|[1-5]\d|6[0-4])$/;

/** Exported for deterministic SVG-safety regression tests. */
export function sanitizeMathJaxSvg(rawHtml: string): string | undefined {
  const $ = load(rawHtml, { xmlMode: true }, false);
  const root = $.root();
  const container = root.children("mjx-container");
  if (container.length !== 1 || root.children().length !== 1) return undefined;
  const containerNode = container.get(0);
  if (!containerNode) return undefined;

  // MathJax 4's responsive tables defer the outer viewBox to browser-side
  // layout code. Reader View intentionally runs no MathJax scripts, so freeze
  // that declared geometry to an intrinsic SVG before discarding data attrs.
  // Keeping width=100% without its viewBox clips the table and stacks labels
  // on the equation even though every glyph path itself is valid.
  for (const node of container.children("svg[data-mjx-viewBox], svg[data-mjx-viewbox]").toArray()) {
    const svg = $(node);
    const box = (svg.attr("data-mjx-viewBox") || svg.attr("data-mjx-viewbox") || "").trim().split(/[\s,]+/).map(Number);
    const height = /^(\d+(?:\.\d+)?)(ex|em|px)$/.exec(svg.attr("height") || "");
    if (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0 || !height || Number(height[1]) <= 0) return undefined;
    const transform = svg.children("g").first().attr("transform") || "";
    const scale = /^scale\(([\d.]+),\s*(-?[\d.]+)\)\s+translate\(0,\s*(-?[\d.]+)\)$/.exec(transform);
    if (!scale || Number(scale[1]) <= 0 || Number(scale[2]) !== -Number(scale[1]) || box[0] !== 0 || Number(scale[3]) !== box[1]) return undefined;
    const width = box[2] / box[3] * Number(height[1]);
    if (!Number.isFinite(width) || width <= 0) return undefined;
    // Responsive output has already changed the root group from font units
    // into pixel coordinates and moved its origin to the top. Reusing the
    // pre-transform viewBox would apply the conversion twice and clip rows.
    const factor = Number(scale[1]);
    svg.attr("viewBox", `0 0 ${box[2] * factor} ${box[3] * factor}`).attr("width", `${width.toFixed(4)}${height[2]}`);
    svg.find("svg[data-table='true']").attr("class", "reader-math-table");
    svg.find("svg[data-labels='true']").attr("class", "reader-math-labels");
  }

  // MathJax 4 can split a single inline expression into several inert SVG
  // fragments, separated by its own `<mjx-break size="…">` marker.  The old
  // sanitizer assumed exactly one SVG and consequently rejected otherwise
  // valid formulas containing a relation or spacing break.  Accept this
  // precise generated shape only: SVG and break markers are direct children
  // of the MathJax container, at least one SVG is present, and break markers
  // contain whitespace only.  No arbitrary custom-element subtree crosses
  // the reader boundary.
  const directChildren = container.children().toArray();
  const directChildTag = (node: any) => node.tagName?.toLowerCase();
  if (!directChildren.some((node) => directChildTag(node) === "svg")
    || directChildren.some((node) => {
      const tag = directChildTag(node);
      return tag !== "svg" && tag !== "mjx-break";
    })
    || container.children("mjx-break").toArray().some((node: any) => {
      const children = node.children || [];
      return children.some((child: any) => child.type === "tag") || !/^\s*$/.test($(node).text());
    })) return undefined;

  // This has to happen before the structural sanitizer drops `data-*`
  // attributes. MathJax 4 reports ordinary parse failures through merror
  // nodes, while older/default `noundefined` output can be a red mtext glyph
  // carrying only the original unknown control word in `data-latex`.
  if (hasMathJaxSvgRenderFailure($, container)) return undefined;

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

/**
 * MathJax error output is still inert SVG, but it is not a valid rendering of
 * the article's mathematics. Reject it at the renderer boundary rather than
 * making later CSS or text heuristics guess whether a red glyph is an error.
 */
function hasMathJaxSvgRenderFailure($: ReturnType<typeof load>, container: any): boolean {
  if (container.find("mjx-merror, merror, [data-mml-node='merror'], [data-mjx-error]").length) return true;

  // Defensive compatibility for output produced before `noundefined` was
  // disabled above. Legitimate red math is represented by an mstyle node or
  // normal glyph path; only the extension's bare unknown command mtext is an
  // error signature.
  return container.find("[data-mml-node='mtext'][data-latex]").toArray().some((node: any) => {
    const element = $(node);
    const source = (element.attr("data-latex") || "").trim();
    return /^\\[A-Za-z]+$/.test(source)
      && isMathJaxErrorPaint(element.attr("fill"))
      && isMathJaxErrorPaint(element.attr("stroke"));
  });
}

function isMathJaxErrorPaint(value: string | undefined): boolean {
  return /^(?:red|#f00(?:000)?|rgb\(255\s*,\s*0\s*,\s*0\))$/i.test((value || "").trim());
}

function isSafeMathJaxSvgAttribute(tag: string, name: string, value: string, definedGlyphIds: Set<string>): boolean {
  if (/^(?:on|data-)/i.test(name) || name.toLowerCase() === "style") return false;
  if (!SAFE_MATHJAX_SVG_ATTRIBUTES.has(name)) return false;
  if (name === "href" || name === "xlink:href") {
    return tag === "use" && SAFE_MATHJAX_REFERENCE.test(value) && definedGlyphIds.has(value.slice(1));
  }
  if (name === "xmlns") return tag === "svg" && value === "http://www.w3.org/2000/svg";
  if (name === "xmlns:xlink") return tag === "svg" && value === "http://www.w3.org/1999/xlink";
  if (name === "class") return (tag === "mjx-container" && value === "MathJax")
    || (tag === "svg" && /^(?:reader-math-table|reader-math-labels)$/.test(value));
  if (name === "jax") return tag === "mjx-container" && value === "SVG";
  if (name === "overflow") return tag === "mjx-container" && value === "overflow";
  if (name === "display") return tag === "mjx-container" && /^(?:true|false)$/.test(value);
  if (name === "role") return tag === "svg" && value === "img";
  if (name === "focusable") return tag === "svg" && value === "false";
  if (name === "id") return SAFE_MATHJAX_ID.test(value);
  if (name === "size") return tag === "mjx-break" && SAFE_MATHJAX_BREAK_SIZE.test(value);
  // Display MathJax SVG uses `width="full"` on its outer container to mean
  // "occupy the equation line". It is an inert renderer-owned keyword, not a
  // CSS length, and rejecting it used to make every native align/tag formula
  // silently fall back even though the SVG itself was otherwise safe.
  if (tag === "mjx-container" && name === "width" && value === "full") return true;
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
  tex2mml(tex: string): string;
  texReset(): void;
  startup: {
    adaptor: { outerHTML(node: unknown): string };
  };
};
