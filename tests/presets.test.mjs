import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = readFileSync(join(root, 'kaz/cordis.patch.yml'), 'utf8');
const parsePatch = (text) => parse(text, {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => ({ __jsExpr: value }) }],
});
const rows = parsePatch(source)[0].insert;
const [standard, ptc] = rows.map((row) => row.config);
const plugin = (preset, id) => preset.plugins.find((entry) => entry.id === id);

test('bundle declares the existing Kaz ID and a separate PTC ID', () => {
  assert.deepEqual(rows.map((row) => row.id), ['preset-kaz', 'preset-kaz-ptc']);
  assert.deepEqual(rows.map((row) => row.name), ['dsh-kazmode/presets/standard', 'dsh-kazmode/presets/ptc']);
  assert.deepEqual([standard.id, ptc.id], ['kaz', 'kaz-ptc']);
  assert.deepEqual([standard.order, ptc.order], [5, 6]);
});

test('persona and skill configuration each have exactly one source', () => {
  for (const id of ['persona', 'skill-filesystem']) {
    assert.strictEqual(plugin(standard, id).config, plugin(ptc, id).config);
  }
  assert.equal(source.split('Be direct: match the length').length - 1, 1);
  assert.equal(source.split("resolve('dsh-kazmode/package.json')").length - 1, 1);
  const changed = parsePatch(source.replace('Be direct:', 'Shared edit:'))[0].insert;
  for (const row of changed) {
    assert.match(plugin(row.config, 'persona').config.prefix, /Shared edit:/u);
  }
});

test('PTC differs only by its three native plugin changes', () => {
  const expected = structuredClone(standard.plugins);
  const delegation = expected.find((entry) => entry.id === 'delegation').config;
  for (const id of ['workflow-ptc', 'tool-workflow']) {
    delegation.find((entry) => entry.id === id).disabled = true;
  }
  expected.splice(expected.findIndex((entry) => entry.id === 'present'), 0, {
    id: 'tool-presentation', name: '@deepseek-ai/dsh-agent-tool-presentation', config: { mode: 'ptc' },
  });
  assert.deepEqual(ptc.plugins, expected);
});

test('shared skill expression resolves from an installed package, not the working directory', () => {
  const expression = plugin(standard, 'skill-filesystem').config.customSkillDirs[0].__jsExpr;
  const manifest = join(root, 'kaz/package.json');
  const builtin = (name) => name === 'node:module'
    ? { createRequire: () => ({ resolve: (specifier) => {
      assert.equal(specifier, 'dsh-kazmode/package.json');
      return manifest;
    } }) }
    : process.getBuiltinModule(name);
  const skills = Function('process', 'baseUrl', `return (${expression})`)(
    { getBuiltinModule: builtin }, pathToFileURL(join(root, 'unrelated-profile/')).href,
  );
  assert.equal(skills, join(dirname(manifest), 'skills'));
  assert.match(readFileSync(join(skills, 'write-like-a-person/SKILL.md'), 'utf8'), /name: write-like-a-person/u);
});

test('published manifest includes the patch and shared skill with no runtime dependencies', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'kaz/package.json'), 'utf8'));
  assert.deepEqual(manifest.dsh.bundle.patch, ['./cordis.patch.yml']);
  assert.ok(manifest.files.includes('cordis.patch.yml'));
  assert.ok(manifest.files.includes('skills'));
  assert.equal(manifest.dependencies, undefined);
});

test('mode cards export distinct localized names and shared icon', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'kaz/package.json'), 'utf8'));
  for (const [index, mode] of ['standard', 'ptc'].entries()) {
    const subpath = `./presets/${mode}`;
    assert.equal(manifest.exports[subpath], `./presets/${mode}.js`);
    for (const locale of ['zh', 'en']) {
      const target = manifest.exports[`${subpath}/locale/*.json`].replace('*', locale);
      const { meta } = JSON.parse(readFileSync(join(root, 'kaz', target), 'utf8'));
      assert.ok(meta.description.length > 20);
      if (locale === 'zh') assert.equal(meta.title, rows[index].config.name);
    }
    assert.equal(manifest.exports[`${subpath}/icon`], './icon.svg');
  }
  assert.equal(manifest.exports['./package.json'], './package.json');
  assert.ok(manifest.files.includes('presets'));
  assert.ok(manifest.files.includes('icon.svg'));
  assert.match(readFileSync(join(root, 'kaz/icon.svg'), 'utf8'), /<svg[\s>]/u);
});

test('display entrypoints defer child expressions and dispose native registry registrations', async () => {
  const modules = await Promise.all(['standard', 'ptc'].map((mode) => import(`../kaz/presets/${mode}.js`)));
  assert.notEqual(modules[0].default, modules[1].default);
  for (const [index, { default: entry }] of modules.entries()) {
    assert.deepEqual(entry.inject, ['agentPresets']);
    assert.equal(entry[Symbol.for('cordis.group')], true);
    const dispose = () => {};
    const ctx = { agentPresets: { register: async (config) => {
      assert.strictEqual(config, rows[index].config);
      return dispose;
    } } };
    assert.strictEqual(await entry(ctx, rows[index].config), dispose);
  }
});

// Optional exact upstream comparison for a source checkout or extracted installed bundle.
// Desktop app.asar cannot be read by ordinary Node; do not silently pretend it was checked.
const upstream = process.env.DSH_WEB_APP_DIR;
for (const [id, preset] of [['standard', standard], ['ptc', ptc]]) {
  test(`matches upstream ${id} apart from persona and skills`, { skip: !upstream }, () => {
    const native = parsePatch(readFileSync(join(upstream, `presets/${id}.patch.yml`), 'utf8'))[0].insert[0].config;
    const actual = structuredClone(preset.plugins);
    for (const entryId of ['persona', 'skill-filesystem']) {
      const original = plugin(native, entryId);
      const index = actual.findIndex((entry) => entry.id === entryId);
      actual[index] = original;
    }
    assert.deepEqual(actual, native.plugins);
  });
}
