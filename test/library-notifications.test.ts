import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock("electron", () => ({ ipcMain: {
  handle: (channel: string, callback: (...args: any[]) => any) => handlers.set(channel, callback),
  removeHandler: (channel: string) => handlers.delete(channel)
}, BrowserWindow: {}, dialog: {}, shell: {} }));
import { ReadingDatabase } from "../src/main/database";
import { registerIpcHandlers } from "../src/main/ipc-handlers";
import { IPC_CHANNELS } from "../src/shared/ipc";

function createSource(db: ReadingDatabase, name: string) {
  return db.createSource({ url: `https://example.com/${name}`, title: name, kind: "rss", pollingEnabled: true });
}

function createSender(id: number) {
  return Object.assign(new EventEmitter(), { id, isDestroyed: vi.fn(() => false), send: vi.fn() });
}

describe("committed library change publication", () => {
  it("does not let a new subscriber acknowledge changes owed to an existing subscriber", () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const source = createSource(db, "first");
      const first = vi.fn(); const second = vi.fn();
      db.onLibraryChanged(first);
      db.pauseSource(source.id, "Fixture pause");
      db.onLibraryChanged(second);
      db.publishChanges();
      expect(first).toHaveBeenCalledExactlyOnceWith(db.getLibraryRevision());
      db.publishChanges();
      expect(first).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });

  it("serializes reentrant writes without reversing revision delivery", () => {
    const db = new ReadingDatabase(":memory:");
    const first: number[] = []; const second: number[] = [];
    let depth = 0; let peak = 0;
    try {
      db.onLibraryChanged((revision) => {
        depth++; peak = Math.max(peak, depth); first.push(revision);
        try { if (first.length === 1) createSource(db, "nested"); }
        finally { depth--; }
      });
      db.onLibraryChanged((revision) => second.push(revision));
      createSource(db, "outer");
      expect(first).toHaveLength(2);
      expect(second).toEqual(first);
      expect(second[1]).toBeGreaterThan(second[0]);
      expect(peak).toBe(1);
    } finally { db.close(); }
  });

  it("does not include a listener added during delivery in the older revision", () => {
    const db = new ReadingDatabase(":memory:");
    const late: number[] = [];
    let added = false;
    try {
      db.onLibraryChanged(() => {
        if (!added) {
          added = true;
          db.onLibraryChanged((revision) => late.push(revision));
          createSource(db, "nested");
        }
      });
      createSource(db, "outer");
      expect(late).toEqual([db.getLibraryRevision()]);
    } finally { db.close(); }
  });

  it("does not take a publication baseline from an uncommitted transaction", () => {
    const db = new ReadingDatabase(":memory:");
    const received = vi.fn();
    try {
      db.writeTransaction(() => {
        createSource(db, "inside");
        db.onLibraryChanged(received);
        expect(received).not.toHaveBeenCalled();
      });
      expect(received).toHaveBeenCalledExactlyOnceWith(db.getLibraryRevision());
    } finally { db.close(); }
  });

  it("honors removal during delivery and isolates a failed observer", () => {
    const db = new ReadingDatabase(":memory:");
    const removed = vi.fn(); const healthy = vi.fn();
    let unsubscribe = () => {};
    try {
      db.onLibraryChanged(() => { unsubscribe(); throw new Error("Synthetic disconnected observer"); });
      unsubscribe = db.onLibraryChanged(removed);
      db.onLibraryChanged(healthy);
      createSource(db, "first");
      expect(removed).not.toHaveBeenCalled();
      expect(healthy).toHaveBeenCalledExactlyOnceWith(db.getLibraryRevision());
    } finally { db.close(); }
  });
});

