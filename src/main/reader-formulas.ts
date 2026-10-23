import {load} from "cheerio";
import {randomUUID} from "node:crypto";
import katex from "katex";
import {splitEquationRows} from "./reader-equation-rows";
import {mergeMathMacros,katexMacros,extractMacroDeclarations,readTeXGroup,type MathMacroScope} from "./reader-math-macros";
import {inlineDollarMathAt} from "../shared/tex";
import type {ReaderFormulaDiagnostics,ReaderRenderProfile,ReaderArticle} from "../shared/types";
import {ScientificMathRenderer,type MathJaxDocumentExpression} from "./mathjax-renderer";
import {publicDocumentUrl as safeUrl} from "./html-document-url";
import {escapeHtml,normalText,isNodeWithinRoot} from "./reader-html";
const MATH_TOKEN_PREFIX = "[[READING_HUB_MATH_";
const MATH_TOKEN_SUFFIX = "]]";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type FormulaOrigin = "semantic" | "mathjax-script" | "mathjax-frame" | "text";
type FormulaRecord = { id: number; token: string; tex: string; displayMode: boolean; origin: FormulaOrigin };
/**
 * Formula policy is derived from the semantic document rather than its host.
 * A Zhihu repost of a MathJax-authored Scientific Spaces article therefore
 * receives the same renderer guarantees as the original article URL.
 */
export type FormulaRenderPolicy = "standard" | "scientific-document";
export type SanitizedContent = { html: string; formulaDiagnostics: ReaderFormulaDiagnostics; formulaRenderPolicy: FormulaRenderPolicy };
export type PreparedSanitizedContent = { html: string; formulas: FormulaDocument; formulaRenderPolicy: FormulaRenderPolicy };

/**
 * FormulaDocument is the single semantic boundary between an untrusted page
 * DOM and the reader's renderers. Every supported source form is reduced to
 * a record before noise removal or attribute sanitisation can erase its TeX.
 */
export class FormulaDocument {
  readonly records: FormulaRecord[] = [];
  // A generated anchor must not be forgeable by remote article text. A
  // predictable sequence lets an article inject a lookalike token which the
  // renderer could otherwise turn into a second formula. This nonce exists
  // only in memory for one extraction and is never persisted.
  private readonly tokenNamespace = randomUUID();

  add(tex: string, displayMode: boolean, origin: FormulaOrigin): string {
    const id = this.records.length;
    const token = `${MATH_TOKEN_PREFIX}${this.tokenNamespace}_${id}${MATH_TOKEN_SUFFIX}`;
    this.records.push({ id, token, tex: tex.trim(), displayMode, origin });
    return token;
  }

  get(index: number): FormulaRecord | undefined {
    return this.records[index];
  }

  tokenPattern(): RegExp {
    return new RegExp(`${escapeRegExp(MATH_TOKEN_PREFIX)}${this.tokenNamespace}_(\\d+)${escapeRegExp(MATH_TOKEN_SUFFIX)}`, "g");
  }

  anchorMarkup(record: FormulaRecord): string {
    return `<span data-reader-formula-document="${this.tokenNamespace}" data-reader-formula-anchor="${record.id}"></span>`;
  }

  anchorSelector(id: number): string {
    return `[data-reader-formula-document="${this.tokenNamespace}"][data-reader-formula-anchor="${id}"]`;
  }

  allAnchorsSelector(): string {
    return `[data-reader-formula-document="${this.tokenNamespace}"][data-reader-formula-anchor]`;
  }

  diagnostics(
    rendered: Set<number>,
    fallback: Set<number>,
    dropped: Set<number>,
    formulaRenderPolicy: FormulaRenderPolicy
  ): ReaderFormulaDiagnostics {
    const count = (origin: FormulaOrigin) => this.records.filter((record) => record.origin === origin).length;
    const display = (records: Iterable<number>) => [...records]
      .map((id) => this.get(id))
      .filter((record): record is FormulaRecord => Boolean(record?.displayMode)).length;
    return {
      total: this.records.length,
      semantic: count("semantic"),
      mathJaxScript: count("mathjax-script"),
      mathJaxFrame: count("mathjax-frame"),
      text: count("text"),
      display: this.records.filter((record) => record.displayMode).length,
      rendered: rendered.size,
      fallback: fallback.size,
      dropped: dropped.size,
      displayRendered: display(rendered),
      displayFallback: display(fallback),
      displayDropped: display(dropped),
      formulaRenderPolicy
    };
  }
}

/**
 * Choose a renderer from authored formula semantics, never from a provider
 * name.  The narrow standard path remains fast for independent expressions;
 * anything whose meaning depends on document order, labels, tags, or a
 * multi-row environment is compiled as one scientific document.
 */
export function chooseFormulaRenderPolicy(formulas: FormulaDocument, hasGlobalMacros = false): FormulaRenderPolicy {
  if (hasGlobalMacros) return "scientific-document";
  return formulas.records.some((record) => /\\(?:newcommand\*?|renewcommand\*?|providecommand\*?|DeclareMathOperator\*?|(?:g|e|x)?def|require|label|tag|eqref|ref)\b|\\begin\{(?:align\*?|gather\*?|multline\*?)\}/.test(record.tex))
    ? "scientific-document"
    : "standard";
}

export function effectiveReaderProfile(base: ReaderRenderProfile, formulaRenderPolicy: FormulaRenderPolicy): ReaderRenderProfile {
  return base === "scientific" || formulaRenderPolicy === "scientific-document" ? "scientific" : "standard";
}
/**
 * Some scientific bibliographies use lightweight TeX link commands directly
 * in HTML prose. They are not math and should become ordinary safe links,
 * rather than leaking a `\\url{…}` command into the reader.
 */
