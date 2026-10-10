import { describe, expect, it } from 'vitest'

import { afterOnly, applyOps, newChangeSet, type ChangeSet, type ChangeStatus } from '../../plugins/sysedit/core/changeset.ts'
import { checkDrift, formatDrift } from '../../plugins/sysedit/core/drift.ts'
import { decide, relativeToRoot, stageOf, type GateInput } from '../../plugins/sysedit/core/gate.ts'
import { BOX, layout, route } from '../../plugins/sysedit/core/layout.ts'
import { toMermaid } from '../../plugins/sysedit/core/mermaid.ts'
import { computeMetrics } from '../../plugins/sysedit/core/metrics.ts'
import type { SystemModel } from '../../plugins/sysedit/core/model.ts'
import { guessRisk } from '../../plugins/sysedit/core/risk.ts'
import { FRAUD_OPS, fraudQuestions, goldenModel } from '../helpers/fixture.ts'

const NOW = '2026-10-09T12:00:00.000Z'

function change(status: ChangeStatus, extra: Partial<ChangeSet> = {}): ChangeSet {
  return { ...newChangeSet({ id: '0001-x', title: 'Fraud check', base: 'fixture', request: 'r', now: NOW }), ops: FRAUD_OPS, status, ...extra }
}

const input = (over: Partial<GateInput>): GateInput => ({
  tool: 'Edit',
  filePath: '/repo/src/checkout/service.ts',
  root: '/repo',
  mode: 'approved-only',
  change: null,
  model: goldenModel(),
  ...over,
})

