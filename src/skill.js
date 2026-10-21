import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'agent-eye', 'SKILL.md');

/**
 * Where the skill goes in a project: `.claude/skills` (Claude Code) always, plus
 * `.agents/skills` when the project already keeps skills there (Codex and others).
 */
export function skillTargets(projectRoot) {
  const dirs = ['.claude/skills'];
  if (existsSync(join(projectRoot, '.agents', 'skills'))) dirs.push('.agents/skills');
  return dirs.map((d) => join(projectRoot, d, 'agent-eye', 'SKILL.md'));
}

/** Per target: missing, current (same text as the bundled skill) or outdated. */
export function skillStatus(projectRoot) {
  const bundled = readFileSync(SKILL_SOURCE, 'utf8');
  const targets = skillTargets(projectRoot).map((path) => {
    const state = !existsSync(path) ? 'missing' : readFileSync(path, 'utf8') === bundled ? 'current' : 'outdated';
    return { path, relative: relative(projectRoot, path), state };
  });
  return {
    projectRoot,
    installed: targets.some((t) => t.state !== 'missing'),
    upToDate: targets.every((t) => t.state === 'current'),
    targets,
  };
}

/** Write the bundled skill to every target that is missing or outdated. */
export function installSkill(projectRoot) {
  const bundled = readFileSync(SKILL_SOURCE, 'utf8');
  const written = [];
  for (const t of skillStatus(projectRoot).targets) {
    if (t.state === 'current') continue;
    mkdirSync(dirname(t.path), { recursive: true });
    writeFileSync(t.path, bundled);
    written.push(t.relative);
  }
  return { ...skillStatus(projectRoot), written };
}

/** The project a config belongs to: the folder holding `.agent-eye/`, or cwd for the global config. */
export function projectRootFor(configPath, globalPath) {
  return configPath && configPath !== globalPath ? dirname(dirname(configPath)) : process.cwd();
}
