/** Intercept before-quit so window vetoes cannot prevent cancellation/draining. */
export function createShutdownHandler(
  close: () => Promise<void>,
  quit: () => void,
  fail: () => void
): (event: { preventDefault(): void }) => void {
  let draining = false;
  let drained = false;
  return (event) => {
    if (drained) return;
    event.preventDefault();
    if (draining) return;
    draining = true;
    void Promise.resolve().then(close).then(() => {
      drained = true;
      quit();
    }).catch(fail);
  };
}
