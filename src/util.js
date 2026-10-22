import { spawn } from 'node:child_process';
import { existsSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';

const EXTRA_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/opt/local/bin'];

/** First executable called `name` on PATH (then the usual Homebrew/MacPorts places). Windows adds PATHEXT (ffmpeg.exe). */
export function findBin(name, { platform = process.platform, env = process.env } = {}) {
  const win = platform === 'win32';
  const dirs = [...(env.PATH ?? env.Path ?? '').split(win ? ';' : ':').filter(Boolean), ...(win ? [] : EXTRA_PATHS)];
  const names = win ? ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())].map((e) => name + e) : [name];
  for (const dir of dirs) {
    for (const n of names) {
      const p = join(dir, n);
      try {
        if (existsSync(p)) { accessSync(p, win ? constants.F_OK : constants.X_OK); return p; }
      } catch { /* not executable, keep looking */ }
    }
  }
  return null;
}

/** Run a command to completion. Never rejects: spawn errors come back as code -1. */
export function run(cmd, args, { timeoutMs = 20000, input } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', done = false;
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout, stderr }); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(-2); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { stderr += String(e); finish(-1); });
    child.on('close', (code) => finish(code ?? -1));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A timeout used only in a race: it must not keep the process alive once the race is decided. */
export const raceTimer = (ms) => new Promise((r) => setTimeout(r, ms).unref());

export class UserError extends Error {
  constructor(message, { code = 1, hint } = {}) {
    super(message);
    this.exitCode = code;
    this.hint = hint;
  }
}
