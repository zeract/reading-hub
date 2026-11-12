import { readerPresentation } from "../shared/reader-presentation";
import { READER_CONVERSION_ERRORS } from "./reader-conversion-errors";
import { parentPort } from "node:worker_threads";
import { convertReaderContent, type ReaderConversionRequest } from "./reader-conversion";
import { ScientificMathRenderer } from "./mathjax-renderer";
const math = new ScientificMathRenderer();
parentPort!.on("message", async (request: {
    input: ReaderConversionRequest;
    cancelled: SharedArrayBuffer;
}) => {
    const flag = new Int32Array(request.cancelled);
    // The host can cancel even while synchronous parsing/MathJax prevents this
    // thread from receiving a message. It also terminates the thread, so a
    // single uninterruptible library call cannot hold the queue or app exit.
    const signal = new AbortController().signal;
    Object.defineProperty(signal, "aborted", { get: () => Atomics.load(flag, 0) !== 0 });
    try {
        const result = await convertReaderContent(request.input, math, signal);
        parentPort!.postMessage({ value: result ? { ...result, article: request.input.legacyImport ? result.article : readerPresentation(result.article) } : undefined });
    }
    catch (error) {
        parentPort!.postMessage({ error: error instanceof Error ? READER_CONVERSION_ERRORS.findIndex(message => message === error.message) : -1 });
    }
});