export function normaliseTeXCitationLinks($: ReturnType<typeof load>, root: any, pageUrl: string): void {
  const citation = /\\(?:url\{([^}\s]+)\}|href\{([^}\s]+)\}\{([^}]*)\})/g;
  const visit = (node: any, insideLiteral = false): void => {
    const tag = node.tagName?.toLowerCase();
    const literal = insideLiteral || tag === "code" || tag === "pre";
    for (const child of [...(node.children || [])]) {
      if (child.type === "text" && !literal) {
        const text = child.data || "";
        if (!citation.test(text)) continue;
        citation.lastIndex = 0;
        let cursor = 0;
        let result = "";
        let match: RegExpExecArray | null;
        while ((match = citation.exec(text))) {
          result += escapeHtml(text.slice(cursor, match.index));
          const href = safeUrl(match[1] || match[2], pageUrl);
          const label = normalText(match[3] || href || "");
          result += href ? `<a href="${escapeHtml(href)}">${escapeHtml(label || href)}</a>` : escapeHtml(match[0]);
          cursor = citation.lastIndex;
        }
        result += escapeHtml(text.slice(cursor));
        $(child).replaceWith(result);
      } else if (child.type === "tag") {
        visit(child, literal);
      }
    }
  };
  visit(root.get(0));
}

/**
 * Captures page-specific *semantic* formula carriers before any visual MathJax
 * copies or generic attribute stripping are considered. The selector is not
 * tied to a hostname: Zhihu is simply the current common producer of this
 * accessible `data-tex` contract, and syndicated content can carry it too.
 */
export function preserveSemanticFormulaCarriers($: ReturnType<typeof load>, root: any, formulas: FormulaDocument): void {
  const carriers = root.find(".ztext-math[data-tex], [data-reader-tex], [data-tex][data-eeimg]").toArray()
    .sort((left: any, right: any) => nodeDepth(left) - nodeDepth(right));
  for (const node of carriers) {
    if (!isNodeWithinRoot(root, node)) continue;
    const element = $(node);
    if (isLiteralMathContext(element)) continue;
    const tex = String(element.attr("data-tex") || element.attr("data-reader-tex") || "").trim();
    if (!tex) continue;
    const displayMode = semanticFormulaDisplayMode(element, tex);
    const normalised = displayMode ? tex.replace(/\\\\\s*$/, "").trim() : tex;
    if (!normalised) {
      element.remove();
      continue;
    }
    element.replaceWith(formulas.add(normalised, displayMode, "semantic"));
  }
}

/**
 * Keep authored layout semantics with the formula IR instead of inferring
 * display mode from the final KaTeX markup. Zhihu's public semantic carrier
 * uses `data-eeimg="2"` for a block equation and `"1"` for inline math;
 * this is an explicit source contract even when its optional block class is
 * absent. The check remains carrier-local, so unrelated page attributes never
 * influence ordinary text.
 */
function semanticFormulaDisplayMode(element: any, tex: string): boolean {
  return element.hasClass("ztext-math-block")
    || element.is("[data-display='true']")
    || element.is("[data-eeimg='2']")
    // Some older Zhihu payloads omit both display attributes and leave a
    // final line break as their only structural marker.
    || /\\\\\s*$/.test(tex);
}

function isLiteralMathContext(element: any): boolean {
  return element.is("code, pre") || element.parents("code, pre").length > 0;
}

/**
 * MathJax 2 stores TeX in script elements, which normally belong to the noise
 * list. Convert only explicitly-declared math scripts before the generic
 * sanitizer removes executable markup.
 */
export function preserveMathScripts($: ReturnType<typeof load>, root: any, formulas: FormulaDocument): void {
  root.find("script").each((_index: number, node: any) => {
    const script = $(node);
    if (!isMathScript(script)) return;
    const type = (script.attr("type") || "").toLowerCase();
    // Cheerio treats a script body as raw HTML, so `.text()` can be empty.
    const tex = (script.html() || script.text()).trim();
    if (!tex) {
      script.remove();
      return;
    }
    // MathJax's visual placeholder would otherwise survive as duplicate text.
    const previous = script.prev();
    if (previous.hasClass("MathJax_Preview")) previous.remove();
    // Keep a short-lived marker around an author-provided source script. A
    // browser-rendered MathJax frame often follows it as a sibling; that
    // frame is only a visual copy, and must not become a second reader
    // formula. The marker is collapsed back to plain placeholder text after
    // rendered MathJax has been reconciled below, so it never reaches the
    // renderer or user-visible HTML.
    const token = formulas.add(tex, type.includes("mode=display"), "mathjax-script");
    const index = formulas.records.length - 1;
    script.replaceWith(`<span data-reader-math-source="${index}">${token}</span>`);
  });
}

/**
 * A publisher may have already run MathJax or KaTeX before its HTML is
 * fetched. Prefer the original TeX embedded in an explicit annotation or
 * data attributes; this avoids both the preview/rendered duplicate and losing
 * formulas when the original script was removed by the site.
 */
