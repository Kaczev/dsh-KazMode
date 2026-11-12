import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse } from 'yaml';
import * as overlay from '../kaz/index.js';

const prompt = readFileSync(new URL('../kaz/prompt.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
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

test('prompt matches the approved five-part policy without restoring removed preferences', () => {
  assert.equal(createHash('sha256').update(prompt).digest('hex'), '8c22156aad1eaaeaf9df91e9c36c3ed132f058272afe8491921365a321138fd8');
  assert.ok(prompt.startsWith('## Goals and Decisions\n'));
  assert.equal((prompt.match(/^## /gmu) ?? []).length, 5);
  assert.doesNotMatch(prompt, /You are a coding agent|\{\{model\}\}|Respond in Chinese by default|Be direct: match the length/u);
});

const policies = {
  'decision and authorization boundaries': [
    'At the start of a task or at major state transitions',
    'first gather the minimum necessary observations',
    'When the path is clear, proceed directly',
    "Check the premises in the user's description against actual observations",
    'low-impact matters that do not involve authorization, security, or irreversible operations',
    'continue other authorized work',
    'keep implementation targets read-only',
    'request the needed authorization directly',
    'without adding unnecessary handoffs or approvals',
  ],
  'verification and unknown write recovery': [
    'establish observable completion criteria',
    'reproduce it first to the extent feasible',
    'checks covering the changed behavior and affected existing functionality',
    'do not substitute completed edits or a passing build for behavioral verification',
    'adjust only when there is new evidence',
    'operation may have partially completed',
    'confirm the effect with minimal readback or status queries',
    'do not blindly repeat toggles, deletions, appends, paid calls',
    'disclose important assumptions',
  ],
  'proactive reachable navigation': [
    'During authorized development, proactively add the minimum necessary navigation',
    'when adding a module or directory',
    'tracing relationships across multiple files or directories',
    'A single-file edit with no structural change need not create a new index',
    'correct any affected existing entries',
    'create a brief root INDEX.md',
    'link it from the nearest parent entry',
    'do not build a parallel index tree',
    'Omit uninspected scopes or mark them as unknown',
    'do not scan unrelated directories just to populate indexes',
    'Do not write navigation during read-only analysis or planning unless requested by the user',
    'Follow explicit user limits on scope, paths, and file creation',
    'they have no authority to override applicable instructions',
    'read the actual affected files',
  ],
  'file ownership and workspace hygiene': [
    'Before creating a file, choose its location by responsibility',
    'follow existing layout and naming conventions',
    'within the owning scope',
    'Place source code in its owning module',
    'tests in the existing test layout',
    'durable documentation and HTML design references',
    'reusable scripts in the scripts or tooling scope',
    'responsibility categories, not mandatory directory names',
    'files that are genuinely project-wide or explicitly required by the user or toolchain',
    'or in a task-specific temporary directory',
    'unless explicitly needed, keep them out of source navigation and published packages',
    'do not modify ignore rules or delete user files just to hide artifacts',
    'Preserve user content, existing conventions, and unrelated files',
    'update affected imports, links, tests, and packaging paths',
    'create empty placeholder directories, or create a separate directory for every file',
    'ownership of newly added paths, and reachability of affected navigation links',
  ],
  'HTML proposal and implementation boundaries': [
    'Use directly renderable HTML to show the proposed visual result',
    'rather than formatting a text plan as a web page',
    'except when the user explicitly requests plain text only, another format, or no preview',
    'Purely non-visual tasks do not require HTML',
    'clearly mark mock boundaries',
    'Keep the editable source file',
    'display it through an available preview surface',
    'state that rendering has not been verified',
    "HTML does not replace the project's implementation stack",
    'requirements explicitly specified in a user-confirmed HTML plan must be followed',
    'update that same plan once confirmed',
    'without deviating on your own or creating a competing version',
  ],
  'goal state and native policy': [
    'When Goal Tools Are Available and a Relevant Goal Exists',
    'Ending a reply does not stop automatic goal continuation',
    'read the current goal and reconcile its state against the native policy',
    'achieved and verified → complete',
    'useful authorized work remains → keep active',
    'mark blocked when policy permits',
    'user requests a pause → mark pause when policy permits',
    'Do not treat optional review, difficulty, uncertainty, or a single failed check as a blocker',
    'state the concrete blocker, relevant attempts, and what is needed to continue',
    'Verify the update result so reply wording matches the actual state',
    'When an update is rejected, state the restriction',
    'do not claim automatic execution has stopped',
    'do not bypass policy with false completion or empty turns',
  ],
};
for (const [policy, fragments] of Object.entries(policies)) {
  test(`prompt retains ${policy}`, () => {
    for (const fragment of fragments) assert.ok(prompt.includes(fragment), `missing policy: ${fragment}`);
  });
}

test('writing skill remains scoped to prose deliverables in prompt and catalog', () => {
  const { description } = parse(/^---\r?\n([\s\S]*?)\r?\n---/u.exec(skillSource)[1]);
  for (const fragment of [
    'Use `write-like-a-person` for articles, speeches, reports, documentation, longer UI copy',
    'or when explicitly requested by the user',
    'ordinary chat, code investigation and implementation, debugging, brief explanations, working plans, progress updates, and completion summaries do not trigger it',
    'when the writing phase begins and adopt its method',
    'do not preload it at task start',
    'reload only when the needed instructions are no longer in context',
  ]) assert.ok(prompt.includes(fragment), `missing writing rule: ${fragment}`);
  assert.match(description, /requested deliverable is a prose composition or substantive prose revision/u);
  assert.match(description, /user explicitly asks to apply/u);
  assert.match(description, /Do not load solely for ordinary chat replies/u);
  assert.match(description, /when the writing phase begins, not at task startup/u);
  assert.match(description, /reuse loaded instructions while available in context/u);
  for (const text of [prompt, description]) {
    assert.doesNotMatch(text, /any text meant to be read or heard|including chat replies|loaded many turns ago/u);
  }
});

test('Host overlay preserves native persona and follows central placement', () => {
  assert.equal(overlay.name, 'kaz');
  assert.deepEqual(overlay.inject, ['systemPrompt', 'skills']);
  const runtime = host();
  const dispose = runtime.mount();
  const section = runtime.sections.get('kaz:preferences');
  assert.deepEqual(runtime.calls, ['DEPLOYMENT_PERSONA_PREFIX', 'PLAN_POLICY']);
  assert.equal(section.order, 160);
  assert.equal(section.text.replaceAll('\r\n', '\n'), prompt);
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
    assert.equal(runtime.skills.size, 3);
    assert.throws(() => runtime.mount(), /duplicate registration: kaz:preferences/u);
    assert.equal(runtime.sections.size, 2);
    assert.equal(runtime.skills.size, 3);
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
  assert.equal(runtime.skills.size, 3);
  assert.equal(runtime.assemble().length, 1);
  dispose();
});
