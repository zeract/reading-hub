import { readerCodeLanguage } from "../shared/reader-code-language";

const flowchartHeader = /^(?:flowchart|graph)[ \t]+(?:TB|TD|BT|LR|RL)$/i;
const otherDiagramHeader = /^(?:sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram|xychart(?:-beta)?)(?:\s|$)/;

/** Infer only a complete flowchart declaration in a fenced or preformatted block. */
export function readerDiagramSource(block: HTMLPreElement): string | undefined {
  const code = block.querySelector(":scope > code");
  const language = readerCodeLanguage(block.className + " " + (code?.className ?? ""));
  if (language && language !== "mermaid") return;

  const source = (code ?? block).textContent ?? "";
  if (source.length > 8192) return;
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  // Bound layout input and keep article configuration out of the renderer.
  if (lines.length > 128 || lines.some(line => /^(?:%%\{|click\s)/i.test(line))) return;
  const statements = lines.filter(line => !line.startsWith("%%"));
  if (statements.length < 2) return;
  const header = statements[0].replace(/;$/, "");
  if (!flowchartHeader.test(header) && !(language === "mermaid" && otherDiagramHeader.test(header))) return;
  return [header, ...statements.slice(1)].join("\n");
}
