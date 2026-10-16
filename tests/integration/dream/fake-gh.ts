import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

/**
 * A stand-in `gh` on PATH for 课堂精练's publishing: answers the handful of
 * calls it makes and logs each one. `permission` is what `repo view` reports;
 * `FAKE_GH_PR_VIEW` (JSON) replaces what `pr view` reports, `FAKE_GH_PR_URL`
 * the URL `pr create` prints.
 */
export async function installFakeGh(root: string, opts: { permission?: string } = {}) {
  const bin = join(root, 'fake-bin');
  const log = join(root, 'gh-calls.jsonl');
  await mkdir(bin, { recursive: true });
  const script = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const permission = process.env.FAKE_GH_PERMISSION || ${JSON.stringify(opts.permission ?? 'WRITE')};
if (args[0] === 'repo' && args[1] === 'view') {
  console.log(JSON.stringify({ viewerPermission: permission }));
} else if (args[0] === 'pr' && args[1] === 'list') {
  console.log('[]');
} else if (args[0] === 'pr' && args[1] === 'create') {
  if (process.env.FAKE_GH_CREATE_FAIL) { console.error('GraphQL: boom'); process.exit(1); }
  const body = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ body }) + '\\n');
  console.log(process.env.FAKE_GH_PR_URL || 'https://github.com/acme/repo/pull/7');
} else if (args[0] === 'pr' && args[1] === 'view') {
  console.log(process.env.FAKE_GH_PR_VIEW || JSON.stringify({ state: 'OPEN', isDraft: true, reviewDecision: '' }));
} else if (args[0] === 'pr' && args[1] === 'diff') {
  console.log('diff --git a/x b/x');
} else {
  console.error('unexpected gh call: ' + args.join(' '));
  process.exit(2);
}
`;
  await writeFile(join(bin, 'gh'), script, { mode: 0o755 });
  await chmod(join(bin, 'gh'), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previous ?? ''}`;
  return {
    async calls(): Promise<Array<{ args?: string[]; body?: string }>> {
      try {
        return (await readFile(log, 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { args?: string[]; body?: string });
      } catch {
        return [];
      }
    },
    restore() {
      process.env.PATH = previous;
      delete process.env.FAKE_GH_PERMISSION;
      delete process.env.FAKE_GH_CREATE_FAIL;
      delete process.env.FAKE_GH_PR_VIEW;
      delete process.env.FAKE_GH_PR_URL;
    },
  };
}
