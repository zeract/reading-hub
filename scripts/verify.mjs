import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, readlinkSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePlan, parseOptions, layers } from './verification/plan.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
function snapshot() {
  const hash = createHash('sha256');
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
  for (const file of [...new Set(files.split('\0').filter(Boolean))].sort()) {
    hash.update(JSON.stringify(file));
    try {
      const stat = lstatSync(file);
      hash.update(String(stat.mode));
      hash.update(stat.isSymbolicLink() ? readlinkSync(file) : readFileSync(file));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hash.update('deleted');
    }
    hash.update('\0');
  }
  return { commit: git('rev-parse', 'HEAD'), sourceHash: hash.digest('hex') };
}
function run(step) {
  return new Promise((resolveResult) => {
    let command = step.command, args = step.args;
    if (command === 'npm') {
      command = process.execPath;
      args = [process.env.npm_execpath, ...args];
    } else if (command === 'electron') {
      command = process.execPath;
      args = ['node_modules/electron/cli.js', ...args];
    }
    const child = spawn(command, args, {
      stdio: 'inherit', env: { ...process.env, ...step.env }, detached: process.platform !== 'win32'
    });
    let reason;
    const kill = (signal) => {
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch { /* child has already exited */ }
    };
    let forced;
    const stop = (why) => {
      reason = why;
      kill('SIGTERM');
      forced ??= setTimeout(() => kill('SIGKILL'), 2000);
    };
    const interrupt = () => stop('interrupted');
    const timer = setTimeout(() => stop('timeout'), (step.id === 'reader' ? 15 : 10) * 60_000);
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    child.once('error', () => { reason = 'could-not-start'; });
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(forced);
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      resolveResult({ status: code === 0 && !reason ? 'passed' : 'failed', exitCode: code, reason: reason ?? signal ?? undefined });
    });
  });
}
async function main() {
  if (!process.env.npm_execpath) throw new Error('Use npm run verify (or verify:rewrite)');
  const options = parseOptions(process.argv.slice(2));
  const plan = makePlan(options);
  // Validate every registered test even in core scope, so the matrix cannot silently go stale.
  for (const file of Object.values(layers).flat()) readFileSync(file);
  const report = {
    schemaVersion: 1, startedAt: new Date().toISOString(), ...snapshot(),
    platform: process.platform, node: process.version, scope: options.scope,
    layers: options.scope === 'docs' ? {} : layers,
    limits: [
      ...(!options.visual ? ['Electron window visual audit not run'] : []),
      ...(!options.reader ? ['Online source/media audit not run'] : []),
      'No real model calls or translation-quality evaluation',
      'No release signing, packaging or installed-app revision verification'
    ],
    steps: plan.map(step => ({ id: step.id, status: 'not-run' }))
  };
  const directory = '.verification';
  mkdirSync(directory, { recursive: true });
  const save = () => {
    const temporary = `${directory}/report-${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n');
    renameSync(temporary, `${directory}/latest.json`);
  };
  report.status = 'running'; save();
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i], start = Date.now();
    console.log(`\n[verify] ${step.id}`);
    report.steps[i] = { id: step.id, ...await run(step), durationMs: Date.now() - start }; save();
    if (report.steps[i].status !== 'passed') break;
  }
  report.finishedAt = new Date().toISOString();
  report.sourceUnchanged = JSON.stringify(snapshot()) === JSON.stringify({ commit: report.commit, sourceHash: report.sourceHash });
  report.status = report.sourceUnchanged && report.steps.every(step => step.status === 'passed') ? 'passed' : 'failed';
  save();
  console.log(`[verify] ${report.status}; selected scope only; report: .verification/latest.json`);
  if (!report.sourceUnchanged) console.error('[verify] Source changed during verification; results are stale.');
  process.exitCode = report.status === 'passed' ? 0 : 1;
}
main().catch(error => { console.error(`[verify] ${error.message}`); process.exitCode = 1; });
