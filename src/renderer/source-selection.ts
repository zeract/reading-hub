/**
 * React does not re-render when a state setter receives the current source
 * id. Source navigation still needs an explicit refresh in that case because
 * the click also closes the reader and may follow a transient empty list.
 */
export function requiresSourceReload(activeSourceId: string | undefined, requestedSourceId: string | undefined): boolean {
  return activeSourceId === requestedSourceId;
}
