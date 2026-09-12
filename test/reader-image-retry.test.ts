import {it,expect,vi,afterEach} from "vitest";
import {retryReaderImage,ReaderImageHttpError,readerImageDiagnostic} from "../src/main/reader-image-retry";
afterEach(()=>vi.useRealTimers());
it("retries a transient response once and succeeds",async()=>{
 vi.useFakeTimers();const read=vi.fn().mockRejectedValueOnce(new ReaderImageHttpError(503)).mockResolvedValue("image");
 const task=retryReaderImage(read,new AbortController().signal);await vi.runAllTimersAsync();expect(await task).toBe("image");expect(read).toHaveBeenCalledTimes(2);
});
it("does not retry permanent HTTP or policy failures",async()=>{
 for(const error of [new ReaderImageHttpError(403),new ReaderImageHttpError(404),new Error("robots")]){
 const read=vi.fn().mockRejectedValue(error);await expect(retryReaderImage(read,new AbortController().signal)).rejects.toBe(error);expect(read).toHaveBeenCalledTimes(1);
 }
});
it("cancels backoff without another request and redacts diagnostics",async()=>{
 vi.useFakeTimers();const abort=new AbortController();const read=vi.fn().mockRejectedValue(new ReaderImageHttpError(503));
 const task=retryReaderImage(read,abort.signal);const rejected=expect(task).rejects.toThrow();await Promise.resolve();abort.abort();await rejected;await vi.runAllTimersAsync();expect(read).toHaveBeenCalledTimes(1);
 expect(readerImageDiagnostic(new Error("private URL or token")).message).not.toContain("private");
});
