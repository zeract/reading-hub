import { throwIfAborted } from "./cancellation";

/** The event surface needed from a WebContents; no Electron dependency in the scope. */
export interface RequestOwner {
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}
type OwnerRequests = { controllers: Set<AbortController>; onDestroyed(): void };

/**
 * Cancel foreground work with its owning window or the IPC shutdown drain.
 * Operations retain responsibility for finishing already-started durable writes;
 * this scope waits for them to settle instead of abandoning their promises.
 */
export class WindowRequestScope {
  private readonly owners = new Map<RequestOwner, OwnerRequests>();
  private closing = false;

  async run<T>(owner: RequestOwner, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closing) throw new Error("应用正在退出，操作已取消。");
    if (owner.isDestroyed()) throw new Error("发起请求的窗口已关闭，操作已取消。");
    const controller = new AbortController();
    let group = this.owners.get(owner);
    if (!group) {
      group = { controllers: new Set([controller]), onDestroyed: () => this.cancelOwner(owner, new Error("发起请求的窗口已关闭，操作已取消。")) };
      this.owners.set(owner, group);
      owner.once("destroyed", group.onDestroyed);
    } else group.controllers.add(controller);
    try {
      if (owner.isDestroyed()) this.cancelOwner(owner, new Error("发起请求的窗口已关闭，操作已取消。"));
      throwIfAborted(controller.signal);
      const result = await operation(controller.signal);
      throwIfAborted(controller.signal);
      return result;
    } finally {
      group.controllers.delete(controller);
      if (!group.controllers.size && this.owners.get(owner) === group) this.release(owner, group);
    }
  }

  close(): void {
    this.closing = true;
    for (const owner of this.owners.keys()) this.cancelOwner(owner, new Error("应用正在退出，操作已取消。"));
  }

  private cancelOwner(owner: RequestOwner, reason: Error): void {
    const group = this.owners.get(owner);
    if (!group) return;
    this.release(owner, group);
    for (const controller of group.controllers) controller.abort(reason);
  }

  private release(owner: RequestOwner, group: OwnerRequests): void {
    owner.removeListener("destroyed", group.onDestroyed);
    this.owners.delete(owner);
  }
}
