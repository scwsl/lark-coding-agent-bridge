/**
 * The SDK flattens rich messages into text the agent can read: an image
 * becomes `![image](img_v3_…)` (or a bare `[image]`), a file becomes
 * `<file key="…" name="…"/>`, and so on. That is fine in a prompt, but when
 * the same text is echoed back to people — the card's "收到补充" marker, the
 * task preview — it shows up as raw markdown and resource keys.
 *
 * `mediaPlaceholders` swaps each of those for a short numbered label
 * (`[图 1]`, `[图 2]`, `[文件 1]` …), numbered per kind in reading order.
 * Display only: never feed the result back to the agent, which needs the keys.
 */

const MEDIA_RE =
  /!\[[^\]\n]*\]\([^)\s]*\)|\[image\]|<(file|audio|video|sticker)\b[^>]*?\/?>/g;

const LABELS: Record<string, string> = {
  image: '图',
  file: '文件',
  audio: '语音',
  video: '视频',
  sticker: '表情',
};

export function mediaPlaceholders(text: string): string {
  const counts = new Map<string, number>();
  return text.replace(MEDIA_RE, (_match, tag: string | undefined) => {
    const kind = tag ?? 'image';
    const n = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, n);
    return `[${LABELS[kind]} ${n}]`;
  });
}
