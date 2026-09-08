export interface SrcsetCandidate {
  url: string;
  width?: number;
  density?: number;
}

const ASCII_SPACE = /[\t\n\f\r ]/;
const INTEGER = /^\d+$/;
const FLOAT = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Parse authored candidates, without resolving URLs or choosing a viewport.
 * URL commas and descriptor commas have different roles in the HTML algorithm:
 * https://html.spec.whatwg.org/multipage/images.html#parse-a-srcset-attribute
 * Callers must validate each URL before using it as a resource.
 */
export function parseSrcset(input: string | undefined): SrcsetCandidate[] {
  if (!input) return [];
  const candidates: SrcsetCandidate[] = [];
  let position = 0;
  while (position < input.length) {
    while (position < input.length && (ASCII_SPACE.test(input[position]) || input[position] === ",")) position++;
    if (position === input.length) break;
    const start = position;
    while (position < input.length && !ASCII_SPACE.test(input[position])) position++;
    let url = input.slice(start, position);
    const descriptors: string[] = [];
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      let descriptor = "";
      let inParentheses = false;
      while (position < input.length) {
        const character = input[position++];
        if (inParentheses) {
          descriptor += character;
          if (character === ")") inParentheses = false;
        } else if (character === ",") {
          break;
        } else if (ASCII_SPACE.test(character)) {
          if (descriptor) descriptors.push(descriptor);
          descriptor = "";
        } else {
          descriptor += character;
          if (character === "(") inParentheses = true;
        }
      }
      if (descriptor) descriptors.push(descriptor);
    }
    const candidate = parseDescriptors(url, descriptors);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function parseDescriptors(url: string, descriptors: string[]): SrcsetCandidate | undefined {
  let width: number | undefined;
  let density: number | undefined;
  let height: number | undefined;
  for (const descriptor of descriptors) {
    const unit = descriptor.at(-1);
    const raw = descriptor.slice(0, -1);
    const value = Number(raw);
    if (!Number.isFinite(value)) return undefined;
    if (unit === "w" && INTEGER.test(raw) && value > 0) {
      if (width !== undefined || density !== undefined) return undefined;
      width = value;
    } else if (unit === "x" && FLOAT.test(raw) && value >= 0) {
      if (width !== undefined || density !== undefined || height !== undefined) return undefined;
      density = value;
    } else if (unit === "h" && INTEGER.test(raw) && value > 0) {
      if (height !== undefined || density !== undefined) return undefined;
      height = value;
    } else {
      return undefined;
    }
  }
  // HTML reserves h for future compatibility, and accepts it only with w.
  if (height !== undefined && width === undefined) return undefined;
  return width !== undefined ? { url, width } : { url, density: density ?? 1 };
}