describe('the gate', () => {
  it('ignores tools that do not write', () => {
    expect(decide(input({ tool: 'Read', change: change('draft') })).allow).toBe(true)
    expect(decide(input({ tool: 'Bash', change: change('draft') })).allow).toBe(true)
  })

  it('stays open when no change is in progress', () => {
    expect(decide(input({})).allow).toBe(true)
  })

  it.each(['draft', 'in-review'] as const)('holds writes to source while the change is %s', status => {
    const d = decide(input({ change: change(status) }))
    expect(d.allow).toBe(false)
  })

  it('names the open blocking questions in review', () => {
    const qs = fraudQuestions().map(q => ({ ...q, status: 'open' })) as ChangeSet['questions']
    const d = decide(input({ change: change('in-review', { questions: qs }) }))
    expect(!d.allow && d.reason).toMatch(/2 blocking questions to answer \(q2, q3\)/)
    expect(!d.allow && d.reason).toMatch(/Do not answer the questions yourself/)
  })

  it('never holds .sysedit/ or decision records', () => {
    expect(decide(input({ filePath: '/repo/.sysedit/model.json', change: change('draft') })).allow).toBe(true)
    expect(decide(input({ filePath: 'docs/adr/0042-fraud.md', change: change('draft') })).allow).toBe(true)
  })

  it('ignores files outside the project', () => {
    expect(decide(input({ filePath: '/tmp/scratch.txt', change: change('draft') })).allow).toBe(true)
    expect(decide(input({ filePath: '/repo/../etc/x', change: change('draft') })).allow).toBe(true)
  })

  it('opens once approved, skipped or verified', () => {
    for (const s of ['approved', 'implemented', 'skipped', 'verified'] as const) {
      expect(decide(input({ change: change(s) })).allow).toBe(true)
    }
  })

  it('in strict mode, holds approved writes to files that are not on the map', () => {
    expect(decide(input({ mode: 'strict', change: change('approved'), filePath: 'src/fraud/service.ts' })).allow).toBe(true)
    expect(decide(input({ mode: 'strict', change: change('approved'), filePath: 'src/fraud/service.test.ts' })).allow).toBe(true)
    const d = decide(input({ mode: 'strict', change: change('approved'), filePath: 'src/payments/stripe-adapter.ts' }))
    expect(!d.allow && d.reason).toMatch(/isn't on the approved map/)
    const planned = change('approved', { plan: [{ id: 't', title: 't', ops: [0], files: ['src/payments/stripe-adapter.ts'] }] })
    expect(decide(input({ mode: 'strict', change: planned, filePath: 'src/payments/stripe-adapter.ts' })).allow).toBe(true)
  })

  it('is off when told to be', () => {
    expect(decide(input({ mode: 'off', change: change('draft') })).allow).toBe(true)
  })

  it('resolves relative paths against the cwd', () => {
    expect(relativeToRoot('src/a.ts', '/repo', '/repo/sub')).toBe('sub/src/a.ts')
    expect(relativeToRoot('../a.ts', '/repo', '/repo/sub')).toBe('a.ts')
    expect(relativeToRoot('/elsewhere/a.ts', '/repo')).toBeNull()
    expect(relativeToRoot('/repository/a.ts', '/repo')).toBeNull()
  })

  it('maps a change to its stage', () => {
    expect(stageOf(null)).toBe('idle')
    expect(stageOf(change('draft'), false)).toBe('map')
    expect(stageOf(change('draft'))).toBe('edit')
    expect(stageOf(change('in-review'))).toBe('grill')
    expect(stageOf(change('approved'))).toBe('implement')
    expect(stageOf(change('implemented'))).toBe('verify')
    expect(stageOf(change('verified'))).toBe('done')
  })
})

describe('the drift check', () => {
  const base = goldenModel()

  it('finds no drift when the code matches the approved map', () => {
    const built = afterOnly(applyOps(base, FRAUD_OPS))
    const r = checkDrift(base, { ops: FRAUD_OPS }, built, NOW)
    expect(r.ok).toBe(true)
    expect(formatDrift(r)).toMatch(/No drift/)
  })

  it('reports drawn edges that were not built, removed edges still present, and edges nobody drew', () => {
    const built: SystemModel = afterOnly(applyOps(base, FRAUD_OPS))
    // The build forgot the hold branch, left the old direct capture in, and added a call nobody drew.
    built.edges = built.edges.filter(e => !(e.from === 'fraud.score' && e.to === 'orderHold.create'))
    built.edges.push({ from: 'checkout.placeOrder', to: 'payments.capture', kind: 'call', confidence: 'read', evidence: { file: 'src/checkout/service.ts', line: 51 } })
    built.edges.push({ from: 'fraud.score', to: 'stripe', kind: 'http', confidence: 'read', evidence: { file: 'src/fraud/service.ts', line: 3 } })
    built.nodes = built.nodes.filter(n => n.id !== 'orderHold.create')
    const r = checkDrift(base, { ops: FRAUD_OPS }, built, NOW)
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(['fraud.score->orderHold.create'])
    expect(r.stillPresent).toEqual(['checkout.placeOrder->payments.capture'])
    expect(r.unexpected).toEqual(['fraud.score->stripe'])
    expect(r.missingNodes).toEqual(['orderHold.create'])
    expect(formatDrift(r)).toMatch(/still present\s+checkout.placeOrder->payments.capture/)
  })

  it('does not blame the change for drift outside the nodes it touched', () => {
    const built = afterOnly(applyOps(base, FRAUD_OPS))
    built.edges.push({ from: 'cron.releaseExpiredHolds', to: 'stripe', kind: 'http', confidence: 'inferred', note: 'n' })
    expect(checkDrift(base, { ops: FRAUD_OPS }, built, NOW).ok).toBe(true)
  })
})

describe('mermaid', () => {
  it('draws inferred edges dashed and external systems as stadiums', () => {
    const out = toMermaid(goldenModel(), { flow: 'checkout' })
    expect(out).toMatch(/^flowchart TD/m)
    expect(out).toMatch(/bus_orderPlaced -\.-> email_sendReceipt/)
    expect(out).toMatch(/stripe\(\["Stripe API/)
  })

  it('colours what the engineer added and removed', () => {
    const out = toMermaid(applyOps(goldenModel(), FRAUD_OPS), { title: 'Fraud check' })
    expect(out).toMatch(/class fraud_score,orderHold_create added/)
    expect(out).toMatch(/stroke:#B42318/)
    expect(out).toMatch(/fraud_score -->\|"≥ 0.8"\| orderHold_create/)
  })
})

describe('layout', () => {
  it('puts callees below callers and nothing on top of anything else', () => {
    const m = goldenModel()
    const { placed } = layout(m.nodes.filter(n => n.kind === 'function' || n.kind === 'config' || n.kind === 'external' || n.kind === 'topic'), m.edges, 'gateway')
    expect(placed.get('gateway')!.row).toBe(0)
    for (const e of m.edges) {
      const a = placed.get(e.from)
      const b = placed.get(e.to)
      if (a && b) expect(b.row).toBeGreaterThan(a.row)
    }
    const spots = [...placed.values()].map(p => `${p.x},${p.y}`)
    expect(new Set(spots).size).toBe(spots.length)
  })

  it('survives cycles', () => {
    const { placed } = layout([{ id: 'a' }, { id: 'b' }], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }], 'a')
    expect(placed.size).toBe(2)
  })

  it('routes arrows from the bottom of the caller to the top of the callee', () => {
    const a = { id: 'a', x: 0, y: 0, row: 0, col: 0 }
    const b = { id: 'b', x: 0, y: 200, row: 1, col: 0 }
    expect(route(a, b)).toEqual({ x1: BOX.width / 2, y1: BOX.height, x2: BOX.width / 2, y2: 200 })
  })
})

describe('metrics and risk', () => {
  it('computes the grill hit rate, time to submit and skip rate', () => {
    const t = (min: number) => new Date(Date.parse(NOW) + min * 60000).toISOString()
    const a = change('verified', {
      createdAt: t(0),
      history: [
        { at: t(0), event: 'created' },
        { at: t(6), event: 'submitted' },
        { at: t(10), event: 'approved' },
        { at: t(30), event: 'drift' },
        { at: t(40), event: 'verified' },
      ],
      questions: [
        { ...(fraudQuestions()[0] as any), status: 'answered', answer: { at: t(8), optionId: 'closed', changedMap: true }, rating: 'useful' },
        { ...(fraudQuestions()[1] as any), status: 'answered', answer: { at: t(9), optionId: 'extend', changedMap: false }, rating: 'noise' },
      ],
    })
    const b = change('skipped')
    const m = computeMetrics([a, b], [{ at: t(1), reason: 'typo' }], [{ at: t(50), flow: 'checkout', score: 0.75, missed: [] }])
    expect(m.medianMinutesToSubmit).toBe(6)
    expect(m.medianMinutesInReview).toBe(4)
    expect(m.grillHitRate).toBe(0.5)
    expect(m.usefulRate).toBe(0.5)
    expect(m.driftCaughtRate).toBe(1)
    expect(m.skips).toBe(2)
    expect(m.skipRate).toBeCloseTo(2 / 3)
    expect(m.explainBackMean).toBe(0.75)
  })

  it('sizes ceremony to risk', () => {
    expect(guessRisk('Add a fraud check before we capture payment').risk).toBe('high')
    expect(guessRisk('Fix a typo in the README').risk).toBe('low')
    expect(guessRisk('Add a dark mode toggle to settings').risk).toBe('medium')
    expect(guessRisk('rename a variable', 7).risk).toBe('high')
  })
})
