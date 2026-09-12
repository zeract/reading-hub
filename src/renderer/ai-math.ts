import katex from "katex";
export { tokenizeAiMath } from "../shared/markdown-math";

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

function normalizeTeX(value: string, displayMode: boolean): string {
  let tex = value.trim().replace(/\\label\{[^}]*\}/g, "").replace(/\\(eqref|ref)\{([^}]+)\}/g, (_all, kind, id) => kind === "eqref" ? `(${id})` : id);
  // Explicit row tags require their original numbering-capable environment.
  if (!displayMode || /\\tag\*?\{/.test(tex)) return tex;
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
