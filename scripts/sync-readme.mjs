import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const source = new URL('../README.md', import.meta.url);
const destination = new URL('../kaz/README.md', import.meta.url);
const repository = 'https://github.com/Kaczev/dsh-KazMode';

// Keep the root README authoritative; npm cannot resolve repository-relative links.
export function npmReadme(markdown) {
  return markdown.replace(/\]\(\.\/([^\s)]+)\)/gu, (_, path) => {
    const kind = path.endsWith('/') ? 'tree' : 'blob';
    return `](${repository}/${kind}/main/${path})`;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const expected = npmReadme(readFileSync(source, 'utf8'));
  if (process.argv.includes('--verify')) {
    if (readFileSync(destination, 'utf8') !== expected) {
      console.error('FAIL kaz/README.md is out of sync; run node scripts/sync-readme.mjs');
      process.exitCode = 1;
    } else {
      console.log('OK npm README matches the root README with repository links');
    }
  } else {
    writeFileSync(destination, expected);
    console.log('Synced kaz/README.md from README.md');
  }
}
