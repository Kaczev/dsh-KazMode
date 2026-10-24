import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { npmReadme } from '../scripts/sync-readme.mjs';

test('npm README contains the complete root README with usable repository links', () => {
  const source = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const published = readFileSync(new URL('../kaz/README.md', import.meta.url), 'utf8');
  assert.equal(published, npmReadme(source));
  assert.doesNotMatch(published, /\]\(\.\//u);
});

test('README synchronization handles files and directories without changing external links or prose', () => {
  assert.equal(
    npmReadme('# Kaz\n[file](./kaz/prompt.md) [dir](./kaz/) [web](https://example.com)\n'),
    '# Kaz\n[file](https://github.com/Kaczev/dsh-KazMode/blob/main/kaz/prompt.md) [dir](https://github.com/Kaczev/dsh-KazMode/tree/main/kaz/) [web](https://example.com)\n',
  );
});
