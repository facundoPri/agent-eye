import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_SOURCE, installSkill, projectRootFor, skillStatus } from '../src/skill.js';

const project = () => mkdtempSync(join(tmpdir(), 'ae-skill-'));

test('bundled skill has frontmatter with name and description', () => {
  const text = readFileSync(SKILL_SOURCE, 'utf8');
  assert.match(text, /^---\nname: agent-eye\ndescription: .+\n---\n/);
});

test('missing, then installed, then outdated after a local edit', () => {
  const root = project();
  assert.equal(skillStatus(root).installed, false);
  const r = installSkill(root);
  assert.deepEqual(r.written, ['.claude/skills/agent-eye/SKILL.md']);
  assert.equal(r.upToDate, true);
  writeFileSync(join(root, '.claude/skills/agent-eye/SKILL.md'), 'edited');
  const st = skillStatus(root);
  assert.equal(st.installed, true);
  assert.equal(st.upToDate, false);
  assert.equal(st.targets[0].state, 'outdated');
});

test('also targets .agents/skills when the project already uses it', () => {
  const root = project();
  mkdirSync(join(root, '.agents', 'skills'), { recursive: true });
  const r = installSkill(root);
  assert.deepEqual(r.written.sort(), ['.agents/skills/agent-eye/SKILL.md', '.claude/skills/agent-eye/SKILL.md']);
  assert.deepEqual(installSkill(root).written, []);
});

test('project root is the folder holding .agent-eye, or cwd for the global config', () => {
  assert.equal(projectRootFor('/p/.agent-eye/config.json', '/home/.config/agent-eye/config.json'), '/p');
  assert.equal(projectRootFor('/home/.config/agent-eye/config.json', '/home/.config/agent-eye/config.json'), process.cwd());
  assert.equal(projectRootFor(null, '/g'), process.cwd());
});
