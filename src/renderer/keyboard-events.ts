/** IME cancellation and events already handled by an inner control must not
 * also dismiss a surrounding reading workflow. */
export function isUnclaimedEscape(event: Pick<KeyboardEvent, "key" | "isComposing" | "defaultPrevented">): boolean {
  return event.key === "Escape" && !event.isComposing && !event.defaultPrevented;
}
