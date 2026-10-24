import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const directory=await mkdtemp(path.join(tmpdir(),'reading-hub-offline-smoke-'));
async function phase(name){
 await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[path.join(root,'node_modules/electron/cli.js'),path.join(root,'scripts/offline-reader-smoke-app'),name,directory],{cwd:root,stdio:'inherit'});
  const timeout=setTimeout(()=>{child.kill('SIGTERM');reject(new Error(`Offline ${name} timed out`));},60000);
  child.on('error',error=>{clearTimeout(timeout);reject(error);});
  child.on('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(new Error(`Offline ${name} failed: ${code}`));});
 });
}
try{await phase('collect');await phase('offline');console.log('Offline restart: structured document, two images, zero network requests passed.');}
finally{await rm(directory,{recursive:true,force:true});}
