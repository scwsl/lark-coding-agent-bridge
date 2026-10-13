import { describe, expect, it } from 'vitest';
import { resolveLaunchdNodePath } from '../../../src/daemon/launchd';

const CELLAR_NODE = '/opt/homebrew/Cellar/node/26.11.0/bin/node';

function existing(...paths: string[]): (path: string) => boolean {
  return (path) => paths.includes(path);
}

describe('launchd node path', () => {
  // `brew upgrade` deletes the versioned Cellar binary; a plist pinned to it
  // leaves the bridge running from a deleted file, and TCC then denies its
  // children access to Desktop / Documents / Downloads.
  it('prefers the opt/node symlink over the versioned Cellar path', () => {
    const exists = existing('/opt/homebrew/opt/node/bin/node', '/opt/homebrew/bin/node', CELLAR_NODE);
    expect(resolveLaunchdNodePath(CELLAR_NODE, exists)).toBe('/opt/homebrew/opt/node/bin/node');
  });

  it('falls back to /opt/homebrew/bin/node when opt/node is missing', () => {
    const exists = existing('/opt/homebrew/bin/node', CELLAR_NODE);
    expect(resolveLaunchdNodePath(CELLAR_NODE, exists)).toBe('/opt/homebrew/bin/node');
  });

  it('keeps the running binary when no Homebrew node is installed', () => {
    const execPath = '/Users/me/.nvm/versions/node/v24.0.0/bin/node';
    expect(resolveLaunchdNodePath(execPath, existing(execPath))).toBe(execPath);
  });
});