export function preserveRenderedMath($: ReturnType<typeof load>, root: any, formulas: FormulaDocument): void {
  root.find(".MathJax_Preview").remove();
  const rendered = root.find("mjx-container, .MathJax, [id^='MathJax-'], .katex-display, .katex").toArray()
    // Work from the outer frame inward. A MathJax 2/3 wrapper often contains
    // several elements which all match this selector. Processing a child
    // first used to create a second token, then leave that token behind when
    // its outer frame was reconciled. The outer wrapper can discover a
    // descendant annotation/script itself, so it is the only node we need.
    .sort((left: any, right: any) => nodeDepth(left) - nodeDepth(right));
  for (const node of rendered) {
    const element = $(node);
    // Cheerio keeps a detached frame's descendant linked to that detached
    // parent after the frame is replaced. `parent().length` alone therefore
    // lets an already-consumed nested MathJax node append a ghost formula,
    // which can shift later equation numbers and macro scope. Only process
    // nodes still reachable from this reader root.
    if (!isNodeWithinRoot(root, node) || isLiteralMathContext(element)) continue;
    const tex = renderedMathSource(element);
    if (tex) {
      const displayMode = isRenderedMathDisplay(element);
      const authored = adjacentAuthoredMath($, element, formulas);
      if (authored && sameMathSource(authored.tex, tex)) {
        // The source script is authoritative. Keep its original position and
        // display mode, but prefer an explicit rendered block indication when
        // the source type omitted `mode=display`.
        authored.displayMode ||= displayMode;
        element.remove();
        continue;
      }
      element.replaceWith(formulas.add(tex, displayMode, element.is(".katex, .katex-display") ? "semantic" : "mathjax-frame"));
      continue;
    }
    // Without an explicit annotation, a KaTeX-looking class is not enough
    // evidence to infer TeX or delete authored text.
    if (element.is(".katex, .katex-display")) continue;
    // A child MathJax node may already have been replaced by its placeholder.
    // Unwrap that placeholder instead of discarding the entire formula.
    if (element.text().includes(MATH_TOKEN_PREFIX)) element.replaceWith(element.contents());
    else element.remove();
  }
  // Remove the temporary relation marker before generic sanitisation. In
  // particular, do not leave a block KaTeX result nested inside an inline
  // span, which creates browser-dependent layout/overlap behaviour.
  root.find("[data-reader-math-source]").each((_index: number, node: any) => {
    const marker = $(node);
    marker.replaceWith(marker.text());
  });
}

function nodeDepth(node: any): number {
  let depth = 0;
  for (let cursor = node?.parent; cursor; cursor = cursor.parent) depth += 1;
  return depth;
}

function renderedMathSource(element: any): string | undefined {
  // `data-mathml` is MathML, not TeX. Treating it as TeX makes the fallback
  // renderer emit a raw-source card even when the same frame has a valid TeX
  // annotation. Prefer explicit TeX fields, then the standard annotation or
  // original MathJax script. If a page retains only MathML, drop its rendered
  // shell rather than pretending it is parseable TeX.
  const direct = ["data-latex", "data-tex", "alttext"]
    .map((name) => element.attr(name))
    .find((value) => typeof value === "string" && value.trim());
  if (direct) return String(direct).trim();
  // MathJax 3 serialises its source as `<mjx-annotation>`, while MathJax 2
  // uses a standard MathML `<annotation>`. Support both explicitly: treating
  // only the latter as source silently removed every already-rendered MathJax
  // 3 equation when the static source script was unavailable.
  const annotation = element.find([
    "annotation[encoding='application/x-tex']",
    "annotation[encoding='application/x-tex; mode=display']",
    "mjx-annotation[encoding='application/x-tex']",
    "mjx-annotation[encoding='application/x-tex; mode=display']"
  ].join(", ")).first();
  const tex = annotation.text() || annotation.html() || "";
  if (tex.trim()) return tex.trim();
  // Some publisher serializers unwrap <semantics>/<annotation> while keeping
  // the annotation's source as the final direct text child of <math>. This
  // is still a paired KaTeX semantic/visual asset, not ordinary prose. Require
  // both halves and exactly one trailing source node; never infer TeX from a
  // KaTeX-looking class or from MathML presentation text alone.
  if (element.is(".katex, .katex-display") && element.find(".katex-html[aria-hidden='true']").length === 1) {
    const math = element.find(".katex-mathml > math");
    if (math.length === 1 && math.children().length > 0) {
      const contents = math.contents().toArray().filter((node: any) => node.type !== "text" || node.data.trim());
      const textNodes = contents.filter((node: any) => node.type === "text");
      const tail = contents[contents.length - 1] as any;
      if (textNodes.length === 1 && tail === textNodes[0]) return tail.data.trim();
    }
  }
  const script = element.find("script[type^='math/tex']").first();
  const scriptTex = script.html() || script.text() || "";
  return scriptTex.trim() || undefined;
}

function isRenderedMathDisplay(element: any): boolean {
  return element.is("[display='true'], .MathJax_Display, .katex-display")
    || element.parents("[display='true'], .MathJax_Display, .katex-display").length > 0
    || element.find("[display='true'], .MathJax_Display, .katex-display").length > 0;
}

/** Finds a source-script marker immediately beside a MathJax visual frame. */
function adjacentAuthoredMath($: ReturnType<typeof load>, element: any, formulas: FormulaDocument): FormulaRecord | undefined {
  // MathJax 2 pages usually leave the source script before the rendered
  // frame, but some renderer paths emit it after the frame. Both are the same
  // authored source once their TeX agrees, so inspect immediate non-whitespace
  // siblings on either side rather than relying on one DOM ordering.
  for (const direction of ["prev", "next"] as const) {
    let sibling = element.get(0)?.[direction];
    while (sibling?.type === "text" && !String(sibling.data || "").trim()) sibling = sibling[direction];
    if (sibling?.type !== "tag") continue;
    const marker = $(sibling);
    if (!marker.is("[data-reader-math-source]")) continue;
    const index = Number.parseInt(marker.attr("data-reader-math-source") || "", 10);
    if (Number.isSafeInteger(index) && index >= 0) return formulas.get(index);
  }
  return undefined;
}

/** Ignores source-format whitespace and top-level display wrappers only. */
function sameMathSource(left: string, right: string): boolean {
  return normaliseMathSourceForComparison(left) === normaliseMathSourceForComparison(right);
}

function normaliseMathSourceForComparison(value: string): string {
  let tex = value.trim();
  tex = tex.replace(/^\$\$([\s\S]*?)\$\$$/, "$1");
  tex = tex.replace(/^\\\[([\s\S]*?)\\\]$/, "$1");
  const environment = "equation\\*?|displaymath|align\\*?|gather\\*?|multline\\*?|array|cases|matrix|pmatrix|bmatrix|vmatrix|Vmatrix|smallmatrix|aligned";
  const wrappedEnvironment = new RegExp(`^\\\\begin\\{(${environment})\\}([\\s\\S]*?)\\\\end\\{\\1\\}$`);
  tex = tex.replace(wrappedEnvironment, "$2");
  return tex.replace(/\s+/g, " ").trim();
}

