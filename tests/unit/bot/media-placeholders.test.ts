import { describe, expect, it } from 'vitest';
import { mediaPlaceholders } from '../../../src/bot/media-placeholders';

describe('mediaPlaceholders', () => {
  it('numbers each kind separately in reading order', () => {
    expect(
      mediaPlaceholders(
        '![image](img_1) <file key="f1" name="x.pdf"/> ![image](img_2) <video key="v1" duration="3s"/> <audio key="a1"/> <sticker key="s1"/> <file key="f2"/>',
      ),
    ).toBe('[图 1] [文件 1] [图 2] [视频 1] [语音 1] [表情 1] [文件 2]');
  });

  it('handles the bare [image] form used inside cards', () => {
    expect(mediaPlaceholders('卡片 [image] 说明')).toBe('卡片 [图 1] 说明');
  });

  it('leaves ordinary links and text alone', () => {
    const text = '见 [文档](https://example.com) 和 <b>粗体</b>';
    expect(mediaPlaceholders(text)).toBe(text);
  });
});
