import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { apply } from '../kaz/index.js';

const names = ['automation-recovery', 'windows-command-reliability', 'write-like-a-person'];
test('all packaged skills expose real bodies and dispose exactly once', () => {
  const registered = new Map();
  const disposers = [];
  apply({
    systemPrompt: { getSectionOrder: (key) => key === 'PLAN_POLICY' ? 200 : 120, section: () => () => {} },
    skills: { register(skill) {
      assert.ok(!registered.has(skill.name));
      registered.set(skill.name, skill);
      return () => registered.delete(skill.name);
    } },
    effect(make) { const dispose = make(); disposers.push(dispose); return dispose; },
  });
  assert.deepEqual([...registered.keys()], names);
  for (const [name, skill] of registered) {
    const text = readFileSync(new URL(`../kaz/skills/${name}/SKILL.md`, import.meta.url), 'utf8');
    assert.ok(text.endsWith(skill.content));
    assert.equal(skill.metadata.name, name);
    assert.ok(skill.description.length > 10);
    assert.equal(skill.invocation.modelInvocable, true);
    assert.ok(skill.resourceBase.path.includes(name));
    assert.ok(text.split('\n').length < 500);
  }
  for (const dispose of disposers.reverse()) dispose();
  assert.equal(registered.size, 0);
});

test('partial skill registration failure leaves no prompt or skill behind', () => {
  const cleanups = [];
  const active = new Set();
  try {
    assert.throws(() => apply({
      systemPrompt: { getSectionOrder: () => 100, section: () => { active.add('prompt'); return () => active.delete('prompt'); } },
      skills: { register(skill) {
        if (skill.name === 'windows-command-reliability') throw new Error('registration failed');
        active.add(skill.name);
        return () => active.delete(skill.name);
      } },
      effect(make) { const dispose = make(); cleanups.push(dispose); return dispose; },
    }), /registration failed/u);
  } finally {
    // Cordis owns effect rollback; model the same host responsibility on activation failure.
    for (const dispose of cleanups.reverse()) dispose();
  }
  assert.equal(active.size, 0);
});

test('state policy requires readback and treats summaries as unverified cues', () => {
  const prompt = readFileSync(new URL('../kaz/prompt.md', import.meta.url), 'utf8');
  for (const fragment of ['operation may have partially completed', 'non-idempotent operations', 'confirm the effect with minimal readback or status queries', 'Indexes and summaries are only potentially stale location cues']) assert.ok(prompt.includes(fragment), `missing state policy: ${fragment}`);
  const section = prompt.split('## Implementation and Verification')[1].split('## Project Navigation')[0];
  assert.doesNotMatch(section, /Photoshop|Unity|ComfyUI|RootOfDecite|Kaczev/u);
});

test('retired skills are absent from discovery and prompt references', () => {
  const directories = readdirSync(new URL('../kaz/skills/', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(directories, names);
  const prompt = readFileSync(new URL('../kaz/prompt.md', import.meta.url), 'utf8');
  assert.doesNotMatch(prompt, /baseline-isolation|dsh-plugin-field-guide/u);
});

test('operational skills retain their specialized recovery and Windows branches', () => {
  const recovery = readFileSync(new URL('../kaz/skills/automation-recovery/SKILL.md', import.meta.url), 'utf8');
  for (const fragment of ['Confirmed not sent', 'Explicit refusal without side effects', 'Sent, result unknown', 'Application blocked', 'original job']) assert.ok(recovery.includes(fragment));
  const windows = readFileSync(new URL('../kaz/skills/windows-command-reliability/SKILL.md', import.meta.url), 'utf8');
  for (const fragment of ['-LiteralPath', '$env:NAME', '$HOME', 'spaces and Chinese characters', 'cmd.exe', 'file lock', 'sandbox denial']) assert.ok(windows.includes(fragment));
});

test('packaged frontmatter follows the strict loader contract', () => {
  // Source contracts are deliberately narrow: unexpected frontmatter must never silently lose metadata.
  for (const entry of readdirSync(new URL('../kaz/skills/', import.meta.url), { withFileTypes: true }).filter((item) => item.isDirectory())) {
    const source = readFileSync(new URL(`../kaz/skills/${entry.name}/SKILL.md`, import.meta.url), 'utf8');
    assert.match(source, /^---\r?\nname: [a-z0-9-]+\r?\ndescription: [^\r\n]+\r?\n---\r?\n/u);
  }
});