export function isMathScript(element: any): boolean {
  const tag = element.get(0)?.tagName?.toLowerCase();
  const type = (element.attr("type") || "").toLowerCase();
  return tag === "script" && (type.startsWith("math/tex") || type.startsWith("math/asciimath"));
}

/** Converts author-delimited TeX in static HTML into placeholders. */
export function preserveTextMath($: ReturnType<typeof load>, root: any, formulas: FormulaDocument): void {
  preserveMultilineTextMath($, root, formulas);
  const visit = (node: any, insideLiteral = false): void => {
    const tag = node.tagName?.toLowerCase();
    const literal = insideLiteral || tag === "code" || tag === "pre";
    for (const child of [...(node.children || [])]) {
      if (child.type === "text" && !literal) {
        const next = tokenizeMath(child.data || "", formulas);
        if (next !== child.data) child.data = next;
      } else if (child.type === "tag") {
        visit(child, literal);
      }
    }
  };
  visit(root.get(0));
}

/**
 * Some MathJax pages put display TeX in text nodes separated by <br> or inline
 * elements. A node-by-node pass cannot see the matching \begin and \end in
 * that form, so first tokenise the smallest enclosing element as one fragment.
 */
function preserveMultilineTextMath($: ReturnType<typeof load>, root: any, formulas: FormulaDocument): void {
  const environment = "(?:equation\\*?|align\\*?|gather\\*?|multline\\*?|array|cases|matrix|pmatrix|bmatrix|vmatrix|Vmatrix|smallmatrix|aligned)";
  const blockStart = new RegExp(`(?:\\\\begin\\{${environment}\\}|\\$\\$|\\\\\\\[)`);
  const candidates = root.find("*").toArray().filter((node: any) => {
    const element = $(node);
    const tag = node.tagName?.toLowerCase();
    if (tag === "code" || tag === "pre" || !blockStart.test(element.html() || "")) return false;
    return !element.children().toArray().some((child: any) => blockStart.test($(child).html() || ""));
  // A display formula can sit inside several nested list/div containers. Work
  // from the deepest live container outward, then re-check the *current* DOM
  // before each pass. Otherwise an ancestor can re-tokenise a placeholder
  // produced by a descendant into a second fake equation such as
  // `[[READING_HUB_MATH_0]]`, leaving a circular placeholder leak.
  }).sort((left: any, right: any) => nodeDepth(right) - nodeDepth(left));
  for (const node of candidates) {
    if (!isNodeWithinRoot(root, node)) continue;
    const element = $(node);
    const html = element.html() || "";
    if (!blockStart.test(html)) continue;
    let tokenised = html.replace(/\$\$([\s\S]*?)\$\$/g, (_all, body) => addMath(formulas, htmlToTeXText(body), true));
    tokenised = tokenised.replace(/\\\[([\s\S]*?)\\\]/g, (_all, body) => addMath(formulas, htmlToTeXText(body), true));
    tokenised = tokenised.replace(new RegExp(`\\\\begin\\{(${environment})\\}([\\s\\S]*?)\\\\end\\{\\1\\}`, "g"), (_all, name, body) => {
      const tex = normaliseDisplayEnvironment(name, htmlToTeXText(body));
      return addMath(formulas, tex, true);
    });
    if (tokenised !== html) element.html(tokenised);
  }
}

function htmlToTeXText(value: string): string {
  const $ = load(`<div id="reader-math-fragment">${value.replace(/<br\s*\/?\s*>/gi, "\n")}</div>`);
  return $("#reader-math-fragment").text().replace(/\u00a0/g, " ");
}

function tokenizeMath(value: string, formulas: FormulaDocument): string {
  // Consume outer author delimiters first. A display formula may contain a
  // nested valid-looking environment; parsing that inner fragment first
  // produces a placeholder inside another placeholder and leaves one token
  // unrendered after the single render pass.
  let result = value.replace(/\\\[([\s\S]*?)\\\]/g, (_all, tex) => addMath(formulas, tex, true));
  result = result.replace(/\$\$([\s\S]*?)\$\$/g, (_all, tex) => addMath(formulas, tex, true));
  result = result.replace(/\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}([\s\S]*?)\\end\{\1\}/g, (_all, environment, body) => {
    const tex = normaliseDisplayEnvironment(environment, body);
    return addMath(formulas, tex, true);
  });
  result = result.replace(/\\\(([^]*?)\\\)/g, (_all, tex) => addMath(formulas, tex, false));
  return tokenizeInlineDollarMath(result, formulas);
}

function normaliseDisplayEnvironment(environment: string, body: string): string {
  const content = body.trim();
  // Preserve authored multi-row environments in FormulaDocument. Rewriting
  // `align` to `aligned` looks visually similar for simple equations but
  // irreversibly discards per-row tag/label semantics before the scientific
  // renderer has a chance to interpret them.
  if (environment.startsWith("align") || environment.startsWith("gather") || environment.startsWith("multline")) {
    return `\\begin{${environment}}${content}\\end{${environment}}`;
  }
  return content;
}

function tokenizeInlineDollarMath(value: string, formulas: FormulaDocument): string {
  let output = "";
  for (let index = 0; index < value.length;) {
    const match = inlineDollarMathAt(value, index);
    if (!match) {
      output += value[index];
      index += 1;
      continue;
    }
    output += addMath(formulas, match.tex, false);
    index = match.end;
  }
  return output;
}

function addMath(formulas: FormulaDocument, tex: string, displayMode: boolean): string {
  return formulas.add(tex, displayMode, "text");
}

/**
 * Formula extraction uses private text markers while Cheerio is still
 * reshaping untrusted HTML. Turn them into generated DOM anchors only after
 * sanitisation is complete, so final rendering can replace exact nodes rather
 * than running a fragile first-occurrence string replacement over HTML.
 */
