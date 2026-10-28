import type { ReaderImageResource } from "../shared/reader-image";

const live = new Map<string, number>();
export function readerImageUrl(resource: ReaderImageResource): string {
  if (!resource || !/^image\/(?:svg\+xml|avif|gif|jpe?g|png|webp|x-icon|vnd\.microsoft\.icon)$/.test(resource.mime)
    || !(resource.bytes instanceof Uint8Array) || !resource.bytes.length || resource.bytes.length > 8_000_000) {
    throw new Error("Invalid image resource");
  }
  const url = URL.createObjectURL(new Blob([Uint8Array.from(resource.bytes)], { type: resource.mime }));
  live.set(url, 1);
  return url;
}
export function releaseReaderImage(url: string): void {
  const count = live.get(url);
  if (!count) return;
  if (count > 1) live.set(url, count - 1);
  else {
    live.delete(url);
    URL.revokeObjectURL(url);
  }
}
/** A zoom preview owns its lease independently of the scrolling article. */
export function retainReaderImage(url: string): () => void {
  if (!live.has(url)) return () => {};
  live.set(url, live.get(url)! + 1);
  let released = false;
  return () => {
    if (!released) {
      released = true;
      releaseReaderImage(url);
    }
  };
}
