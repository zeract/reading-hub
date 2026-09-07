// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiMarkdownContent } from "../src/renderer/ai-markdown";
import * as math from "../src/renderer/ai-math";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const answers = Array.from({ length: 4 }, (_value, index) => `## Answer ${index}\n\n$x^2$ and $y^2$\n\n$$\nz = x+y\n$$`);

async function render(draft: string, texts = answers) {
  await act(async () => root.render(<section>
    <input value={draft} readOnly />
    {texts.map((text, index) => <AiMarkdownContent key={index} text={text} />)}
  </section>));
}

describe("AI answer rendering lifetime", () => {
  it("does not reparse completed formulas when an unrelated input changes", async () => {
    const typeset = vi.spyOn(math, "renderAiTeX");
    await render("");
    expect(typeset).toHaveBeenCalledTimes(12);
    for (const draft of ["e", "ex", "exp", "expl", "expla", "explain"]) await render(draft);
    expect(typeset).toHaveBeenCalledTimes(12);
    expect(container.querySelectorAll(".katex")).toHaveLength(12);
  });

  it("reparses only the changed streaming answer and updates its DOM", async () => {
    const typeset = vi.spyOn(math, "renderAiTeX");
    await render("");
    await render("", [...answers.slice(0, 3), answers[3] + "\n\nNew $w$"]);
    expect(typeset).toHaveBeenCalledTimes(16);
    expect(container.querySelectorAll(".katex")).toHaveLength(13);
    expect(container.textContent).toContain("New");
    await render("", [...answers.slice(0, 3), "<script>inert()</script>\n\nFinal $q$"]);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>inert()</script>");
    expect(container.textContent).not.toContain("New");
  });
});
