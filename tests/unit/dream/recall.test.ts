import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentTranscript, TranscriptExchange } from '../../../src/agent/session-transcript.js';
import { markdownPaths, TranscriptBuilder } from '../../../src/agent/transcript-builder.js';
import { localDay, recallKey, RecallStore } from '../../../src/dream/recall.js';
import type { DreamSessionRecord } from '../../../src/dream/state.js';

const KB = '/home/u/.lark-channel/profiles/claude/knowledge';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-27T12:00:00Z');
const TZ = 'Asia/Shanghai';

function exchange(index: number, reads: string[] = [], at = NOW - 3 * HOUR): TranscriptExchange {
  return { index, user: `问题 ${index}`, assistant: `答案 ${index}`, mixedSenders: false, at, ...(reads.length ? { reads } : {}) };
}

function record(handle: string, lastSeenAt = NOW - 2 * HOUR): DreamSessionRecord {
  return { key: `claude:${handle}`, agentId: 'claude', handle, scopeId: `oc_${handle}`, cwd: '/tmp', firstSeenAt: NOW - DAY, lastSeenAt, consumed: 0 };
}

describe('markdownPaths / TranscriptBuilder.tool', () => {
  it('keeps the Markdown paths a tool call names, once each', () => {
    expect(markdownPaths(`cat ${KB}/notes/external/a.md ~/x/skills/s/SKILL.md ${KB}/notes/external/a.md /tmp/a.mdx`)).toEqual([
      `${KB}/notes/external/a.md`,
      '~/x/skills/s/SKILL.md',
    ]);
    const builder = new TranscriptBuilder();
    builder.tool({ file_path: '/ignored.md' });
    builder.request({ text: '问', mixedSenders: false });
    builder.tool({ file_path: `${KB}/notes/oc_1/build.md` });
    builder.tool({ command: `grep x ${KB}/notes/oc_1/build.md` });
    builder.tool({ command: 'ls' });
    expect(builder.result().exchanges[0]?.reads).toEqual([`${KB}/notes/oc_1/build.md`]);
  });
});

describe('recallKey', () => {
  it('maps notes of this knowledge directory and any SKILL.md', () => {
    expect(recallKey(`${KB}/notes/external/feishu-card.md`, KB)).toBe('note:external/feishu-card');
    expect(recallKey('~/.lark-channel/profiles/claude/knowledge/notes/oc_1_omt_2/x-y.md', KB, '/home/u')).toBe('note:oc_1_omt_2/x-y');
    expect(recallKey(`${KB}/notes/oc_1/dir/deeper.md`, KB)).toBeUndefined();
    expect(recallKey('/other/knowledge/notes/oc_1/x.md', KB)).toBeUndefined();
    expect(recallKey('/lib/occam-skills/skills/antelope-tcpdump/SKILL.md', KB)).toBe('skill:antelope-tcpdump');
    expect(recallKey('/tmp/README.md', KB)).toBeUndefined();
  });

  it('formats local days in the given time zone', () => {
    expect(localDay(Date.parse('2026-10-26T17:00:00Z'), TZ)).toBe('2026-10-27');
  });
});

