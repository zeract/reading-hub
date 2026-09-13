// Explicit scopes: a path heuristic cannot determine a shared-contract change's risk.
export const layers = {
  extraction: ['test/reader-key-values.test.ts', 'test/article-reader.test.ts', 'test/content-normalizer.test.ts'],
  protocol: ['test/rewrite-paragraphs.test.ts', 'test/rewrite-response.test.ts', 'test/rewrite-protocol.test.ts'],
  persistence: ['test/article-document.test.ts', 'test/rewrite-document-storage.test.ts', 'test/rewrite-store.test.ts', 'test/rewrite-service.test.ts'],
  presentation: ['test/rewrite-layered-contract.test.tsx', 'test/rewrite-document.test.tsx', 'test/article-rewrite.test.tsx', 'test/rewrite-images.test.tsx', 'test/reader-image-lifetime.test.tsx']
};
export function parseOptions(args) {
  const options = { scope: 'core', visual: false, reader: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--scope') options.scope = args[++i];
    else if (arg === '--visual') options.visual = true;
    else if (arg === '--reader') options.reader = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!['core', 'rewrite', 'docs'].includes(options.scope)) throw new Error('scope must be core, rewrite or docs');
  if (options.scope === 'docs' && (options.visual || options.reader)) throw new Error('docs scope cannot run application audits');
  return options;
}
export function makePlan(options) {
  const steps = [{ id: 'diff', command: process.execPath, args: ['scripts/verification/diff.mjs'] }];
  if (options.scope === 'docs') return steps;
  steps.push({ id: 'workflow', command: 'npm', args: ['run', 'test:workflow'] });
  if (options.scope === 'core') steps.push({ id: 'tests', command: 'npm', args: ['test'] });
  else for (const [id, files] of Object.entries(layers)) steps.push({ id, command: 'npm', args: ['test', '--', ...files] });
  steps.push({ id: 'build', command: 'npm', args: ['run', 'build'] }, { id: 'style', command: 'npm', args: ['run', 'audit:style'] });
  // Direct entrypoints reuse the single build above. Keep existing standalone audit commands.
  if (options.visual) steps.push({ id: 'visual', command: 'electron', args: ['scripts/visual-audit-app'] });
  if (options.reader) steps.push({ id: 'reader', command: 'electron', args: ['.'], env: { READING_HUB_READER_AUDIT: '1' } });
  return steps;
}
