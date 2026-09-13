import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { layers, makePlan, parseOptions } from './plan.mjs';

test('rejects misspelled scopes/options instead of silently reducing coverage', () => {
  for (const args of [['--scope'], ['--scope', 'rewirte'], ['--visul'], ['--scope', 'docs', '--visual']]) {
    assert.throws(() => parseOptions(args));
  }
});
test('full core covers tests once; optional audits reuse one build', () => {
  const plan = makePlan(parseOptions(['--visual', '--reader']));
  assert.equal(plan.filter(s => s.id === 'build').length, 1);
  assert.equal(plan.filter(s => s.id === 'tests').length, 1);
  assert.ok(plan.findIndex(s => s.id === 'build') < plan.findIndex(s => s.id === 'visual'));
  assert.equal(plan.find(s => s.id === 'reader').env.READING_HUB_READER_AUDIT, '1');
  assert.deepEqual(makePlan(parseOptions(['--scope', 'docs'])).map(s => s.id), ['diff']);
});
test('rewrite plan includes all four layers with no duplicated test files', () => {
  const plan = makePlan(parseOptions(['--scope', 'rewrite']));
  for (const layer of Object.keys(layers)) assert.ok(plan.some(s => s.id === layer));
  const files = Object.values(layers).flat();
  assert.equal(new Set(files).size, files.length);
});

// Exercise the real orchestrator in isolated repositories; never run builds/models in these tests.
for (const scenario of ['success', 'failure', 'changed', 'whitespace']) test(`runner evidence: ${scenario}`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'reading-hub-verify-'));
  const root = join(directory, 'repo'); mkdirSync(root);
  try {
    const put = (file, text) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };
    for (const file of ['scripts/verify.mjs', 'scripts/verification/plan.mjs', 'scripts/verification/diff.mjs']) {
      mkdirSync(dirname(join(root, file)), { recursive: true }); copyFileSync(file, join(root, file));
    }
    for (const file of Object.values(layers).flat()) put(file, '// fixture\n');
    put('.gitignore', '.verification/\n'); put('source.txt', 'before\n');
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
    put('clean-new.md', 'New file\n');
    if (scenario === 'whitespace') put('new.md', 'trailing space  \n');
    const npm = join(directory, 'npm.cjs');
    writeFileSync(npm, `const fs=require('node:fs');
      if(process.argv.includes('build')) {
        if(${JSON.stringify(scenario)}==='failure') process.exit(7);
        if(${JSON.stringify(scenario)}==='changed') fs.writeFileSync('source.txt','changed');
      }`);
    const result = spawnSync(process.execPath, ['scripts/verify.mjs'], { cwd: root, env: { ...process.env, npm_execpath: npm }, encoding: 'utf8', timeout: 30000 });
    const report = JSON.parse(readFileSync(join(root, '.verification/latest.json'), 'utf8'));
    assert.equal(result.status, scenario === 'success' ? 0 : 1, result.stderr);
    assert.equal(report.status, scenario === 'success' ? 'passed' : 'failed');
    assert.equal(report.sourceUnchanged, scenario !== 'changed');
    assert.match(report.sourceHash, /^[a-f0-9]{64}$/);
    assert.ok(report.limits.includes('No real model calls or translation-quality evaluation'));
    if (scenario === 'whitespace') {
      assert.equal(report.steps[0].status, 'failed');
      assert.equal(report.steps[1].status, 'not-run');
    }
    if (scenario === 'failure') {
      assert.equal(report.steps.find(s => s.id === 'build').exitCode, 7);
      assert.equal(report.steps.find(s => s.id === 'style').status, 'not-run');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
