import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../../../src/runtime/audit-log';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const DAY = 86_400_000;

describe('AuditLog', () => {
  it('appends privately, reads newest first, skips torn lines, and drops entries past 90 days on load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'));
    dirs.push(dir);
    const path = join(dir, 'audit.jsonl');
    let now = 100 * DAY;
    const log = new AuditLog(path, () => now);
    log.append({ kind: 'tool', actorId: 'ou_old', source: 'im', scopeId: 's', tool: 'Bash', summary: 'old' });
    now = 195 * DAY;
    log.append({ kind: 'tool', actorId: 'ou_a', source: 'im', scopeId: 's', tool: 'Bash', summary: 'a1' });
    log.append({ kind: 'tool', actorId: 'ou_b', source: 'im', scopeId: 's', tool: 'Write', summary: 'b1' });
    await log.flush();
    await appendFile(path, '{"at":1,"kind":"tool","actorId":"ou_torn"');
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    expect((await log.query({ limit: 10 })).map((e) => e.summary)).toEqual(['b1', 'a1', 'old']);
    expect((await log.query({ limit: 10, actorId: 'ou_a' })).map((e) => e.summary)).toEqual(['a1']);

    const reloaded = new AuditLog(path, () => now);
    await reloaded.load();
    expect((await reloaded.query({ limit: 10 })).map((e) => e.summary)).toEqual(['b1', 'a1']);
    expect(await readFile(path, 'utf8')).not.toContain('ou_old');
  });
});
