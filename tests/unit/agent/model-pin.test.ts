import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelPinStore, parseModelCommand } from '../../../src/agent/model-pin.js';

describe('parseModelCommand', () => {
  it('reads a model and the task after it, case-insensitively', () => {
    expect(parseModelCommand('/model sonnet 帮我看下')).toEqual({ kind: 'set', model: 'sonnet', rest: '帮我看下' });
    expect(parseModelCommand('  /Model FABLE\n多行\n任务')).toEqual({ kind: 'set', model: 'fable', rest: '多行\n任务' });
    expect(parseModelCommand('/model haiku')).toEqual({ kind: 'set', model: 'haiku', rest: '' });
    expect(parseModelCommand('/model opus x')).toEqual({ kind: 'set', model: 'opus', rest: 'x' });
  });

  it('bare /model shows, auto/off clears, anything else is invalid', () => {
    expect(parseModelCommand('/model')).toEqual({ kind: 'show' });
    expect(parseModelCommand('/model  ')).toEqual({ kind: 'show' });
    expect(parseModelCommand('/model auto')).toEqual({ kind: 'clear' });
    expect(parseModelCommand('/model OFF')).toEqual({ kind: 'clear' });
    expect(parseModelCommand('/model gpt5 你好')).toEqual({ kind: 'invalid', name: 'gpt5' });
  });

  it('ignores other commands and /model not at the start', () => {
    expect(parseModelCommand('/models sonnet')).toBeUndefined();
    expect(parseModelCommand('/modelsonnet x')).toBeUndefined();
    expect(parseModelCommand('请用 /model sonnet')).toBeUndefined();
    expect(parseModelCommand('/xhigh 帮我')).toBeUndefined();
  });
});

describe('ModelPinStore', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('keeps pins across a reload and forgets deleted ones', async () => {
    dir = await mkdtemp(join(tmpdir(), 'model-pin-'));
    const path = join(dir, 'model-pins.json');
    const a = new ModelPinStore(path);
    a.set('oc_1:omt_1', 'sonnet', 'ou_x', 1000);
    a.set('oc_1:omt_2', 'haiku', undefined, 1000);
    expect(a.delete('oc_1:omt_2')).toBe(true);
    expect(a.delete('oc_1:omt_2')).toBe(false);
    await a.flush();
    const b = new ModelPinStore(path);
    await b.load(2000);
    expect(b.get('oc_1:omt_1')).toEqual({ model: 'sonnet', setBy: 'ou_x', updatedAt: 1000 });
    expect(b.get('oc_1:omt_2')).toBeUndefined();
  });

  it('drops stale and malformed entries on load', async () => {
    dir = await mkdtemp(join(tmpdir(), 'model-pin-'));
    const path = join(dir, 'model-pins.json');
    const day = 24 * 60 * 60_000;
    await writeFile(
      path,
      JSON.stringify({
        fresh: { model: 'opus', updatedAt: 40 * day },
        old: { model: 'opus', updatedAt: 1 },
        bad: { model: 'gpt', updatedAt: 40 * day },
      }),
    );
    const s = new ModelPinStore(path);
    await s.load(41 * day);
    expect(s.get('fresh')?.model).toBe('opus');
    expect(s.get('old')).toBeUndefined();
    expect(s.get('bad')).toBeUndefined();
  });

  it('touch refreshes a pin at most once a day', async () => {
    dir = await mkdtemp(join(tmpdir(), 'model-pin-'));
    const path = join(dir, 'model-pins.json');
    const s = new ModelPinStore(path);
    const day = 24 * 60 * 60_000;
    s.set('x', 'sonnet', undefined, 0);
    s.touch('x', day / 2);
    expect(s.get('x')?.updatedAt).toBe(0);
    s.touch('x', 2 * day);
    expect(s.get('x')?.updatedAt).toBe(2 * day);
    await s.flush();
    expect(JSON.parse(await readFile(path, 'utf8')).x.updatedAt).toBe(2 * day);
  });
});
