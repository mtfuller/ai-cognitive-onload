// The drift check: re-map the code after it is built and compare it with the
// map the engineer approved. Drift is reported, never silently accepted.

import { afterOnly, applyOps, touchedNodes, type ChangeSet, type DriftReport } from './changeset.ts'
import type { SystemModel } from './model.ts'

const pair = (e: { from: string; to: string }) => `${e.from}->${e.to}`

/**
 * Compare `actual`, a model re-mapped from the built code, with the model the
 * change set describes. Only nodes the change touched are in scope, so drift
 * elsewhere in the system isn't blamed on this change.
 */
export function checkDrift(
  base: SystemModel,
  cs: Pick<ChangeSet, 'ops'>,
  actual: SystemModel,
  now: string,
): DriftReport {
  const approved = afterOnly(applyOps(base, cs.ops))
  const scope = new Set(touchedNodes(cs))
  const inScope = (e: { from: string; to: string }) => scope.has(e.from) || scope.has(e.to)

  const approvedPairs = new Set(approved.edges.map(pair))
  const actualPairs = new Set(actual.edges.map(pair))
  const actualNodes = new Set(actual.nodes.map(n => n.id))

  const missing = approved.edges.filter(e => inScope(e) && !actualPairs.has(pair(e))).map(pair)
  const unexpected = actual.edges.filter(e => inScope(e) && !approvedPairs.has(pair(e))).map(pair)

  const stillPresent: string[] = []
  for (const op of cs.ops) {
    if (op.op === 'removeEdge' && actualPairs.has(`${op.from}->${op.to}`) && !approvedPairs.has(`${op.from}->${op.to}`)) {
      stillPresent.push(`${op.from}->${op.to}`)
    }
    if (op.op === 'rerouteEdge') {
      const old = `${op.from}->${op.to}`
      if (actualPairs.has(old) && !approvedPairs.has(old)) stillPresent.push(old)
    }
  }
  const missingNodes = cs.ops.flatMap(op => (op.op === 'addNode' && !actualNodes.has(op.id) ? [op.id] : []))

  const dedupe = (xs: string[]) => [...new Set(xs)]
  const report: DriftReport = {
    ok: false,
    checkedAt: now,
    commit: actual.commit,
    missing: dedupe(missing.filter(m => !stillPresent.includes(m))),
    unexpected: dedupe(unexpected.filter(u => !stillPresent.includes(u))),
    stillPresent: dedupe(stillPresent),
    missingNodes: dedupe(missingNodes),
  }
  report.ok =
    report.missing.length === 0 &&
    report.unexpected.length === 0 &&
    report.stillPresent.length === 0 &&
    report.missingNodes.length === 0
  return report
}

export function formatDrift(report: DriftReport): string {
  if (report.ok) return 'No drift: the code matches the approved map.'
  const lines = ['Drift between the approved map and the code:']
  for (const e of report.missingNodes) lines.push(`  missing node      ${e}  (drawn, not built)`)
  for (const e of report.missing) lines.push(`  missing edge      ${e}  (drawn, not in the code)`)
  for (const e of report.stillPresent) lines.push(`  still present     ${e}  (removed on the map, still in the code)`)
  for (const e of report.unexpected) lines.push(`  unexpected edge   ${e}  (in the code, not drawn)`)
  return lines.join('\n')
}