export function materializeFormulaAnchors($: ReturnType<typeof load>, root: any, formulas: FormulaDocument): void {
  const marker = formulas.tokenPattern();
  const textNodes: any[] = [];
  const visit = (node: any): void => {
    for (const child of node?.children || []) {
      if (child.type === "text" && String(child.data || "").includes(MATH_TOKEN_PREFIX)) textNodes.push(child);
      else if (child.type === "tag") visit(child);
    }
  };
  visit(root.get(0));
  for (const node of textNodes) {
    const value = String(node.data || "");
    marker.lastIndex = 0;
    let match: RegExpExecArray | null;
    let cursor = 0;
    let replacement = "";
    while ((match = marker.exec(value))) {
      replacement += escapeHtml(value.slice(cursor, match.index));
      const record = formulas.get(Number.parseInt(match[1], 10));
      replacement += record
        ? formulas.anchorMarkup(record)
        : escapeHtml(match[0]);
      cursor = marker.lastIndex;
    }
    if (!cursor) continue;
    replacement += escapeHtml(value.slice(cursor));
    $(node).replaceWith(replacement);
  }
}

type EquationMetadata = {
  /** Reader-owned tag for a simple one-line equation. */
  tag?: string;
  /** Kept for diagnostics/backwards-compatible simple-equation behavior. */
  label?: string;
  /** Multiple or explicit TeX tags belong to the scientific renderer itself. */
  nativeTags: boolean;
};
type EquationIndex = { labels: Map<string, string>; byToken: Map<string, EquationMetadata> };
type PreparedFormula = {
  record: FormulaRecord;
  macros: MathMacroScope;
};
type FormulaRenderPlan = {
  formulas: PreparedFormula[];
  equations: EquationIndex;
};

function createFormulaRenderPlan(
  $: ReturnType<typeof load>,
  root: any,
  formulas: FormulaDocument,
  globalMathMacros: MathMacroScope
): FormulaRenderPlan {
  const activeMacros: MathMacroScope = new Map(globalMathMacros);
  const prepared = formulaRecordsInDocumentOrder($, root, formulas).map((record): PreparedFormula => {
    // MathJax's package loader directives are not mathematical content. The
    // local SVG renderer loads its supported extensions explicitly, while
    // KaTeX needs the directive removed before its safe path runs.
    const declaration = extractMacroDeclarations(record.tex.replace(/\\require\{(?:cancel)\}/g, ""));
    // Macro state is intentionally snapshotted in document order. A later
    // declaration must never rewrite a formula which appeared earlier in the
    // article, and an unrelated page script must not enter this scope.
    mergeMathMacros(activeMacros, declaration.macros);
    return {
      record: { ...record, tex: declaration.tex },
      macros: new Map(activeMacros)
    };
  });
  return {
    formulas: prepared,
    equations: collectEquationMetadata(prepared.map((item) => item.record))
  };
}

/**
 * Formula carriers are extracted by semantic type for safety (data-tex,
 * source script, rendered MathJax, then plaintext), which is not necessarily
 * their authored order. The generated anchors are the canonical final DOM
 * order. Build macro snapshots and equation labels from that order so a
 * declaration in an earlier script can affect a later semantic carrier, but
 * never retroactively alter an earlier equation.
 */
function formulaRecordsInDocumentOrder($: ReturnType<typeof load>, root: any, formulas: FormulaDocument): FormulaRecord[] {
  const ordered: FormulaRecord[] = [];
  const seen = new Set<number>();
  root.find(formulas.allAnchorsSelector()).each((_index: number, node: any) => {
    const id = Number.parseInt($(node).attr("data-reader-formula-anchor") || "", 10);
    const record = Number.isSafeInteger(id) ? formulas.get(id) : undefined;
    if (record && !seen.has(record.id)) {
      ordered.push(record);
      seen.add(record.id);
    }
  });
  // Malformed or missing anchors are handled as integrity drops in
  // installFormulaOutput. Keep them at the tail only so they cannot change the
  // macro scope of any formula that is still visible in the document.
  for (const record of formulas.records) {
    if (!seen.has(record.id)) ordered.push(record);
  }
  return ordered;
}

export function renderMath(
  $: ReturnType<typeof load>,
  root: any,
  formulas: FormulaDocument,
  scientificMath: ScientificMathRenderer | undefined,
  globalMathMacros: MathMacroScope,
  formulaRenderPolicy: FormulaRenderPolicy
): SanitizedContent {
  const plan = createFormulaRenderPlan($, root, formulas, globalMathMacros);
  const output = formulaRenderPolicy === "scientific-document"
    ? renderScientificFormulaDocumentSynchronously(plan, scientificMath)
    : renderStandardFormulaDocumentSynchronously(plan, scientificMath);
  return installFormulaOutput($, root, formulas, plan, output, formulaRenderPolicy);
}

/**
 * MathJax 4 loads some TeX packages only through its promise API. Keep the
 * structural extraction and generated anchor handling identical to the sync
 * helper, but await actual formula rendering for the production reader.
 */
export async function renderMathAsync(
  $: ReturnType<typeof load>,
  root: any,
  formulas: FormulaDocument,
  scientificMath: ScientificMathRenderer | undefined,
  globalMathMacros: MathMacroScope,
  formulaRenderPolicy: FormulaRenderPolicy
): Promise<SanitizedContent> {
  const plan = createFormulaRenderPlan($, root, formulas, globalMathMacros);
  const output = await (formulaRenderPolicy === "scientific-document"
    ? renderScientificFormulaDocumentAsynchronously(plan, scientificMath)
    : renderStandardFormulaDocumentAsynchronously(plan, scientificMath));
  return installFormulaOutput($, root, formulas, plan, output, formulaRenderPolicy);
}

function renderStandardFormulaDocumentSynchronously(
  plan: FormulaRenderPlan,
  scientificMath: ScientificMathRenderer | undefined
): Map<number, string | undefined> {
  const output = new Map<number, string | undefined>();
  for (const item of plan.formulas) {
    output.set(item.record.id, renderFormula(item, plan.equations, scientificMath, "sync"));
  }
  return output;
}

