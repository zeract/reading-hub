import { buildSync } from "esbuild";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterAll } from "vitest";
import type * as WorkerModule from "../../src/main/storage-worker-client";

/** Vitest executes TS; native workers need an executable bundle. Use the real
 * worker/client and native SQLite, changing only the fixture's module path. */
export function storageWorkerFixture(actual: typeof WorkerModule): typeof WorkerModule {
 const directory=mkdtempSync(path.join(tmpdir(),"app-storage-worker-")),file=path.join(directory,"worker.cjs");
 symlinkSync(path.resolve("node_modules"),path.join(directory,"node_modules"),"dir");
 buildSync({entryPoints:[path.resolve("src/main/storage-worker.ts")],outfile:file,bundle:true,platform:"node",format:"cjs",external:["better-sqlite3"],logLevel:"silent"});
 afterAll(()=>rmSync(directory,{recursive:true,force:true}));
 return {...actual,StorageWorkerClient:class extends actual.StorageWorkerClient {constructor(databasePath?:string){super(databasePath,file)}}};
}
