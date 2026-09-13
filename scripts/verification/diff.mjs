import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
function check(args, allowDifference = false) {
  const result = spawnSync('git', args, { stdio: 'inherit' });
  if (result.error || (result.status !== 0 && !(allowDifference && result.status === 1))) process.exit(result.status || 1);
}
// Include the delivered commit (CI), working/index changes and new, unstaged files.
check(['show', '--format=', '--check', 'HEAD']);
check(['diff', '--check', 'HEAD']);
const files = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' });
for (const file of files.split('\0').filter(Boolean)) {
  if (lstatSync(file).isFile()) check(['diff', '--no-index', '--check', '--', '/dev/null', file], true);
}
