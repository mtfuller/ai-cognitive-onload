// Compare an eval run with the committed baseline, case by case, and fail on
// a regression the pass/fail threshold alone would miss: a case whose score
// or whose with-minus-without delta dropped by more than the tolerance.
//
//   node scripts/eval-compare.mjs <aggregate-result.json> [--update] [--tolerance 0.2]
//
// --update writes the run's scores into plugins/sysedit/evals/baseline.json.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = join(root, 'plugins', 'sysedit', 'evals', 'baseline.json')
const [file] = process.argv.slice(2).filter(a => !a.startsWith('--'))
const update = process.argv.includes('--update')
const tolIndex = process.argv.indexOf('--tolerance')
const tolerance = tolIndex > 0 ? Number(process.argv[tolIndex + 1]) : 0.2

if (!file) {
  console.error('usage: node scripts/eval-compare.mjs <aggregate-result.json> [--update] [--tolerance 0.2]')
  process.exit(2)
}

const run = JSON.parse(readFileSync(file, 'utf8'))
if (run.partial) {
  console.error(`Partial run (${run.partialReason}); not comparing.`)
  process.exit(update ? 1 : 0)
}

const current = Object.fromEntries(
  (run.cases ?? []).map(c => [c.name, { score: round(c.aggregates?.score), delta: round(c.aggregates?.delta) }]),
)

function round(x) {
  return typeof x === 'number' ? Math.round(x * 1000) / 1000 : null
}

const pad = (s, n) => String(s).padEnd(n)
const fmt = x => (x === null || x === undefined ? '  —  ' : (x >= 0 ? ' ' : '') + x.toFixed(2))

if (update) {
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : { cases: {} }
  baseline.updatedAt = new Date().toISOString()
  baseline.claudeVersion = run.claudeVersion
  baseline.cases = { ...baseline.cases, ...current }
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n')
  console.log(`Updated ${baselinePath} with ${Object.keys(current).length} case(s).`)
  process.exit(0)
}

if (!existsSync(baselinePath)) {
  console.log('No baseline yet; run with --update to record one.')
  process.exit(0)
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')).cases ?? {}
let regressions = 0
console.log(`${pad('CASE', 36)} ${pad('SCORE', 14)} ${pad('DELTA', 14)}`)
for (const [name, now] of Object.entries(current)) {
  const was = baseline[name]
  const flags = []
  if (was?.score != null && now.score != null && now.score < was.score - tolerance) flags.push('score regressed')
  if (was?.delta != null && now.delta != null && now.delta < was.delta - tolerance) flags.push('plugin effect regressed')
  if (flags.length) regressions += 1
  console.log(`${pad(name, 36)} ${fmt(was?.score)} → ${fmt(now.score)}  ${fmt(was?.delta)} → ${fmt(now.delta)}  ${flags.join(', ')}`)
}
if (regressions) {
  console.error(`\n${regressions} case(s) regressed by more than ${tolerance} against the baseline.`)
  process.exit(1)
}
console.log('\nNo regressions against the baseline.')
