/**
 * Lets a consumer ignore a response once a newer request has started.
 *
 * Cancellation may race with completion or be ignored by a dependency. Keep
 * this result guard alongside cancellation at the state-update boundary.
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
