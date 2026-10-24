import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse } from 'yaml';
import * as overlay from '../kaz/index.js';

const prompt = readFileSync(new URL('../kaz/prompt.md', import.meta.url), 'utf8');
const skillUrl = new URL('../kaz/skills/write-like-a-person/SKILL.md', import.meta.url);
const skillSource = readFileSync(skillUrl, 'utf8');

// A deliberately small model of the inspected registries. Presets share these
// global maps; disposing a preset never disposes its Host overlay.
function host() {
  const sections = new Map();
  const skills = new Map();
  const calls = [];
  const orders = { DEPLOYMENT_PERSONA_PREFIX: 120, PLAN_POLICY: 200 };
  const register = (map, entry) => {
    assert.ok(!map.has(entry.name), `duplicate registration: ${entry.name}`);
    map.set(entry.name, entry);
    let active = true;
    return () => {
      if (active) map.delete(entry.name);
      active = false;
    };
  };
  const services = {
    systemPrompt: {
      getSectionOrder(key) {
        calls.push(key);
        assert.ok(Object.hasOwn(orders, key));
        return orders[key];
      },
      section: (entry) => register(sections, entry),
    },
    skills: { register: (entry) => register(skills, entry) },
  };
  return {
    sections, skills, calls, services,
    mount() {
      const disposers = [];
      const dispose = () => {
        for (const cleanup of disposers.splice(0).reverse()) cleanup();
      };
      const ctx = { ...services, effect(create) {
        const cleanup = create();
        assert.equal(typeof cleanup, 'function');
        disposers.push(cleanup);
        return cleanup;
      } };
      try { overlay.apply(ctx); } catch (error) { dispose(); throw error; }
      return dispose;
    },
    assemble(scoped = []) {
      const effective = new Map(sections);
      for (const entry of scoped) effective.set(entry.name, entry);
      const result = [...effective.values()].sort((a, b) => a.order - b.order);
      const complete = result.find((entry) => entry.complete);
      return complete ? [complete] : result;
    },
  };
}

test('prompt preserves the extracted Kaz preferences without a model persona', () => {
  // Snapshot includes the HTML-first workflow and narrowed writing-skill trigger.
  // Normalize platform line endings before hashing.
  assert.equal(createHash('sha256').update(prompt.replaceAll('\r\n', '\n')).digest('hex'),
    'ee30beea5ca314995803ec6b2f17e078967232d055ad95b2f0be17f4e9454f91');
  assert.ok(prompt.startsWith('Be direct: match the length'));
  assert.doesNotMatch(prompt, /You are a coding agent|\{\{model\}\}/u);
});

test('visual work requires rendered HTML with explicit scope and preview boundaries', () => {
  for (const fragment of [
    'Trigger this workflow by the requested result',
    'create, plan, propose, compare, or change a human-visible screen or visual asset',
    'MUST express the proposed result in a directly renderable HTML artifact',
    'stop at the HTML proposal and do not implement the production app',
    'Do not finish with only a prose design',
    'not a document describing that interface',
    'A fenced HTML code block alone is not a rendered preview',
    'state that rendering was not verified',
    "not permission to replace the project's implementation stack",
    'behavior-only fixes with no proposed visual change',
    'An explicit user request for text only, another format, or no prototype takes precedence',
  ]) assert.ok(prompt.includes(fragment), `missing visual rule: ${fragment}`);
});

test('writing skill is scoped to prose deliverables in both prompt and catalog', () => {
  const { description } = parse(/^---\r?\n([\s\S]*?)\r?\n---/u.exec(skillSource)[1]);
  for (const text of [prompt, description]) {
    assert.match(text, /requested deliverable is a prose composition or substantive prose revision/u);
    assert.match(text, /user explicitly asks to apply/u);
    assert.match(text, /Do not load (?:it )?solely for ordinary chat replies, code investigation, implementation, debugging, concise technical explanations, working plans, progress updates, or completion summaries\./u);
    assert.match(text, /when the writing phase begins, not at task startup/u);
    assert.doesNotMatch(text, /any text meant to be read or heard|including chat replies|loaded many turns ago/u);
  }
  assert.match(prompt, /reload only when needed instructions are no longer available/u);
  assert.match(description, /reuse loaded instructions while available in context/u);
});

