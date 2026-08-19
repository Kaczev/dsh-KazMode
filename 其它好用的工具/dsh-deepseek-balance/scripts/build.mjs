/**
 * Builds the two runtime artifacts:
 *   - lib/index.js  (ESM host half, copied from src)
 *   - lib/client.js (CJS bundle wrapped in the DSH ModuleLoader handshake)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const srcDir = join(root, '..', 'src')
const libDir = join(root, '..', 'lib')

mkdirSync(libDir, { recursive: true })

writeFileSync(join(libDir, 'index.js'), readFileSync(join(srcDir, 'index.js'), 'utf8'))

const clientSource = readFileSync(join(srcDir, 'client.js'), 'utf8')
const clientBundle =
  "window.__ModuleLoader__.load({ id: 'dsh-deepseek-balance', factory: (require) => {\n" +
  'var module = { exports: {} };\n' +
  'var exports = module.exports;\n' +
  clientSource +
  '\nreturn module.exports;\n' +
  '} });\n'
writeFileSync(join(libDir, 'client.js'), clientBundle)

console.log('dsh-deepseek-balance: wrote lib/index.js and lib/client.js')