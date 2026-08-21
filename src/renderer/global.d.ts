import type { ReaderApi } from "../shared/ipc";

declare global {
  interface Window {
    reader: ReaderApi;
  }
}

export {};
