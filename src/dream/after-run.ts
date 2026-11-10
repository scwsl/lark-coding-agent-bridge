import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Outcome of one `dreamTuning.afterAutoRun` command. */
export interface AfterRunResult {
  command: string;
  ok: boolean;
  /** Last non-empty output line (stdout, else stderr), or the error. */
  line: string;
}

const TIMEOUT_MS = 10 * 60_000;

/**
 * Run each command through a login shell, one after another. launchd starts
 * the bridge with a bare PATH, so `~/.local/bin` (where `claude` lives) is put
 * in front explicitly.
 */
export async function runAfterAutoCommands(commands: string[], env: NodeJS.ProcessEnv = process.env): Promise<AfterRunResult[]> {
  const path = [join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', env.PATH ?? '/usr/bin:/bin'].join(':');
  const results: AfterRunResult[] = [];
  for (const command of commands) {
    results.push(
      await new Promise<AfterRunResult>((resolve) => {
        execFile('/bin/sh', ['-c', command], { env: { ...env, PATH: path }, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          const tail = lastLine(String(stdout)) || lastLine(String(stderr));
          if (err) resolve({ command, ok: false, line: tail || err.message });
          else resolve({ command, ok: true, line: tail || '完成' });
        });
      }),
    );
  }
  return results;
}

export function formatAfterRun(results: AfterRunResult[], reason: string): string {
  const lines = results.map((r) => `- ${r.ok ? '✅' : '❌'} \`${r.command}\`：${r.line.slice(0, 300)}`);
  return [`**🔄 课堂精练收尾命令**（${reason}）`, '', ...lines].join('\n');
}

function lastLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  const lines = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}