async function renderStandardFormulaDocumentAsynchronously(
  plan: FormulaRenderPlan,
  scientificMath: ScientificMathRenderer | undefined
): Promise<Map<number, string | undefined>> {
  const output = new Map<number, string | undefined>();
  for (const item of plan.formulas) {
    output.set(item.record.id, await renderFormula(item, plan.equations, scientificMath, "async"));
  }
  return output;
}

/**
 * Scientific formulas share one document semantic plan and one renderer.
 * Macro snapshots and equation references are resolved before rendering, so
 * one malformed/unsupported expression can safely fall back without discarding
 * every valid expression. Unavailable runtimes still reject the whole group.
 */
function renderScientificFormulaDocumentSynchronously(
  plan: FormulaRenderPlan,
  scientificMath: ScientificMathRenderer | undefined
): Map<number, string | undefined> {
  // `extractReaderArticle()` is the deterministic synchronous test/helper
  // API. It cannot start MathJax's asynchronous module loader, so retain the
  // safe KaTeX compatibility path here. User-visible reads always use the
  // async path below, which starts MathJax before a scientific document is
  // rendered and never mixes the two renderers.
  if (!scientificMath?.isReady()) return renderStandardFormulaDocumentSynchronously(plan, undefined);
  const output = new Map<number, string | undefined>();
  for (const item of plan.formulas) {
    if (!item.record.tex.trim()) {
      output.set(item.record.id, "");
      continue;
    }
    const rendered = renderScientificFormula(item, plan.equations, scientificMath);
    output.set(item.record.id, rendered);
  }
  return output;
}

async function renderScientificFormulaDocumentAsynchronously(
  plan: FormulaRenderPlan,
  scientificMath: ScientificMathRenderer | undefined
): Promise<Map<number, string | undefined>> {
  const failed = (): Map<number, string | undefined> => new Map(plan.formulas.map((item) => [item.record.id, undefined]));
  if (!scientificMath?.isReady()) return failed();
  if (typeof scientificMath.renderDocumentAsync !== "function") {
    const output = new Map<number, string | undefined>();
    for (const item of plan.formulas) {
      const html = await renderScientificFormulaAsync(item, plan.equations, scientificMath);
      output.set(item.record.id, html);
    }
    return output;
  }
  const requests: MathJaxDocumentExpression[] = plan.formulas.map((item) => scientificFormulaRequest(item, plan.equations));
  const rendered = await scientificMath.renderDocumentAsync(requests);
  if (!rendered || rendered.length !== plan.formulas.length) return failed();
  const output = new Map<number, string | undefined>();
  plan.formulas.forEach((item, index) => {
    const html = rendered[index];
    output.set(item.record.id, html === undefined || html === "" ? html : wrapScientificFormula(item, plan.equations, html));
  });
  return output;
}

function renderFormula(item:PreparedFormula, equations:EquationIndex, renderer:ScientificMathRenderer|undefined, mode:"sync"):string|undefined;
function renderFormula(item:PreparedFormula, equations:EquationIndex, renderer:ScientificMathRenderer|undefined, mode:"async"):Promise<string|undefined>|string|undefined;
function renderFormula(item:PreparedFormula, equations:EquationIndex, renderer:ScientificMathRenderer|undefined, mode:"sync"|"async") {
  if (!item.record.tex.trim()) return "";
  const metadata=equations.byToken.get(item.record.token);
  const primary=tryRenderTeX(item.record,equations.labels,metadata,item.macros);
  if (primary!==undefined || !renderer?.isReady()) return primary;
  return mode==="async"
    ? tryRenderScientificMathAsync(renderer,item.record,equations.labels,metadata,item.macros)
    : tryRenderScientificMath(renderer,item.record,equations.labels,metadata,item.macros);
}

function installFormulaOutput(
  $: ReturnType<typeof load>,
  root: any,
  formulas: FormulaDocument,
  plan: FormulaRenderPlan,
  output: Map<number, string | undefined>,
  formulaRenderPolicy: FormulaRenderPolicy
): SanitizedContent {
  const rendered = new Set<number>();
  const fallback = new Set<number>();
  const dropped = new Set<number>();

  for (const item of plan.formulas) {
    const anchors = root.find(formulas.anchorSelector(item.record.id)).toArray();
    // Formula tokens are an internal integrity boundary, not an instruction
    // supplied by remote text. A record must map to exactly one generated
    // anchor; replacing multiple anchors would duplicate a formula and move
    // later labels/diagnostics out of sync.
    if (anchors.length !== 1) {
      dropped.add(item.record.id);
      for (const anchor of anchors) $(anchor).remove();
      continue;
    }
    const renderedHtml = output.get(item.record.id);
    if (renderedHtml === undefined) fallback.add(item.record.id);
    else rendered.add(item.record.id);
    const markup = $(renderedHtml ?? renderMathFallback(item.record));
    // SVG has no readable formula text. Preserve the locally parsed source
    // on its generated container for derived documents and accessibility.
    markup.find("mjx-container").addBack("mjx-container").first()
      .attr("data-reader-tex", item.record.tex)
      .attr("data-reader-math-display", String(item.record.displayMode));
    $(anchors[0]).replaceWith(markup);
  }

  // Unknown generated-anchor markup cannot be source content. Remove it and
  // expose any matching record as dropped so the local audit reports the
  // integrity mismatch instead of silently duplicating output.
  root.find("[data-reader-formula-anchor]").each((_index: number, node: any) => {
    const id = Number.parseInt($(node).attr("data-reader-formula-anchor") || "", 10);
    if (Number.isSafeInteger(id)) dropped.add(id);
    $(node).remove();
  });
  return {
    html: root.html() || "",
    formulaDiagnostics: formulas.diagnostics(rendered, fallback, dropped, formulaRenderPolicy),
    formulaRenderPolicy
  };
}

