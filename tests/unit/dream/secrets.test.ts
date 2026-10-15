import { describe, expect, it } from 'vitest';
import { findSecret, maskSecrets } from '../../../src/dream/secrets.js';

describe('dream secrets', () => {
  it.each([
    ['ghp_' + 'a'.repeat(36), 'github-token'],
    ['sk-ant-' + 'b'.repeat(40), 'api-key'],
    ['AKIA' + 'ABCDEFGHIJKLMNOP', 'aws-key'],
    ['Authorization: Bearer ' + 'c'.repeat(32), 'bearer'],
    ['https://user:hunter22@example.com/repo.git', 'url-credentials'],
    ['APP_SECRET=abcdef123456', 'assignment'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----', 'private-key'],
    ['u-' + 'd'.repeat(40), 'lark-token'],
  ])('finds %s', (text, label) => {
    expect(findSecret(`前面 ${text} 后面`)).toBe(label);
  });

  it('leaves ordinary text alone', () => {
    expect(findSecret('部署前先跑 pnpm ci:local，token 用完要续期')).toBeUndefined();
    expect(findSecret('menu-item-with-a-very-long-css-class-name-here')).toBeUndefined();
  });

  it('masks every occurrence', () => {
    const masked = maskSecrets(`a ghp_${'a'.repeat(36)} b ghp_${'b'.repeat(36)} c`);
    expect(masked).toBe('a [REDACTED] b [REDACTED] c');
  });
});
