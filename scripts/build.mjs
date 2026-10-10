// Bundle the Node entry point and the editor into plugins/sysedit/dist/.
// The bundles are committed so the plugin runs with nothing to install;
// `--check` rebuilds into a temporary directory and fails if dist/ is stale.

import { build } from 'esbuild'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')
const target = join(root, 'plugins', 'sysedit', 'dist')
const out = check ? mkdtempSync(join(tmpdir(), 'sysedit-dist-')) : target

if (!check) rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'editor'), { recursive: true })

await build({
  entryPoints: [join(root, 'src', 'cli', 'entry.ts')],
  outfile: join(out, 'sysedit.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node\n// Built by scripts/build.mjs from src/. Do not edit.' },
  legalComments: 'none',
  logLevel: 'warning',
})

await build({
  entryPoints: [join(root, 'src', 'editor', 'main.tsx')],
  outfile: join(out, 'editor', 'app.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
})
cpSync(join(root, 'src', 'editor', 'index.html'), join(out, 'editor', 'index.html'))
cpSync(join(root, 'src', 'editor', 'styles.css'), join(out, 'editor', 'app.css'))

if (check) {
  const list = dir =>
    readdirSync(dir, { recursive: true })
      .map(String)
      .filter(f => statSync(join(dir, f)).isFile())
      .sort()
  const a = list(out)
  const b = list(target).filter(f => !f.startsWith('.'))
  const stale = a.filter(f => !b.includes(f) || !readFileSync(join(out, f)).equals(readFileSync(join(target, f))))
  const extra = b.filter(f => !a.includes(f))
  rmSync(out, { recursive: true, force: true })
  if (stale.length || extra.length) {
    console.error(`plugins/sysedit/dist is out of date (${[...stale, ...extra].join(', ')}). Run npm run build and commit it.`)
    process.exit(1)
  }
  console.log('plugins/sysedit/dist is up to date.')
} else {
  console.log(`Built ${relative(root, out)}/sysedit.mjs and ${relative(root, out)}/editor/`)
}