describe('RecallStore.scan', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lcb-recall-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const note = (name: string) => `${KB}/notes/${name}.md`;

  it('counts reads per key once per exchange, incrementally, and persists only counts', async () => {
    const store = new RecallStore(join(dir, 'recall.json'));
    const transcripts: Record<string, AgentTranscript> = {
      a: {
        exchanges: [exchange(1, [note('oc_1/build'), note('oc_1/build')]), exchange(2, [note('external/kube'), '/lib/skills/s1/SKILL.md'])],
        lastActivityAt: NOW - 2 * HOUR,
      },
      b: { exchanges: [exchange(1, [note('external/kube')], NOW - 3 * DAY)], lastActivityAt: NOW - 3 * DAY },
    };
    const read = async (r: DreamSessionRecord) => transcripts[r.handle];
    const first = await store.scan({ records: [record('a'), record('b')], read, knowledgeDir: KB, now: NOW, timezone: TZ, idleMs: HOUR });
    expect(first).toEqual({ sessions: 2, exchanges: 3, reads: 4 });
    expect(store.readsWithin('note:external/kube', 30, NOW, TZ)).toBe(2);
    expect(store.readsWithin('note:external/kube', 1, NOW, TZ)).toBe(1);
    expect(store.item('note:external/kube')?.sessions).toEqual(['claude:a', 'claude:b']);
    expect(store.top('note:', 30, NOW, TZ, 5)).toEqual([
      { key: 'note:external/kube', reads: 2 },
      { key: 'note:oc_1/build', reads: 1 },
    ]);
    expect(store.since()).toBe(NOW - 3 * DAY);

    // Nothing new: no turn since the scan, nothing counted twice.
    const again = await store.scan({ records: [record('a'), record('b')], read, knowledgeDir: KB, now: NOW + HOUR, timezone: TZ, idleMs: HOUR });
    expect(again).toEqual({ sessions: 0, exchanges: 0, reads: 0 });

    // A new exchange in `a`: only it is counted.
    transcripts.a!.exchanges.push(exchange(3, [note('oc_1/build')], NOW + HOUR));
    transcripts.a!.lastActivityAt = NOW + HOUR;
    const more = await store.scan({ records: [record('a', NOW + HOUR)], read, knowledgeDir: KB, now: NOW + 3 * HOUR, timezone: TZ, idleMs: HOUR });
    expect(more).toEqual({ sessions: 1, exchanges: 1, reads: 1 });
    expect(store.readsWithin('note:oc_1/build', 30, NOW + 3 * HOUR, TZ)).toBe(2);

    await store.flush();
    const saved = await readFile(join(dir, 'recall.json'), 'utf8');
    expect(saved).not.toContain('问题');
    const reloaded = new RecallStore(join(dir, 'recall.json'));
    await reloaded.load();
    expect(reloaded.readsWithin('note:oc_1/build', 30, NOW + 3 * HOUR, TZ)).toBe(2);
  });

  it('leaves the last exchange of a conversation still going for later', async () => {
    const store = new RecallStore(join(dir, 'recall.json'));
    const transcript: AgentTranscript = {
      exchanges: [exchange(1, [note('oc_1/a')]), exchange(2, [note('oc_1/b')], NOW - 5 * 60_000)],
      lastActivityAt: NOW - 5 * 60_000,
    };
    const read = async () => transcript;
    const busy = await store.scan({ records: [record('a', NOW - 5 * 60_000)], read, knowledgeDir: KB, now: NOW, timezone: TZ, idleMs: HOUR });
    expect(busy.reads).toBe(1);
    expect(store.readsWithin('note:oc_1/b', 30, NOW, TZ)).toBe(0);
    const later = await store.scan({ records: [record('a', NOW - 5 * 60_000)], read, knowledgeDir: KB, now: NOW + 2 * HOUR, timezone: TZ, idleMs: HOUR });
    expect(later.reads).toBe(1);
    expect(store.readsWithin('note:oc_1/b', 30, NOW + 2 * HOUR, TZ)).toBe(1);
    await store.flush();
  });

  it('does not count a rewritten transcript twice', async () => {
    const store = new RecallStore(join(dir, 'recall.json'));
    let transcript: AgentTranscript = { exchanges: [exchange(1, [note('oc_1/a')]), exchange(2)], lastActivityAt: NOW - 2 * HOUR };
    const read = async () => transcript;
    await store.scan({ records: [record('a')], read, knowledgeDir: KB, now: NOW, timezone: TZ, idleMs: HOUR });
    transcript = { exchanges: [exchange(1, [note('oc_1/a')], NOW), { ...exchange(2), user: '改写过' }, exchange(3)], lastActivityAt: NOW };
    const after = await store.scan({ records: [record('a', NOW)], read, knowledgeDir: KB, now: NOW + 2 * HOUR, timezone: TZ, idleMs: HOUR });
    expect(after.reads).toBe(0);
    expect(store.readsWithin('note:oc_1/a', 30, NOW + 2 * HOUR, TZ)).toBe(1);
    await store.flush();
  });
});

