/**
 * Credential shapes 课堂精练 refuses to put into a draft, and masks out of the
 * transcript excerpts it hands the agent. Deliberately broad: a false positive
 * costs one dropped proposal, a miss puts a secret into a Git history.
 */
const SECRET_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { label: 'api-key', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
  { label: 'aws-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'google-key', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/ },
  { label: 'lark-token', re: /\b(?:t|u)-[A-Za-z0-9_-]{30,}/ },
  { label: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/i },
  { label: 'connection-string', re: /\b(?:AccountKey|SharedAccessKey|Password|Pwd)\s*=\s*[^;\s]{6,}/i },
  { label: 'url-credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
  {
    label: 'assignment',
    re: /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|app[_-]?secret|client[_-]?secret)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}/i,
  },
];

/** The first credential shape found in `text`, or undefined. */
export function findSecret(text: string): string | undefined {
  for (const { label, re } of SECRET_PATTERNS) {
    if (re.test(text)) return label;
  }
  return undefined;
}

/** `text` with every credential shape replaced by `[REDACTED]`. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), '[REDACTED]');
  }
  return out;
}
