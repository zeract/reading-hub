/**
 * Lets a view ignore a response once a newer article request has started.
 *
 * IPC calls cannot be cancelled reliably after they have crossed Electron's
 * process boundary, so this small guard makes stale responses harmless at the
 * state-update boundary instead.
 */
export class LatestRequestGuard {
  private revision = 0;

  begin(): number {
    this.revision += 1;
    return this.revision;
  }

  invalidate(): void {
    this.revision += 1;
  }

  isCurrent(revision: number): boolean {
    return revision === this.revision;
  }
}
