/**
 * Development-only parent-liveness guard.
 *
 * `scripts/dev.mjs` launches Electron with a Node IPC channel. If the
 * supervisor is interrupted or its terminal disappears, Node closes that
 * channel in the Electron main process. Quitting here prevents a menu-bar
 * window from being re-parented to launchd and retaining the development
 * profile/SQLite database. Packaged applications never set this flag.
 */
export interface DevelopmentSupervisorProcess {
  env: NodeJS.ProcessEnv;
  connected?: boolean;
  once(event: "disconnect", listener: () => void): unknown;
  removeListener(event: "disconnect", listener: () => void): unknown;
}

export function installDevelopmentSupervisorGuard(
  runtime: DevelopmentSupervisorProcess,
  quit: () => void
): () => void {
  if (runtime.env.READING_HUB_DEV_SUPERVISOR_IPC !== "1") return () => undefined;

  let handled = false;
  const onDisconnect = () => {
    if (handled) return;
    handled = true;
    quit();
  };

  runtime.once("disconnect", onDisconnect);
  // A supervisor can disappear while Electron is loading this module. Node
  // exposes the closed channel as `connected === false` in that narrow race.
  if (runtime.connected === false) queueMicrotask(onDisconnect);
  return () => runtime.removeListener("disconnect", onDisconnect);
}
