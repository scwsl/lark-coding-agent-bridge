import { describe, expect, it } from 'vitest';
import { autoResumePrompt } from '../../../src/bot/auto-resume.js';
import { detectLocale } from '../../../src/card/i18n.js';
import { pauseNotice } from '../../../src/card/pause-notice.js';
import { renderCard } from '../../../src/card/run-renderer.js';
import { initialState } from '../../../src/card/run-state.js';
import { renderText } from '../../../src/card/text-renderer.js';

describe('reply language', () => {
  it('is Chinese whenever the caller wrote any Chinese, and by default', () => {
    expect(detectLocale(['帮我看下这个 bug'])).toBe('zh');
    expect(detectLocale(['check this', '另外这个也看下'])).toBe('zh');
    expect(detectLocale([''])).toBe('zh');
    expect(detectLocale(['👍 123'])).toBe('zh');
  });

  it('follows a caller who wrote only in another language', () => {
    expect(detectLocale(['Please check the build'])).toBe('en');
    expect(detectLocale(['Bitte prüfe den Build'])).toBe('en');
  });

  it('renders the run card chrome in that language', () => {
    const zh = JSON.stringify(
      renderCard(initialState, { activity: { elapsedMs: 65_000, idleMs: 3_000 } }),
    );
    expect(zh).toContain('🧠 正在思考 · 已运行 1:05 · 上次动静 3 秒前');
    expect(zh).toContain('⏹ 终止');

    const en = JSON.stringify(
      renderCard(initialState, { locale: 'en', activity: { elapsedMs: 65_000, idleMs: 3_000 } }),
    );
    expect(en).toContain('🧠 Thinking · running 1:05 · last activity 3s ago');
    expect(en).toContain('⏹ Stop');
    expect(en).toContain('Stop this task?');
    expect(en).not.toMatch(/\p{Script=Han}/u);
    expect(renderText({ ...initialState, terminal: 'interrupted', footer: null }, 'en')).toBe(
      '_⏹ Stopped_',
    );
  });

  it('pauses and resumes in the caller language', () => {
    const limit = { limitType: 'five_hour', at: 0, resetsAt: 1, autoResumeAt: 2 };
    expect(pauseNotice(limit, 'en')).toContain('the Claude 5-hour quota is used up');
    expect(pauseNotice(limit)).toContain('Claude 5 小时额度已用完');
    expect(autoResumePrompt('seven_day', 'en')).toContain('[auto-resume]');
    expect(autoResumePrompt('seven_day', 'en')).not.toMatch(/\p{Script=Han}/u);
    expect(autoResumePrompt('seven_day')).toContain('本周额度');
  });
});
