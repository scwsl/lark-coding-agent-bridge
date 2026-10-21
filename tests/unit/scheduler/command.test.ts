import { describe, expect, it } from 'vitest';
import { parseAbsoluteTime, parseAdd, parseDuration, parseSchedule } from '../../../src/scheduler/command';

const NOW = new Date('2026-09-22T10:00:00').getTime();

describe('/cron add parsing', () => {
  it('splits schedule and prompt on the pipe', () => {
    const parsed = parseAdd('0 9 * * 1-5 | 看一下昨天 CI 的失败', NOW);
    expect(parsed).toMatchObject({
      ok: true,
      value: { schedule: { kind: 'cron', expr: '0 9 * * 1-5' }, prompt: '看一下昨天 CI 的失败', session: 'fresh' },
    });
  });

  it('peels a five-field cron off the front without a pipe', () => {
    const parsed = parseAdd('0 9 * * 1-5 看一下昨天 CI 的失败', NOW);
    expect(parsed).toMatchObject({
      ok: true,
      value: { schedule: { kind: 'cron', expr: '0 9 * * 1-5' }, prompt: '看一下昨天 CI 的失败' },
    });
  });

  it('peels an @alias off the front', () => {
    expect(parseAdd('@daily 巡检一遍日志', NOW)).toMatchObject({
      ok: true,
      value: { schedule: { kind: 'cron', expr: '@daily' }, prompt: '巡检一遍日志' },
    });
  });

  it('understands relative one-shots', () => {
    const parsed = parseAdd('in 30m | 提醒我看部署', NOW);
    expect(parsed).toMatchObject({ ok: true, value: { schedule: { kind: 'once', at: NOW + 1_800_000 } } });
  });

  it('understands absolute one-shots', () => {
    expect(parseAdd('at 2026-10-01 09:30 | 发月报', NOW)).toMatchObject({
      ok: true,
      value: { schedule: { kind: 'once', at: new Date('2026-10-01T09:30:00').getTime() } },
    });
  });

  it('honours --continue', () => {
    expect(parseAdd('--continue @daily | 继续昨天的排查', NOW)).toMatchObject({
      ok: true,
      value: { session: 'continue' },
    });
  });

  it('rejects a missing prompt, a missing schedule and unparseable input', () => {
    expect(parseAdd('@daily', NOW)).toMatchObject({ ok: false });
    expect(parseAdd('| 只有内容', NOW)).toMatchObject({ ok: false });
    expect(parseAdd('每天早上帮我看看日志', NOW)).toMatchObject({ ok: false });
    expect(parseAdd('61 9 * * * | 越界', NOW)).toMatchObject({ ok: false });
  });

  it('rejects a one-shot in the past', () => {
    expect(parseSchedule('at 2020-01-01 09:00', NOW)).toMatchObject({ ok: false });
  });

  it('rejects a cron that can never fire', () => {
    expect(parseSchedule('0 0 30 2 *', NOW)).toMatchObject({ ok: false });
  });
});

describe('duration and clock parsing', () => {
  it('parses single and compound durations', () => {
    expect(parseDuration('45s')).toBe(45_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('1d')).toBe(86_400_000);
  });

  it('rejects junk', () => {
    expect(parseDuration('soon')).toBeUndefined();
    expect(parseDuration('30x')).toBeUndefined();
    expect(parseDuration('30m extra')).toBeUndefined();
  });

  it('rolls a clock time that already passed today into tomorrow', () => {
    expect(parseAbsoluteTime('09:30', NOW)).toBe(new Date('2026-09-23T09:30:00').getTime());
    expect(parseAbsoluteTime('11:30', NOW)).toBe(new Date('2026-09-22T11:30:00').getTime());
  });

  it('rejects impossible clock times', () => {
    expect(parseAbsoluteTime('25:00', NOW)).toBeUndefined();
    expect(parseAbsoluteTime('09:70', NOW)).toBeUndefined();
  });
});

describe('/cron add --name', () => {
  it('takes a single-word name before the schedule', () => {
    expect(parseAdd('--name 储能周报 0 6 * * 6 | 执行每周更新', NOW)).toMatchObject({
      ok: true,
      value: { name: '储能周报', schedule: { kind: 'cron', expr: '0 6 * * 6' }, prompt: '执行每周更新' },
    });
  });

  it('accepts quoted names with spaces and mixes with --continue', () => {
    expect(parseAdd('--continue --name "CI 日报" @daily | 看日志', NOW)).toMatchObject({
      ok: true,
      value: { name: 'CI 日报', session: 'continue', schedule: { kind: 'cron', expr: '@daily' } },
    });
    expect(parseAdd('--name=“储能 周报” @daily | 看日志', NOW)).toMatchObject({ ok: true, value: { name: '储能 周报' } });
  });

  it('leaves name unset when absent and rejects overlong names', () => {
    const plain = parseAdd('@daily | 看日志', NOW);
    expect(plain.ok).toBe(true);
    expect(plain.ok ? plain.value.name : 'x').toBeUndefined();
    expect(parseAdd(`--name ${'长'.repeat(41)} @daily | 看日志`, NOW)).toMatchObject({ ok: false });
  });
});
