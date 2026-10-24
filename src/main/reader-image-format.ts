export class ReaderImageSizeError extends Error {
  constructor() { super("图片响应超过 8 MB，已跳过加载。"); this.name = "ReaderImageSizeError"; }
}

export class ReaderImageRedirectError extends Error {
  constructor() { super("图片重定向次数过多，已停止请求。"); this.name = "ReaderImageRedirectError"; }
}

/** Binary raster signatures for generic MIME responses. Never infer type from a URL extension. */
export function rasterImageType(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
}