test('Host overlay preserves native persona and follows central placement', () => {
  assert.equal(overlay.name, 'kaz');
  assert.deepEqual(overlay.inject, ['systemPrompt', 'skills']);
  const runtime = host();
  const dispose = runtime.mount();
  const section = runtime.sections.get('kaz:preferences');
  assert.deepEqual(runtime.calls, ['DEPLOYMENT_PERSONA_PREFIX', 'PLAN_POLICY']);
  assert.equal(section.order, 160);
  assert.equal(section.text, prompt);
  assert.equal(section.interpolate, false);
  assert.equal(section.complete, undefined);
  for (const mode of ['standard', 'ptc', 'custom']) {
    const persona = { name: 'persona', order: 120, text: `Native ${mode} {{model}}` };
    const plan = { name: 'plan', order: 200, text: 'Native plan policy' };
    assert.deepEqual(runtime.assemble([persona, plan]), [persona, section, plan]);
    assert.equal(runtime.sections.size, 1);
  }
  dispose();
});

test('runtime skill exposes full actual body, frontmatter, and package-local resources', () => {
  const runtime = host();
  const dispose = runtime.mount();
  const skill = runtime.skills.get('write-like-a-person');
  const [, frontmatter, body] = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(skillSource);
  const metadata = parse(frontmatter);
  assert.deepEqual(skill.metadata, metadata);
  assert.equal(skill.name, metadata.name);
  assert.equal(skill.description, metadata.description);
  assert.equal(skill.source, 'runtime');
  assert.equal(skill.content, body);
  assert.match(skill.content, /## The pass before you send/u);
  assert.ok(skill.content.includes('The examples are specimens, not the boundary.'));
  assert.equal(skill.path, fileURLToPath(skillUrl));
  assert.deepEqual(skill.resourceBase, {
    kind: 'directory', path: fileURLToPath(new URL('./', skillUrl)),
  });
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true });
  dispose();
});

test('enable/disable/re-enable produces no duplicates or leaked registrations', () => {
  const runtime = host();
  const nativeDispose = runtime.services.systemPrompt.section({ name: 'native', order: 120, text: 'Native' });
  for (let i = 0; i < 3; i++) {
    const dispose = runtime.mount();
    assert.equal(runtime.sections.size, 2);
    assert.equal(runtime.skills.size, 1);
    assert.throws(() => runtime.mount(), /duplicate registration: kaz:preferences/u);
    assert.equal(runtime.sections.size, 2);
    assert.equal(runtime.skills.size, 1);
    dispose();
    dispose();
    assert.deepEqual([...runtime.sections.keys()], ['native']);
    assert.equal(runtime.skills.size, 0);
  }
  nativeDispose();
  assert.equal(runtime.sections.size, 0);
});

test('failed activation rolls back the prompt registration', () => {
  const runtime = host();
  runtime.services.skills.register = () => { throw new Error('skill unavailable'); };
  assert.throws(() => runtime.mount(), /skill unavailable/u);
  assert.equal(runtime.sections.size, 0);
  assert.equal(runtime.skills.size, 0);
});

test('complete prompt naturally overrides overlay without assembly interception', () => {
  const runtime = host();
  const dispose = runtime.mount();
  const complete = { name: 'custom', order: 0, complete: true, text: 'Complete custom prompt' };
  assert.deepEqual(runtime.assemble([complete]), [complete]);
  assert.equal(runtime.sections.size, 1);
  assert.equal(runtime.skills.size, 1);
  assert.equal(runtime.assemble().length, 1);
  dispose();
});
