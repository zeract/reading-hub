import { parseMermaid, renderMermaidSVG } from "beautiful-mermaid";

// ELK uses an in-process dispatcher when document exists, and its adapter
// reassigns self during initialization. Keep both shims inside this worker.
Object.defineProperties(globalThis, {
  document: { value: {} },
  self: { value: self, writable: true }
});

globalThis.addEventListener("message", ({ data: source }: MessageEvent<string>) => {
  try {
    if (/^(?:flowchart|graph)\b/i.test(source)) {
      // Parallel links can expand far beyond the size of their source.
      if ((source.match(/&/g)?.length ?? 0) > 32) return self.postMessage(null);
      const graph = parseMermaid(source);
      if (!graph.nodes.size || graph.nodes.size > 128 || graph.edges.length > 256
        || (!graph.edges.length && /-->|==>|-\.\->/.test(source))) return self.postMessage(null);
    }
    // Use system fonts and display the SVG only as an inert image.
    const svg = renderMermaidSVG(source, { font: "system-ui", transparent: true, padding: 16 })
      .replace(/^[ \t]*@import[^\r\n]*\r?\n/gm, "");
    self.postMessage(/<text[ >]/.test(svg) ? svg : null);
  } catch {
    self.postMessage(null);
  }
});
