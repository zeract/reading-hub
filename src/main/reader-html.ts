export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] || character);
}

export function normalText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
export function isNodeWithinRoot(root: any, node: any): boolean {
  const rootNode = root.get(0);
  for (let cursor = node; cursor; cursor = cursor.parent) {
    if (cursor === rootNode) return true;
  }
  return false;
}
