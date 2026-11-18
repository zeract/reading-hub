/// <reference types="vite/client" />
import { readerDiagramSource } from "./reader-diagram-source";

export function renderReaderDiagrams(body: HTMLDivElement): (() => void) | undefined {
  const candidates = [...body.querySelectorAll("pre")].flatMap(block => {
    const source = readerDiagramSource(block);
    return source ? [{ block, source }] : [];
  });
  if (!candidates.length) return;

  const urls = new Set<string>();
  const replacements = new Map<HTMLElement, HTMLPreElement>();
  let active = true;
  let worker: Worker | undefined;
  let cancelLayout: (() => void) | undefined;
  const stopWorker = () => {
    cancelLayout?.();
    cancelLayout = undefined;
    worker?.terminate();
    worker = undefined;
  };

  async function render() {
    // The inline worker also loads from the packaged Electron file:// entry.
    const { default: DiagramWorker } = await import("./reader-diagram.worker?worker&inline");
    if (!active) return;
    const layout = worker = new DiagramWorker();
    for (const { block, source } of candidates) {
      if (!active) break;
      if (!body.contains(block)) continue;
      const svg = await new Promise<string | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Diagram layout timed out")), 5000);
        cancelLayout = () => { clearTimeout(timer); resolve(null); };
        layout.onmessage = ({ data }) => { clearTimeout(timer); resolve(data); };
        layout.onerror = event => { clearTimeout(timer); reject(event); };
        layout.postMessage(source);
      });
      cancelLayout = undefined;
      if (!svg || !active || !body.contains(block)) continue;

      const image = new Image();
      image.alt = "Mermaid 图。\n" + source;
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      urls.add(url);
      try {
        image.src = url;
        await image.decode();
      } catch {
        urls.delete(url);
        URL.revokeObjectURL(url);
        continue;
      }
      if (!active || !body.contains(block)) continue;
      const figure = document.createElement("figure");
      figure.className = "reader-diagram";
      figure.append(image);
      block.replaceWith(figure);
      replacements.set(figure, block);
    }
  }

  void render().catch(() => {
    // Leave the code visible when the worker cannot load or reply.
  }).finally(stopWorker);

  return () => {
    active = false;
    stopWorker();
    for (const [figure, block] of replacements) {
      if (body.contains(figure)) figure.replaceWith(block);
    }
    for (const url of urls) URL.revokeObjectURL(url);
  };
}
