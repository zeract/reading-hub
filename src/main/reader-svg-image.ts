import { load } from "cheerio";
import type { Element } from "domhandler";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
export class InvalidSvgImageError extends Error {
  constructor(message: string) { super(message); this.name = "InvalidSvgImageError"; }
}
function svgName(node: Element): string | undefined {
  const parts = node.tagName.split(":");
  if (parts.length === 1) return parts[0];
  if (parts.length !== 2) return;
  for (let parent: typeof node.parent = node; parent; parent = parent.parent) {
    if ("attribs" in parent && `xmlns:${parts[0]}` in parent.attribs) {
      return parent.attribs[`xmlns:${parts[0]}`] === SVG_NAMESPACE ? parts[1] : undefined;
    }
  }
}

const elements = new Set("svg g defs symbol use path rect circle ellipse line polyline polygon text tspan textPath title desc linearGradient radialGradient stop clipPath mask pattern marker".split(" "));
const attributes = new Set("id viewBox width height x y x1 y1 x2 y2 cx cy r rx ry dx dy d points transform preserveAspectRatio fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset opacity font-family font-size font-weight font-style text-anchor dominant-baseline letter-spacing offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod patternUnits patternContentUnits patternTransform clipPathUnits maskUnits maskContentUnits markerWidth markerHeight markerUnits refX refY orient clip-path mask marker-start marker-mid marker-end href xlink:href".split(" "));
const presentation = new Set("fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray opacity font-family font-size font-weight font-style text-anchor dominant-baseline letter-spacing stop-color stop-opacity".split(" "));
function safeValue(name: string, value: string): boolean {
  if (name === "href" || name === "xlink:href") return /^#[A-Za-z_][\w:.-]*$/.test(value);
  // Only local fragment paint/clip references; no external resources or CSS escapes.
  return !/[\\<>@]/.test(value) && !/url\s*\(/i.test(value.replace(/url\(\s*#[A-Za-z_][\w:.-]*\s*\)/g, "")) && !/javascript:|expression\s*\(/i.test(value);
}
/** Static SVG image subset. No scripts, stylesheets, embedded documents or remote subresources. */
export function sanitizeSvgImage(bytes: Buffer): Buffer {
  // Strip an inert external declaration before parsing; never load a DTD or
  // accept an internal subset/entity declaration. Common SVG exporters emit it.
  let input = bytes.toString("utf8");
  if (/<!ENTITY/i.test(input)) throw new InvalidSvgImageError("SVG 图片包含不支持的文档声明。");
  input = input.replace(/<!DOCTYPE\s+svg(?:\s+(?:PUBLIC\s+(?:"[^"<>\[\]]*"|'[^'<>\[\]]*')\s+|SYSTEM\s+)(?:"[^"<>\[\]]*"|'[^'<>\[\]]*'))?\s*>/g, "");
  if (/<!DOCTYPE/i.test(input)) throw new InvalidSvgImageError("SVG 图片包含不支持的文档声明。");
  const $ = load(input, { xml: true });
  const root = $.root().children();
  if (root.length !== 1 || svgName(root[0]) !== "svg") throw new InvalidSvgImageError("SVG 图片格式无效。");
  // Resolve XML namespaces before removing original namespace declarations.
  const nodes = root.find("*").addBack().toArray();
  for (const node of nodes) if ("tagName" in node) node.name = svgName(node) ?? "unsupported";
  for (const node of nodes) {
    if (!("tagName" in node)) continue;
    if (!elements.has(node.tagName)) { $(node).remove(); continue; }
    // Simple inline presentation becomes inert attributes; original CSS is not retained.
    const style = $(node).attr("style") || "";
    for (const declaration of style.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      const name = declaration.slice(0, colon).trim(), value = declaration.slice(colon + 1).trim();
      if (presentation.has(name) && safeValue(name, value)) $(node).attr(name, value);
    }
    for (const [name, value] of Object.entries(node.attribs)) {
      if (!attributes.has(name) || !safeValue(name, value)) $(node).removeAttr(name);
    }
  }
  root.attr("xmlns", "http://www.w3.org/2000/svg").attr("xmlns:xlink", "http://www.w3.org/1999/xlink");
  return Buffer.from($.xml(root));
}
