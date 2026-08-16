import { describe, expect, it } from "vitest";
import { inlineDollarMathAt } from "../src/shared/tex";

describe("paired inline TeX delimiters", () => {
  it("accepts every non-empty same-line author-delimited formula", () => {
    expect(inlineDollarMathAt("$t$", 0)).toEqual({ tex: "t", end: 3 });
    expect(inlineDollarMathAt("$(4,16,16)$", 0)).toEqual({ tex: "(4,16,16)", end: 11 });
    expect(inlineDollarMathAt("$\\mathcal{O}(L^2)$", 0)).toEqual({ tex: "\\mathcal{O}(L^2)", end: 18 });
  });

  it("keeps escaped or unmatched dollar signs as ordinary text", () => {
    expect(inlineDollarMathAt("\\$t$", 1)).toBeUndefined();
    expect(inlineDollarMathAt("价格是 $5，暂不计算。", 4)).toBeUndefined();
    expect(inlineDollarMathAt("$a\nb$", 0)).toBeUndefined();
  });
});