describe('RecallStore.observeNotes / archivable', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lcb-recall-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('archives what was known, unchanged and unread for the whole window, and only once the counts cover it', async () => {
    const store = new RecallStore(join(dir, 'recall.json'));
    const t0 = NOW - 40 * DAY;
    store.observeNotes(
      [
        { key: 'note:oc_1/old', hash: 'h1' },
        { key: 'note:oc_1/read', hash: 'h2' },
        { key: 'note:oc_1/edited', hash: 'h3' },
        { key: 'note:oc_1/gone', hash: 'h4' },
      ],
      t0,
    );
    // No read counts yet: nothing can be told unread.
    expect(store.archivable(30, NOW, TZ, 20)).toEqual([]);

    const transcript: AgentTranscript = {
      exchanges: [exchange(1, [`${KB}/notes/oc_1/read.md`], NOW - 2 * DAY)],
      lastActivityAt: NOW - 2 * DAY,
    };
    await store.scan({ records: [record('a')], read: async () => transcript, knowledgeDir: KB, now: NOW - DAY, timezone: TZ, idleMs: HOUR });
    store.observeNotes(
      [
        { key: 'note:oc_1/old', hash: 'h1' },
        { key: 'note:oc_1/read', hash: 'h2' },
        { key: 'note:oc_1/edited', hash: 'h3-new' },
        { key: 'note:oc_1/new', hash: 'h5' },
      ],
      NOW - 5 * DAY,
    );
    // The scan counted a read from two days ago, so the counts begin there: still too short.
    expect(store.archivable(30, NOW, TZ, 20)).toEqual([]);
    expect(store.archivable(30, NOW + 40 * DAY, TZ, 20)).toEqual(['note:oc_1/old', 'note:oc_1/read', 'note:oc_1/edited', 'note:oc_1/new']);
    expect(store.archivable(30, NOW + 40 * DAY, TZ, 1)).toEqual(['note:oc_1/old']);

    await store.flush();
    const reloaded = new RecallStore(join(dir, 'recall.json'));
    await reloaded.load();
    expect(reloaded.archivable(30, NOW + 40 * DAY, TZ, 20)).toHaveLength(4);
  });

  it('keeps a note that was read or changed within the window', async () => {
    const store = new RecallStore(join(dir, 'recall.json'));
    const t0 = NOW - 60 * DAY;
    const transcript: AgentTranscript = { exchanges: [exchange(1, [`${KB}/notes/oc_1/read.md`], NOW - 3 * DAY)], lastActivityAt: NOW - 3 * DAY };
    store.observeNotes([{ key: 'note:oc_1/old', hash: 'a' }, { key: 'note:oc_1/read', hash: 'b' }, { key: 'note:oc_1/edited', hash: 'c' }], t0);
    await store.scan({
      records: [record('a', NOW - 3 * DAY)],
      read: async () => ({ exchanges: [exchange(1, [], t0), ...transcript.exchanges.map((item) => ({ ...item, index: 2 }))], lastActivityAt: NOW - 3 * DAY }),
      knowledgeDir: KB,
      now: NOW,
      timezone: TZ,
      idleMs: HOUR,
    });
    store.observeNotes([{ key: 'note:oc_1/old', hash: 'a' }, { key: 'note:oc_1/read', hash: 'b' }, { key: 'note:oc_1/edited', hash: 'c2' }], NOW - DAY);
    expect(store.archivable(30, NOW, TZ, 20)).toEqual(['note:oc_1/old']);
    await store.flush();
  });
});
