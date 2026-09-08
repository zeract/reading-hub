/** Convert IPC and browser failures into the short, safe message shown in the UI. */
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "操作失败，请稍后重试。";
  // Electron invoke adds transport context around the main process message.
  // Strip only that outer wrapper; preserve the actual failure description.
  const message = error.message.replace(/^Error invoking remote method '[a-z][a-z0-9:-]*': (?:Error: )?/, "").trim();
  return message || "操作失败，请稍后重试。";
}