export function needsMathJaxFallback(value: SanitizedContent | ReaderArticle): boolean {
  // Independent formulas may still retry locally after an observed KaTeX
  // failure. Document-scoped formulas have already selected MathJax before
  // their first pass, based on semantic structure rather than hostname.
  return (value.formulaDiagnostics?.fallback ?? 0) > 0;
}

function collectEquationMetadata(records: FormulaRecord[]): EquationIndex {
  const labels = new Map<string, string>();
  const byToken = new Map<string, EquationMetadata>();
  let generated = 0;
  for (const record of records) {
    if (!record.displayMode) continue;
    const recordLabels = findTeXCommandGroups(record.tex, "label").map((group) => group.content.trim()).filter(Boolean);
    const explicitTags = findTeXCommandGroups(record.tex, "tag").map((group) => group.content.trim()).filter(Boolean);
    const nativeTags = explicitTags.length > 0 || recordLabels.length > 1 || (isMultiRowDisplayEnvironment(record.tex) && recordLabels.length > 0);
    // A label map is a document semantic index, not a renderer side effect.
    // This makes references deterministic even when the original page used
    // distinct MathJax frames for neighbouring equations.
    for (const row of splitEquationRows(record.tex)) {
      const rowLabels = findTeXCommandGroups(row, "label").map(group => group.content.trim()).filter(Boolean);
      if (!rowLabels.length) continue;
      const tag = findTeXCommandGroups(row, "tag")[0]?.content.trim() || String(++generated);
      // Multiple labels on the same authored row are aliases, not additional
      // equations. Nested cases/arrays must not advance the document counter.
      rowLabels.forEach(label => labels.set(label, tag));
    }
    const label = recordLabels[0];
    // The sync-only compatibility path needs an app-owned fallback tag, while
    // the async scientific path suppresses it whenever `nativeTags` is true.
    const tag = explicitTags[0] || (label ? labels.get(label) : undefined);
    const metadata = { label: label || undefined, tag, nativeTags };
    byToken.set(record.token, metadata);
  }
  return { labels, byToken };
}

function isMultiRowDisplayEnvironment(tex: string): boolean {
  return /\\begin\{(?:align\*?|gather\*?|multline\*?)\}/.test(tex);
}

function tryRenderTeX(
  record: FormulaRecord,
  labels: Map<string, string>,
  metadata: EquationMetadata | undefined,
  macros: MathMacroScope
): string | undefined {
  const tex = prepareEquationTeX(record.tex, labels);
  if (!tex.trim()) return "";
  const katexOptions = {
    displayMode: false,
    throwOnError: true,
    strict: "ignore" as const,
    trust: false,
    macros: katexMacros(macros),
    maxSize: 24,
    maxExpand: 1_000
  };
  let html: string;
  try {
    // The app owns all display layout and equation tags. Rendering the KaTeX
    // core in inline mode prevents its internal `.base/.tag` implementation
    // from becoming a second, version-sensitive layout system.
    html = katex.renderToString(tex, katexOptions);
  } catch (error) {
    // Post-typeset DOM snapshots can retain a use of a site-local custom
    // operator while the original `\\newcommand` node is gone. Recover only
    // the narrow, unambiguous case: KaTeX reports one undefined alphabetic
    // control word and it is used as a zero-argument function call. Mapping
    // it to `\\operatorname` preserves the mathematical operator semantics
    // without guessing argument macros or hard-coding a provider name.
    const recovered = recoverUndefinedOperatorFunction(tex, error, macros);
    if (!recovered) return undefined;
    try {
      html = katex.renderToString(recovered, katexOptions);
    } catch {
      return undefined;
    }
  }
  return record.displayMode ? wrapDisplayEquation(html, metadata?.tag, "katex") : html;
}

function recoverUndefinedOperatorFunction(tex: string, error: unknown, macros: MathMacroScope): string | undefined {
  const message = error instanceof Error ? error.message : String(error || "");
  const match = message.match(/Undefined control sequence:\s*\\([A-Za-z]+)(?![A-Za-z])/i);
  const name = match?.[1];
  if (!name || macros.has(name)) return undefined;
  // Only recover a command that is visibly used as a zero-arity operator;
  // parameters, delimiters, and arbitrary unknown TeX continue to the local
  // MathJax path (or the explicit safe TeX fallback) instead of being guessed.
  const invocation = new RegExp(`\\\\${escapeRegExp(name)}(?![A-Za-z])\\s*(?=(?:\\\\left\\s*)?\\()`, "g");
  let replacements = 0;
  const recovered = tex.replace(invocation, () => {
    replacements += 1;
    return `\\operatorname{${name}}`;
  });
  return replacements ? recovered : undefined;
}

function tryRenderScientificMath(
  scientificMath: ScientificMathRenderer | undefined,
  record: FormulaRecord,
  labels: Map<string, string>,
  metadata: EquationMetadata | undefined,
  macros: MathMacroScope
): string | undefined {
  if (!scientificMath) return undefined;
  const item: PreparedFormula = { record, macros };
  const equations: EquationIndex = { labels, byToken: new Map([[record.token, metadata || { nativeTags: false }]]) };
  return renderScientificFormula(item, equations, scientificMath);
}

async function tryRenderScientificMathAsync(
  scientificMath: ScientificMathRenderer | undefined,
  record: FormulaRecord,
  labels: Map<string, string>,
  metadata: EquationMetadata | undefined,
  macros: MathMacroScope
): Promise<string | undefined> {
  if (!scientificMath) return undefined;
  const item: PreparedFormula = { record, macros };
  const equations: EquationIndex = { labels, byToken: new Map([[record.token, metadata || { nativeTags: false }]]) };
  return renderScientificFormulaAsync(item, equations, scientificMath);
}

function scientificFormulaRequest(item: PreparedFormula, equations: EquationIndex): MathJaxDocumentExpression {
  const metadata = equations.byToken.get(item.record.token);
  return {
    tex: prepareEquationTeX(item.record.tex, equations.labels, { preserveNativeTags: metadata?.nativeTags === true }),
    displayMode: item.record.displayMode,
    macros: Object.fromEntries(item.macros)
  };
}

