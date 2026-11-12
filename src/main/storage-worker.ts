import {ReadingDatabase} from "./database";
import {databaseWriteMethods,rewriteMethods,libraryWriteErrors} from "./library-write-contract";
import {SyncCancelledError} from "./sync-state";
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ArticleStore, ArticlePersistenceContentError } from "./persistence/article-store";
import { migrateDatabaseSchema } from "./persistence/schema";
import { resolveDataLocation, type DataLocationResolverOptions } from "./data-location-migration";

const methods = new Set<keyof ArticleStore>([
  "read", "save", "registerImage", "ownsImage", "hasOriginal", "hasOriginalForUrl", "reuseImage",
  "imageReferrer", "image", "imageBytes", "hasImage", "saveImage", "enqueue", "reconcileSource", "retryAuthentication",
  "recover", "pendingMedia", "nextAcquisition", "nextAcquisitionRetry", "beginMedia", "beginAcquisition",
  "finishAcquisition", "finishMedia", "retryTransient"
]);
let database: ReadingDatabase | undefined;
let store: ArticleStore | undefined;
let queue = Promise.resolve();
function open(file: string): Database.Database {
  const db = new Database(file);
  try { db.pragma("journal_mode = WAL"); db.pragma("foreign_keys = ON"); return db; }
  catch (error) { db.close(); throw error; }
}
parentPort!.on("message", (request: { id: number; method: string; args: unknown[] }) => {
  queue = queue.then(async () => {
    try {
      let value: unknown;
      if (request.method === "close") {
        database?.close(); parentPort!.postMessage({ id: request.id }); parentPort!.close(); return;
      } else if (request.method === "prepare") {
        const options = request.args[0] as DataLocationResolverOptions;
        const resolution = await resolveDataLocation(options);
        if (["fresh", "canonical", "migrated"].includes(resolution.kind)) {
          await mkdir(path.dirname(resolution.databasePath), { recursive: true });
          const db = open(resolution.databasePath);
          try { migrateDatabaseSchema(db); } finally { db.close(); }
        }
        value = resolution;
      } else {
        if (!workerData.databasePath) throw new Error();
        const [namespace,name]=request.method.includes(":")?request.method.split(":"):["article",request.method];
        const allowed=namespace==="database"?databaseWriteMethods:namespace==="rewrite"?rewriteMethods:namespace==="article"?[...methods]:[];
        if(!(allowed as readonly string[]).includes(name))throw new Error();
        if (!database) { database = new ReadingDatabase(workerData.databasePath); store = database.articles; }
        const owner=namespace==="database"?database:namespace==="rewrite"?database.rewrites:store!;
        const operation=Reflect.get(owner,name) as (...args:unknown[])=>unknown;
        value=operation.apply(owner,request.args);
      }
      parentPort!.postMessage({ id: request.id, value });
    } catch (error) {
      // Never return SQLite paths, bound parameters or source/model payloads.
      parentPort!.postMessage({ id: request.id, error: error instanceof Error && libraryWriteErrors.some(message=>message===error.message) ? "domain" : error instanceof SyncCancelledError ? "cancelled" : error instanceof ArticlePersistenceContentError ? "content" : "storage",
        ...(error instanceof ArticlePersistenceContentError || error instanceof Error && libraryWriteErrors.some(message=>message===error.message) ? { message: error.message } : {}) });
    }
  });
});
