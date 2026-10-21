import { describe, expect, it } from "vitest";
import { splitEquationRows } from "../src/main/reader-equation-rows";

describe("authored equation rows", () => {
  it("keeps nested cases, grouped line breaks and spacing intact", () => {
    const first = String.raw`\begin{align}a&=\begin{cases}1&x>0\\0&x<0\end{cases}\label{a}`;
    const second = String.raw`[5pt]b&=\underbrace{\substack{x\\y}}_{z}\label{b}\end{align}`;
    const tex = `${first}\\\\${second}`;
    expect(splitEquationRows(tex)).toEqual([first, second]);
    expect(splitEquationRows(tex).join("\\\\")).toBe(tex);
  });
  it("does not split escaped punctuation or commented line breaks", () => {
    const tex = "\\begin{align}a&=\\{x\\}\\% % ignored \\\\\nb&=x\\end{align}";
    expect(splitEquationRows(tex)).toEqual([tex]);
  });
});
