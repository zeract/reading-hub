import type { Plugin } from "vite";

const suffix = "?chunk-url";
const prefix = "\0deferred-module-url:";

/** Expose a bundled module's URL without eagerly importing its code. Unlike
 * ?url assets, this emits a compiled chunk with its public exports intact. */
export function deferredModuleUrl(): Plugin {
  let serve = false;
  return {
    name: "deferred-module-url",
    enforce: "pre",
    configResolved(config) { serve = config.command === "serve"; },
    async resolveId(source, importer) {
      if (!source.endsWith(suffix)) return;
      const resolved = await this.resolve(source.slice(0, -suffix.length), importer, { skipSelf: true });
      if (!resolved || resolved.external) this.error("Deferred modules must resolve to a local source file.");
      return prefix + resolved.id;
    },
    load(id) {
      if (!id.startsWith(prefix)) return;
      const target = id.slice(prefix.length);
      if (serve) return `export default ${JSON.stringify(`/@fs${target}`)};`;
      const reference = this.emitFile({ type: "chunk", id: target, preserveSignature: "strict" });
      return `export default import.meta.ROLLUP_FILE_URL_${reference};`;
    }
  };
}
