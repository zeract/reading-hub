import { abortError, throwIfAborted } from "./cancellation";
export class ReaderImageHttpError extends Error {
  constructor(readonly status:number){super(`图片请求失败（HTTP ${status}）`);}
}
/** Retry only transport failures and transient HTTP responses, never policy/type/size errors. */
export async function retryReaderImage<T>(read:()=>Promise<T>, signal:AbortSignal):Promise<T> {
  for(let attempt=0;;attempt++) {
    throwIfAborted(signal);
    try {return await read();}
    catch(error) {
      throwIfAborted(signal);
      const transient=error instanceof ReaderImageHttpError
        ? [408,429,500,502,503,504].includes(error.status)
        : error instanceof Error && error.name==="NetworkRequestError";
      if(attempt>=1 || !transient)throw error;
      await new Promise<void>((resolve,reject)=>{
        const onAbort=()=>{clearTimeout(timer);reject(abortError(signal));};
        const timer=setTimeout(()=>{signal.removeEventListener("abort",onAbort);resolve();},500);
        signal.addEventListener("abort",onAbort,{once:true});
        if(signal.aborted)onAbort();
      });
    }
  }
}
/** Stable, non-sensitive IPC diagnostics; no URLs or upstream response bodies. */
export function readerImageDiagnostic(error:unknown):Error {
  const name=error instanceof Error?error.name:"";
  const code=error instanceof ReaderImageHttpError ? `HTTP_${error.status}`
    : name==="NetworkRequestError" ? "NETWORK"
    : name==="RobotsDisallowedError" ? "ROBOTS"
    : name==="UnsupportedReaderImageTypeError" ? "TYPE"
    : name==="TaskPoolFullError" ? "BUSY" : "LOAD";
  return new Error(`[IMAGE_${code}] 图片加载失败。`);
}
