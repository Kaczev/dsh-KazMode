import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../kaz/', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('bundle mounts one overlay, not copies of native presets', () => {
  assert.deepEqual(parse(readFileSync(join(root, 'cordis.patch.yml'), 'utf8')), [
    { insert: [{ id: 'kaz-overlay', name: 'dsh-kazmode' }] },
  ]);
  assert.equal(manifest.exports['./presets/standard'], undefined);
  assert.equal(manifest.exports['./presets/ptc'], undefined);
  assert.equal(manifest.files.includes('presets'), false);
  assert.equal(manifest.dependencies, undefined);
});

test('published resources include both runtime halves and localized inventory', () => {
  assert.deepEqual(manifest.dsh.bundle.patch, ['./cordis.patch.yml']);
  assert.deepEqual(manifest.dsh.client, { platform: 'web', immediately: true, inject: ['slots', 'locale'] });
  for (const file of ['index.js', 'client.js', 'prompt.md', 'skills', 'locale', 'icon.svg', 'cordis.patch.yml']) {
    assert.ok(manifest.files.includes(file), file);
    assert.ok(existsSync(join(root, file)), file);
  }
  assert.equal(manifest.exports['.'], './index.js');
  assert.equal(manifest.exports['./client'], './client.js');
  for (const locale of ['en', 'zh']) {
    const { meta } = JSON.parse(readFileSync(join(root, 'locale', `${locale}.json`), 'utf8'));
    assert.ok(meta.title.length > 0);
    assert.ok(meta.description.length > 20);
  }
  assert.match(readFileSync(join(root, 'icon.svg'), 'utf8'), /<svg[\s>]/u);
});

test('client indicator uses existing list slots and disposes its dictionaries and entries', () => {
  let definition;
  runInNewContext(readFileSync(join(root, 'client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
  });
  assert.equal(definition.id, manifest.name);
  const module = definition.factory((name) => {
    assert.equal(name, 'react');
    return { createElement: (type, props, ...children) => ({ type, props, children }) };
  });
  const declarations = new Map();
  const components = new Map();
  const dictionaries = new Map();
  const cleanups = [];
  module.apply({
    effect(create) { cleanups.push(create()); },
    locale: { register(ns, lang, dict) {
      assert.equal(ns, 'kaz-mode');
      dictionaries.set(lang, dict);
      return () => dictionaries.delete(lang);
    } },
    slots: {
      inject(name, callback) { declarations.set(name, callback); },
      register(options, render) {
        assert.equal(options.locale, 'kaz-mode');
        assert.equal(options.id, 'kaz-mode-indicator');
        assert.equal(options.order, options.name === 'conversation.hero.options' ? 0 : -9);
        components.set(options.name, render);
        return () => components.delete(options.name);
      },
    },
  });
  assert.deepEqual([...declarations.keys()], [
    'conversation.hero.options',
    'conversation.session.header.actions',
  ]);
  assert.equal(components.size, 0);
  const disposers = [...declarations.values()].map((declare) => declare());
  for (const [name, component] of components) {
    for (const lang of ['zh', 'en']) {
      const inner = component({ t: (key) => dictionaries.get(lang)[key] });
      const rendered = inner.type(inner.props);
      assert.equal(rendered.type, 'span');
      assert.equal(rendered.children[0], name === 'conversation.hero.options'
        ? (lang === 'zh' ? 'Kaz 已启用' : 'Kaz enabled') : '· Kaz');
      assert.equal(rendered.props.style.fontSize, '14px');
      assert.equal(rendered.props.style.fontWeight, 400);
      assert.equal(rendered.props.style.lineHeight, '20px');
      assert.equal(rendered.props.style.color, name === 'conversation.hero.options' ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)');
      assert.equal(rendered.props.style.opacity, undefined);
      assert.equal(rendered.props.style.paddingInlineEnd, name === 'conversation.hero.options' ? '12px' : undefined);
      assert.ok(rendered.props.title.length > 20);
    }
  }
  disposers.forEach((dispose) => dispose());
  cleanups.reverse().forEach((cleanup) => cleanup());
  assert.equal(components.size, 0);
  assert.equal(dictionaries.size, 0);
  assert.equal(JSON.parse(readFileSync(join(root, 'locale/zh.json'), 'utf8')).meta.title, 'Kaz 模式');
});