function renderScientificFormula(
  item: PreparedFormula,
  equations: EquationIndex,
  scientificMath: ScientificMathRenderer
): string | undefined {
  if (!item.record.tex.trim()) return "";
  const request = scientificFormulaRequest(item, equations);
  const html = scientificMath.render(request.tex, request.displayMode, request.macros);
  return html === undefined ? undefined : wrapScientificFormula(item, equations, html);
}

async function renderScientificFormulaAsync(
  item: PreparedFormula,
  equations: EquationIndex,
  scientificMath: ScientificMathRenderer
): Promise<string | undefined> {
  if (!item.record.tex.trim()) return "";
  const request = scientificFormulaRequest(item, equations);
  // Test doubles and older local helper instances may only expose the
  // synchronous compatibility method. Production ScientificMathRenderer
  // always provides renderAsync(), but retaining this fallback keeps the
  // extraction contract backwards-compatible.
  const html = typeof scientificMath.renderAsync === "function"
    ? await scientificMath.renderAsync(request.tex, request.displayMode, request.macros)
    : scientificMath.render(request.tex, request.displayMode, request.macros);
  return html === undefined ? undefined : wrapScientificFormula(item, equations, html);
}

function wrapScientificFormula(item: PreparedFormula, equations: EquationIndex, html: string): string {
  const metadata = equations.byToken.get(item.record.token);
  return item.record.displayMode ? wrapDisplayEquation(html, metadata?.tag, "mathjax", metadata?.nativeTags === true) : html;
}

function prepareEquationTeX(
  tex: string,
  labels: Map<string, string>,
  options?: { preserveNativeTags?: boolean }
): string {
  const withoutMetadata = options?.preserveNativeTags
    ? splitEquationRows(tex).map(row => {
      const label = findTeXCommandGroups(row, "label")[0];
      const tag = label && labels.get(label.content.trim());
      // MathJax defaults to tags:none: multiple label-only align rows then
      // fail with "Multiple \\label". The host already owns the numbering;
      // materialize its row tag and remove renderer-side labels, rather than
      // enabling a second automatic counter that can disagree with references.
      const tagged = tag && !findTeXCommandGroups(row, "tag").length
        ? `${row.slice(0, label.start)}\\tag{${tag}}${row.slice(label.next)}` : row;
      return stripTeXCommandGroups(tagged, "label");
    }).join("\\\\")
    : stripTeXCommandGroups(stripTeXCommandGroups(tex, "label"), "tag");
  const referencesResolved = withoutMetadata.replace(/\\(eqref|ref)\{([^}]+)\}/g, (_all, kind, reference) => {
    const label = labels.get(reference) || reference;
    return kind === "eqref" ? `(${label})` : label;
  });
  return options?.preserveNativeTags ? referencesResolved : normaliseTopLevelDisplayEnvironment(referencesResolved);
}

function normaliseTopLevelDisplayEnvironment(tex: string): string {
  const match = tex.trim().match(/^\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}([\s\S]*?)\\end\{\1\}$/);
  if (!match) return tex;
  // This branch is used only by the standard KaTeX compatibility renderer.
  // FormulaDocument itself retains the original environment for the async
  // scientific renderer, where per-row numbering remains meaningful.
  const [environment, body] = [match[1], match[2].trim()];
  return environment.startsWith("align") || environment.startsWith("gather") || environment.startsWith("multline")
    ? `\\begin{aligned}${body}\\end{aligned}`
    : body;
}

function wrapDisplayEquation(
  content: string,
  tag: string | undefined,
  renderer: "katex" | "mathjax",
  nativeTags = false
): string {
  const tagHtml = tag ? `<span class="reader-equation__tag" aria-label="公式编号">(${escapeHtml(tag)})</span>` : "";
  const rendererClass = renderer === "mathjax" ? " reader-equation--mathjax" : "";
  const nativeClass = nativeTags ? " reader-equation--native-tags" : "";
  // The scroll viewport and reader-owned tag are distinct grid columns. This
  // keeps a long formula independently scrollable while the tag stays inside
  // the visible reading column. Native MathJax tags never receive a second
  // app tag.
  return `<span class="katex-display" data-reader-equation="true"><span class="reader-equation${rendererClass}${nativeClass}"><span class="reader-equation__viewport"><span class="reader-equation__content">${content}</span></span>${nativeTags ? "" : tagHtml}</span></span>`;
}

function renderMathFallback(record: FormulaRecord): string {
  // A malformed equation must not break the article's entire layout.
  return `<code class="reader-math-source${record.displayMode ? " reader-math-source--block" : ""}">${escapeHtml(record.tex)}</code>`;
}

function findTeXCommandGroup(input: string, command: string): { content: string; start: number; next: number } | undefined {
  const expression = new RegExp(`\\\\${command}(?![A-Za-z])\\s*`, "g");
  let match: RegExpExecArray | null;
  while ((match = expression.exec(input))) {
    const group = readTeXGroup(input, match.index + match[0].length);
    if (group) return { content: group.content, start: match.index, next: group.next };
  }
  return undefined;
}

/** Returns every balanced command group without using a brittle regex body. */
function findTeXCommandGroups(input: string, command: string): Array<{ content: string; start: number; next: number }> {
  const groups: Array<{ content: string; start: number; next: number }> = [];
  let cursor = 0;
  while (cursor < input.length) {
    const found = findTeXCommandGroup(input.slice(cursor), command);
    if (!found) break;
    groups.push({ content: found.content, start: cursor + found.start, next: cursor + found.next });
    cursor += found.next;
  }
  return groups;
}

function stripTeXCommandGroups(input: string, command: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < input.length) {
    const found = findTeXCommandGroup(input.slice(cursor), command);
    if (!found) return output + input.slice(cursor);
    output += input.slice(cursor, cursor + found.start);
    cursor += found.next;
  }
  return output;
}
