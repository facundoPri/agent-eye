import { spawn } from 'node:child_process';
import { existsSync, accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

const EXTRA_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/opt/local/bin'];

export function findBin(name) {
  const dirs = [...(process.env.PATH || '').split(delimiter), ...EXTRA_PATHS];
  for (const dir of dirs) {
    const p = join(dir, name);
    try {
      if (existsSync(p)) { accessSync(p, constants.X_OK); return p; }
    } catch { /* not executable, keep looking */ }
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
