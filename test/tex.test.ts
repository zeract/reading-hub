import { describe, expect, it } from "vitest";
import { inlineDollarMathAt } from "../src/shared/tex";

describe("paired inline TeX delimiters", () => {
  it("accepts same-line author delimiters without guessing mathematical content", () => {
    expect(inlineDollarMathAt("$t$", 0)).toEqual({ tex: "t", end: 3 });
    expect(inlineDollarMathAt("$(4,16,16)$", 0)).toEqual({ tex: "(4,16,16)", end: 11 });
    expect(inlineDollarMathAt("$\\mathcal{O}(L^2)$", 0)).toEqual({ tex: "\\mathcal{O}(L^2)", end: 18 });
  });

  it("does not pair separate currency amounts, while retaining padded author TeX", () => {
    for (const text of ["$2.00/million for input and $10/million for output", "$5 and $12."]) {
      expect(inlineDollarMathAt(text, 0)).toBeUndefined();
    }
    expect(inlineDollarMathAt("$2+2$", 0)).toEqual({tex:"2+2",end:5});
    expect(inlineDollarMathAt("$\\infty $",0)).toEqual({tex:"\\infty",end:9});
    expect(inlineDollarMathAt("$ x $",0)).toEqual({tex:"x",end:5});
  });

  it("keeps escaped or unmatched dollar signs as ordinary text", () => {
    expect(inlineDollarMathAt("\\$t$", 1)).toBeUndefined();
    expect(inlineDollarMathAt("价格是 $5，暂不计算。", 4)).toBeUndefined();
    expect(inlineDollarMathAt("$a\nb$", 0)).toBeUndefined();
  });
});
