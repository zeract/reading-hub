import { describe, expect, it } from "vitest";
import { renderAiTeX, tokenizeAiMath } from "../src/renderer/ai-math";

describe("AI answer math rendering", () => {
  it("renders inline and display TeX without treating surrounding text as HTML", () => {
    const tokens = tokenizeAiMath("设 $q_i = e^{z_i}$，并且\n\\[L(p, q) = \\sum_i p_i S(q, i)\\]");

    expect(tokens).toEqual([
      { type: "text", value: "设 " },
      { type: "math", tex: "q_i = e^{z_i}", displayMode: false },
      { type: "text", value: "，并且\n" },
      { type: "math", tex: "L(p, q) = \\sum_i p_i S(q, i)", displayMode: true }
    ]);
    expect(renderAiTeX("q_i = e^{z_i}", false).html).toContain('class="katex"');
    expect(renderAiTeX("L(p, q) = \\sum_i p_i S(q, i)", true).html).toContain('class="katex-display"');
  });

  it("converts model-produced align environments into one display formula", () => {
    const response = "\\begin{align}\\text{MoE:}&\\quad d \\to D \\to d \\\\ \\text{LatentMoE:}&\\quad d/2 \\to D \\to d/2\\end{align}";
    const [formula] = tokenizeAiMath(response);

    expect(formula).toMatchObject({ type: "math", displayMode: true });
    const rendered = renderAiTeX(formula.type === "math" ? formula.tex : "", true);
    expect(rendered.html).toContain('class="katex-display"');
    expect(rendered.html).not.toContain("katex-error");
  });

  it("does not mistake an unmatched price as a formula", () => {
    expect(tokenizeAiMath("价格是 $5，暂不计算。 ")).toEqual([{ type: "text", value: "价格是 $5，暂不计算。 " }]);
  });
});
