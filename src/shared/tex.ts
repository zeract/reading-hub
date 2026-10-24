export type InlineDollarMath = { tex: string; end: number };

/**
 * Returns the TeX wrapped by a matched, unescaped inline `$…$` pair.
 *
 * A closing dollar cannot precede a digit (the next price). When preceded by
 * whitespace it closes only before a separator/end, not the start of another
 * formula. Keep padded author TeX without guessing mathematical contents:
 * valid math can
 * be a single symbol (`$t$`) or a tuple (`$(4,16,16)$`), neither of which has
 * an operator or a TeX command to key off. Literal code is excluded by each
 * caller before this lexer is used; an unmatched price such as `$5` remains
 * ordinary text because it has no closing delimiter.
 */
export function inlineDollarMathAt(input: string, index: number): InlineDollarMath | undefined {
  if (input[index] !== "$" || isEscapedDollarDelimiter(input, index) || input[index + 1] === "$") return undefined;
  for (let cursor = index + 1; cursor < input.length; cursor += 1) {
    if (input[cursor] !== "$" || isEscapedDollarDelimiter(input, cursor)) continue;
    if (/[0-9]/.test(input[cursor + 1] || "")) return undefined;
    if (/\s/.test(input[cursor - 1]) && input[cursor + 1] && !/[\s.,;:!?)\]}%。，；：！？）》】'"’”\-]/u.test(input[cursor + 1])) return undefined;
    const tex = input.slice(index + 1, cursor).trim();
    if (!tex || /[\r\n]/.test(tex)) return undefined;
    return { tex, end: cursor + 1 };
  }
  return undefined;
}

export function isEscapedDollarDelimiter(input: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && input[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}
