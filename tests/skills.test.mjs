import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { apply } from '../kaz/index.js';

const names = ['automation-recovery', 'baseline-isolation', 'dsh-plugin-field-guide', 'windows-command-reliability', 'write-like-a-person'];
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
        if (skill.name === 'dsh-plugin-field-guide') throw new Error('registration failed');
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

test('state policy requires readback and does not grant unavailable capabilities', () => {
  const prompt = readFileSync(new URL('../kaz/prompt.md', import.meta.url), 'utf8');
  for (const fragment of ['treat effects as unknown', 'non-idempotent actions', 'Memory and summaries are historical pointers', 'does not grant unavailable tools']) assert.ok(prompt.includes(fragment));
  const section = prompt.split('## Reliable State and Tool Use')[1].split('## Execution and Verification')[0];
  assert.doesNotMatch(section, /Photoshop|Unity|ComfyUI|RootOfDecite|Kaczev/u);
});

test('packaged frontmatter follows the strict loader contract', () => {
  // Source contracts are deliberately narrow: unexpected frontmatter must never silently lose metadata.
  for (const entry of readdirSync(new URL('../kaz/skills/', import.meta.url), { withFileTypes: true }).filter((item) => item.isDirectory())) {
    const source = readFileSync(new URL(`../kaz/skills/${entry.name}/SKILL.md`, import.meta.url), 'utf8');
    assert.match(source, /^---\r?\nname: [a-z0-9-]+\r?\ndescription: [^\r\n]+\r?\n---\r?\n/u);
  }
});
