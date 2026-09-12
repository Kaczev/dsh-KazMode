/**
 * Build the two runtime artifacts of dsh-deepseek-balance:
 *
 *   lib/index.js  — the host half (plain ESM, copied from src/).
 *   lib/client.js — the browser half, wrapped in the DSH module-loader
 *                   handshake (`window.__ModuleLoader__.load({id, factory})`)
 *                   that `@deepseek-ai/dsh-client-modules` consumes.
 *
 * No bundler and no dependencies: the widget requires only React, which the
 * DSH web shell seeds into its platform module table.
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = join(scriptDir, '..')
const srcDir = join(root, 'src')
const libDir = join(root, 'lib')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

mkdirSync(libDir, { recursive: true })

copyFileSync(join(srcDir, 'index.js'), join(libDir, 'index.js'))

const clientSource = readFileSync(join(srcDir, 'client.js'), 'utf8')

// The source is written as an ES module for readers and tooling; the loader
// wants CommonJS factory form, so the two export statements become assignments.
const factoryBody = clientSource
  .replace(/^export \{ apply, inject, BalanceWidget \}\s*$/m, 'exports.apply = apply;\nexports.inject = inject;\nexports.BalanceWidget = BalanceWidget;')
  .replace(/^export const inject = \[[^\]]*\]\s*$/m, 'const inject = ["slots"];')

if (factoryBody.includes('export ')) {
  throw new Error('client source still contains an `export` statement — the factory rewrite missed it')
}

const bundle = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${factoryBody}
\t\treturn module.exports;
\t}
});
`
writeFileSync(join(libDir, 'client.js'), bundle)

const hostBytes = readFileSync(join(libDir, 'index.js')).length
console.log(`dsh-deepseek-balance: lib/index.js (${hostBytes} B) + lib/client.js (${bundle.length} B)`)