describe("library IPC broadcast isolation", () => {
  it.each(["send", "isDestroyed"] as const)("continues after one window fails during %s", async (phase) => {
    const db = new ReadingDatabase(":memory:");
    const bad = createSender(1);
    const good = createSender(2);
    const drain = registerIpcHandlers({ database: db } as never);
    try {
      await handlers.get(IPC_CHANNELS.source.list)!({ sender: bad });
      await handlers.get(IPC_CHANNELS.source.list)!({ sender: good });
      bad[phase].mockImplementationOnce(() => { throw new Error("Synthetic window delivery failure"); });
      createSource(db, "first");
      expect(good.send).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.entry.changed, db.getLibraryRevision());
      createSource(db, "second");
      expect(good.send).toHaveBeenCalledTimes(2);
      expect(bad.send).toHaveBeenLastCalledWith(IPC_CHANNELS.entry.changed, db.getLibraryRevision());
      bad.isDestroyed.mockReturnValue(true);
      createSource(db, "third");
      const calls = bad.send.mock.calls.length;
      createSource(db, "fourth");
      expect(bad.send).toHaveBeenCalledTimes(calls);
      expect(good.send).toHaveBeenCalledTimes(4);
      await drain();
      createSource(db, "after-drain");
      expect(good.send).toHaveBeenCalledTimes(4);
    } finally { await drain(); db.close(); }
  });

  it("registers one lifetime listener per window and releases it immediately on destruction", async () => {
    const db = new ReadingDatabase(":memory:"); const sender = createSender(1);
    const drain = registerIpcHandlers({ database: db } as never);
    try {
      const list = handlers.get(IPC_CHANNELS.source.list)!;
      await list({ sender }); await list({ sender });
      expect(sender.listenerCount("destroyed")).toBe(1);
      sender.isDestroyed.mockReturnValue(true);
      Object.defineProperty(sender, "id", { get: () => { throw new Error("Destroyed window identity is unavailable"); } });
      sender.emit("destroyed");
      expect(sender.listenerCount("destroyed")).toBe(0);
      const checks = sender.isDestroyed.mock.calls.length;
      createSource(db, "after-destroy");
      expect(sender.isDestroyed).toHaveBeenCalledTimes(checks);
      expect(sender.send).not.toHaveBeenCalled();
    } finally { await drain(); db.close(); }
  });

  it("does not retain an already-destroyed window as a library observer", async () => {
    const db = new ReadingDatabase(":memory:"); const sender = createSender(1); sender.isDestroyed.mockReturnValue(true);
    const drain = registerIpcHandlers({ database: db } as never);
    try {
      await handlers.get(IPC_CHANNELS.source.list)!({ sender });
      const checks = sender.isDestroyed.mock.calls.length;
      createSource(db, "after-closed-read");
      expect(sender.isDestroyed).toHaveBeenCalledTimes(checks);
      expect(sender.listenerCount("destroyed")).toBe(0); expect(sender.send).not.toHaveBeenCalled();
    } finally { await drain(); db.close(); }
  });

  it("detaches surviving observers on shutdown and makes repeated drain harmless", async () => {
    const db = new ReadingDatabase(":memory:"); const sender = createSender(1);
    const drain = registerIpcHandlers({ database: db } as never);
    try {
      await handlers.get(IPC_CHANNELS.source.list)!({ sender });
      expect(sender.listenerCount("destroyed")).toBe(1);
      await drain(); await drain();
      expect(sender.listenerCount("destroyed")).toBe(0);
      sender.emit("destroyed"); createSource(db, "after-drain");
      expect(sender.send).not.toHaveBeenCalled();
    } finally { await drain(); db.close(); }
  });

  it("does not let an old owner callback remove a replacement with the same id", async () => {
    const db = new ReadingDatabase(":memory:"); const previous = createSender(1); const current = createSender(1);
    const drain = registerIpcHandlers({ database: db } as never);
    try {
      const list = handlers.get(IPC_CHANNELS.source.list)!;
      await list({ sender: previous });
      const oldDestroy = previous.listeners("destroyed")[0];
      await list({ sender: current });
      expect(previous.listenerCount("destroyed")).toBe(0);
      expect(current.listenerCount("destroyed")).toBe(1);
      oldDestroy(); previous.isDestroyed.mockReturnValue(true); await list({ sender: previous });
      createSource(db, "replacement");
      expect(current.send).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.entry.changed, db.getLibraryRevision());
      expect(previous.send).not.toHaveBeenCalled();
    } finally { await drain(); db.close(); }
  });
});
