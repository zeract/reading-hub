/** Convert IPC and browser failures into the short, safe message shown in the UI. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}
