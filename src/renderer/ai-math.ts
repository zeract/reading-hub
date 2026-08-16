import katex from "katex";
import { inlineDollarMathAt } from "../shared/tex";

export type AiMathSegment =
  | { type: "text"; value: string }
  | { type: "math"; tex: string; displayMode: boolean };

type MathMatch = { tex: string; displayMode: boolean; end: number };

/**
 * Split a model response into plain text and a deliberately small, predictable
 * subset of TeX delimiters. The plain text stays a React text node; only HTML
 * produced by KaTeX is ever inserted as markup.
 */
export function tokenizeAiMath(input: string): AiMathSegment[] {
  const segments: AiMathSegment[] = [];
  let text = "";
  let index = 0;
  let fencedCode = false;

  const pushText = () => {
    if (text) segments.push({ type: "text", value: text });
    text = "";
  };

  while (index < input.length) {
    if (input.startsWith("```", index)) {
      fencedCode = !fencedCode;
      text += "```";
      index += 3;
      continue;
    }
    // Inline Markdown code is equally literal: a `$` or `\begin` within it
    // must not be promoted into TeX before the Markdown renderer sees it.
    if (!fencedCode && input[index] === "`") {
      const close = input.indexOf("`", index + 1);
      if (close > index + 1 && !input.slice(index + 1, close).includes("\n")) {
        text += input.slice(index, close + 1);
        index = close + 1;
        continue;
      }
    }
    const match = fencedCode ? undefined : mathAt(input, index);
    if (!match) {
      text += input[index];
      index += 1;
      continue;
    }
    pushText();
    segments.push({ type: "math", tex: match.tex, displayMode: match.displayMode });
    index = match.end;
  }
  pushText();
  return segments;
}

/** Render only trusted KaTeX output. The fallback is rendered as React text. */
export function renderAiTeX(tex: string, displayMode: boolean): { html?: string; fallback?: string } {
  const normalized = normalizeTeX(tex, displayMode);
  if (!normalized) return { fallback: tex };
  try {
    return {
      html: katex.renderToString(normalized, {
        displayMode,
        throwOnError: true,
        strict: "ignore",
        trust: false,
        maxSize: 24,
        maxExpand: 1_000
      })
    };
  } catch {
    return { fallback: normalized };
  }
}

function mathAt(input: string, index: number): MathMatch | undefined {
  if (input.startsWith("$$", index)) return delimitedMath(input, index, "$$", "$$", true);
  if (input.startsWith("\\[", index)) return delimitedMath(input, index, "\\[", "\\]", true);
  if (input.startsWith("\\(", index)) return delimitedMath(input, index, "\\(", "\\)", false);
  if (input.startsWith("\\begin{", index)) return environmentMath(input, index);
  if (input[index] === "$") return inlineDollarMath(input, index);
  return undefined;
}

function delimitedMath(input: string, index: number, open: string, close: string, displayMode: boolean): MathMatch | undefined {
  const end = input.indexOf(close, index + open.length);
  if (end < 0) return undefined;
  const tex = input.slice(index + open.length, end).trim();
  return tex ? { tex, displayMode, end: end + close.length } : undefined;
}

function environmentMath(input: string, index: number): MathMatch | undefined {
  const start = input.slice(index).match(/^\\begin\{(align\*?|aligned|equation\*?|gather\*?|gathered|multline\*?|cases|matrix|pmatrix|bmatrix|vmatrix|Vmatrix)\}/);
  if (!start) return undefined;
  const environment = start[1];
  const close = `\\end{${environment}}`;
  const closeIndex = input.indexOf(close, index + start[0].length);
  if (closeIndex < 0) return undefined;
  return { tex: input.slice(index, closeIndex + close.length), displayMode: true, end: closeIndex + close.length };
}

function inlineDollarMath(input: string, index: number): MathMatch | undefined {
  const match = inlineDollarMathAt(input, index);
  return match ? { ...match, displayMode: false } : undefined;
}

function normalizeTeX(value: string, displayMode: boolean): string {
  let tex = value.trim().replace(/\\(?:label|ref|eqref)\{[^}]*\}/g, "");
  if (!displayMode) return tex;
  tex = tex
    .replace(/\\begin\{align\*?\}/, "\\begin{aligned}")
    .replace(/\\end\{align\*?\}/, "\\end{aligned}")
    .replace(/\\begin\{equation\*?\}/, "\\begin{aligned}")
    .replace(/\\end\{equation\*?\}/, "\\end{aligned}")
    .replace(/\\begin\{gather\*?\}/, "\\begin{gathered}")
    .replace(/\\end\{gather\*?\}/, "\\end{gathered}")
    .replace(/\\begin\{multline\*?\}/, "\\begin{aligned}")
    .replace(/\\end\{multline\*?\}/, "\\end{aligned}");
  return tex;
}
