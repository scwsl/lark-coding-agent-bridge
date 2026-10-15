import { describe, expect, it } from 'vitest';
import { unwrapShellCommand } from '../../../src/agent/codex/app-server-run';

describe('unwrapShellCommand', () => {
  it('takes the script from the argv Codex proposes', () => {
    // Real codex-cli 0.159.2 approval request (item/commandExecution/requestApproval).
    expect(
      unwrapShellCommand(`/bin/zsh -lc "python3 -c 'print(42)' 2>&1 | head -1"`, [
        '/bin/zsh',
        '-lc',
        "python3 -c 'print(42)' 2>&1 | head -1",
      ]),
    ).toBe("python3 -c 'print(42)' 2>&1 | head -1");
  });

  it('undoes the quoting when there is no argv', () => {
    expect(unwrapShellCommand(`/bin/zsh -lc 'sed -n 1p /etc/hosts'`)).toBe('sed -n 1p /etc/hosts');
    expect(unwrapShellCommand(`/bin/bash -c 'echo '\\''hi'\\'''`)).toBe("echo 'hi'");
    expect(unwrapShellCommand(`/bin/zsh -lc "grep \\"a b\\" f"`)).toBe('grep "a b" f');
    expect(unwrapShellCommand(`zsh -lc "echo \\$HOME"`)).toBe('echo $HOME');
  });

  it('leaves anything else as it is', () => {
    expect(unwrapShellCommand('touch x.txt')).toBe('touch x.txt');
    expect(unwrapShellCommand(`/bin/zsh -lc 'a' 'b'`)).toBe(`/bin/zsh -lc 'a' 'b'`);
    expect(unwrapShellCommand(`/bin/zsh -lc "a" ; rm "b"`)).toBe(`/bin/zsh -lc "a" ; rm "b"`);
    expect(unwrapShellCommand('/usr/bin/python3 -c x', ['/usr/bin/python3', '-c', 'x'])).toBe('/usr/bin/python3 -c x');
  });
});
