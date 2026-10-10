import { describe, expect, it } from 'vitest'

import {
  addQuestions,
  addTranscribedOps,
  afterOnly,
  answerQuestion,
  applyOps,
  approvalBlockers,
  approve,
  checkPlan,
  describeOp,
  dismissQuestion,
  newChangeSet,
  openBlocking,
  recordDrift,
  savePlan,
  setIntent,
  setOps,
  skip,
  slugify,
  submit,
  touchedFiles,
  touchedNodes,
  type ChangeSet,
  type Result,
} from '../../plugins/sysedit/core/changeset.ts'
import { edgeId } from '../../plugins/sysedit/core/model.ts'
import { FRAUD_INTENT, FRAUD_OPS, fraudQuestions, goldenModel } from '../helpers/fixture.ts'

const NOW = '2026-10-09T12:00:00.000Z'
const ok = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`)
  return r.value
}
const fresh = () => newChangeSet({ id: '0001-fraud', title: 'Fraud check', base: 'fixture', request: 'Add a fraud check', flow: 'checkout', now: NOW })

function inReview(): ChangeSet {
  let cs = ok(setOps(fresh(), FRAUD_OPS, NOW, 'engineer'))
  cs = ok(setIntent(cs, FRAUD_INTENT, NOW))
  return ok(submit(cs, NOW))
}

describe('applyOps', () => {
  const model = goldenModel()

  it('draws the mockup change: new boxes and branches added, the direct capture removed', () => {
    const p = applyOps(model, FRAUD_OPS)
    expect(p.conflicts).toEqual([])
    const mark = (id: string) => p.nodes.find(n => n.id === id)?.mark
    expect(mark('fraud.score')).toBe('added')
    expect(mark('orderHold.create')).toBe('added')
    const edge = (from: string, to: string) => p.edges.find(e => e.from === from && e.to === to)
    expect(edge('checkout.placeOrder', 'payments.capture')?.mark).toBe('removed')
    expect(edge('fraud.score', 'orderHold.create')).toMatchObject({ mark: 'added', kind: 'branch', when: '≥ 0.8' })
    expect(edge('fraud.score', 'payments.capture')).toMatchObject({ mark: 'added', when: '< 0.8' })
  })

  it('leaves the result without removed parts in afterOnly', () => {
    const after = afterOnly(applyOps(model, FRAUD_OPS))
    const pairs = after.edges.map(edgeId)
    expect(pairs).not.toContain('checkout.placeOrder->payments.capture')
    expect(pairs).toContain('checkout.placeOrder->fraud.score')
    expect(after.nodes.every(n => !('mark' in n))).toBe(true)
  })

  it('removing a node removes its edges', () => {
    const p = applyOps(model, [{ op: 'removeNode', id: 'inventory.reserve' }])
    expect(p.edges.find(e => e.to === 'inventory.reserve')?.mark).toBe('removed')
  })

  it('reroutes an edge to a new target, keeping a trace of where it came from', () => {
    const p = applyOps(model, [{ op: 'rerouteEdge', from: 'checkout.placeOrder', to: 'payments.capture', newTo: 'inventory.release' }])
    expect(p.edges.find(e => e.from === 'checkout.placeOrder' && e.to === 'inventory.release')).toMatchObject({ mark: 'added', was: 'checkout.placeOrder->payments.capture' })
    expect(p.edges.find(e => e.from === 'checkout.placeOrder' && e.to === 'payments.capture')?.mark).toBe('removed')
  })

  it('records operations that cannot apply as conflicts instead of throwing', () => {
    const p = applyOps(model, [
      { op: 'removeEdge', from: 'stripe', to: 'gateway' },
      { op: 'addEdge', from: 'nope', to: 'gateway' },
      { op: 'addEdge', from: 'gateway', to: 'orders.create' },
      { op: 'addNode', id: 'gateway', kind: 'service' },
    ])
    expect(p.conflicts.map(c => c.index)).toEqual([0, 1, 2, 3])
  })

  it('keeps annotations for what boxes cannot express', () => {
    const p = applyOps(model, [{ op: 'annotate', target: 'fraud.score', note: 'threshold configurable' }])
    expect(p.annotations).toEqual([{ target: 'fraud.score', note: 'threshold configurable' }])
  })

  it('lists the files and nodes the change touches', () => {
    expect(touchedFiles(model, { ops: FRAUD_OPS })).toEqual(['src/checkout/service.ts', 'src/fraud/service.ts', 'src/orders/hold.ts'])
    expect(touchedNodes({ ops: FRAUD_OPS }).sort()).toEqual(['checkout.placeOrder', 'fraud.score', 'orderHold.create', 'payments.capture'])
  })

  it('describes each operation in a line', () => {
    const labels = new Map(model.nodes.map(n => [n.id, n.label]))
    expect(FRAUD_OPS.map(o => describeOp(o, labels).text)).toEqual([
      'New service FraudService.score',
      'CheckoutService.placeOrder → fraud.score',
      'New function OrderHold.create',
      'Branch ≥ 0.8 → orderHold.create',
      'Branch < 0.8 → PaymentService.capture',
      'CheckoutService.placeOrder → PaymentService.capture',
    ])
  })
})

describe('the lifecycle', () => {
  it('will not submit without an intent and a drawing', () => {
    const r1 = submit(fresh(), NOW)
    expect(r1.ok).toBe(false)
    const withIntent = ok(setIntent(fresh(), FRAUD_INTENT, NOW))
    const r2 = submit(withIntent, NOW)
    expect(!r2.ok && r2.reason).toMatch(/draw the change on the map first/)
  })

  it('drops questions without evidence and duplicates', () => {
    const cs = inReview()
    const { cs: next, check } = ok(
      addQuestions(
        cs,
        [
          ...fraudQuestions(),
          { severity: 'blocking', category: 'other', target: 'x', question: 'Is this a question with no evidence at all?', evidence: [] },
          { ...fraudQuestions()[0], id: 'dupe' },
        ],
        NOW,
      ),
    )
    expect(check.accepted.map(q => q.id)).toEqual(['q2', 'q3', 'q4'])
    expect(check.dropped.map(d => d.reason)).toEqual(['no evidence: every question must cite the code that prompted it', 'repeats an earlier question'])
    expect(openBlocking(next).map(q => q.id)).toEqual(['q2', 'q3'])
  })

  it('cannot be approved while a blocking question is open', () => {
    const { cs } = ok(addQuestions(inReview(), fraudQuestions(), NOW))
    const r = approve(cs, NOW)
    expect(!r.ok && r.reason).toMatch(/answer 2 more blocking questions first \(q2, q3\)/)
  })

  it('records an answer, applying the map change the option carries', () => {
    const { cs } = ok(addQuestions(inReview(), fraudQuestions(), NOW))
    const after = ok(answerQuestion(cs, { questionId: 'q3', optionId: 'release' }, NOW))
    const q = after.questions.find(x => x.id === 'q3')!
    expect(q.status).toBe('answered')
    expect(q.answer).toMatchObject({ optionId: 'release', changedMap: true })
    expect(after.ops.at(-1)).toMatchObject({ op: 'addEdge', from: 'orderHold.create', to: 'inventory.release', by: 'engineer' })
  })

  it('needs an option or the engineer’s own words', () => {
    const { cs } = ok(addQuestions(inReview(), fraudQuestions(), NOW))
    expect(answerQuestion(cs, { questionId: 'q2' }, NOW).ok).toBe(false)
    expect(answerQuestion(cs, { questionId: 'q2', optionId: 'nope' }, NOW).ok).toBe(false)
    expect(ok(answerQuestion(cs, { questionId: 'q2', text: 'fail closed over $500' }, NOW)).questions[0]!.answer?.text).toBe('fail closed over $500')
  })

  it('will not dismiss a blocking question, but will dismiss a worth-checking one', () => {
    const { cs } = ok(addQuestions(inReview(), fraudQuestions(), NOW))
    expect(dismissQuestion(cs, 'q2', NOW).ok).toBe(false)
    expect(ok(dismissQuestion(cs, 'q4', NOW)).questions.find(q => q.id === 'q4')?.status).toBe('dismissed')
  })

  it('treats operations Claude added without the engineer’s words as suggestions that block approval', () => {
    let cs = inReview()
    cs = ok(addTranscribedOps(cs, [{ op: 'addEdge', from: 'fraud.score', to: 'inventory.release' }], NOW))
    expect(cs.ops.at(-1)!.by).toBe('claude')
    expect(approvalBlockers(cs).join(' ')).toMatch(/suggested by Claude/)
    cs = ok(addTranscribedOps(cs, [{ op: 'annotate', target: 'fraud.score', note: 'x', quote: 'put a note on it saying x' }], NOW))
    expect(cs.ops.at(-1)!.by).toBe('engineer')
  })

  it('approves once every blocking question is answered', () => {
    let { cs } = ok(addQuestions(inReview(), fraudQuestions(), NOW))
    cs = ok(answerQuestion(cs, { questionId: 'q2', optionId: 'closed' }, NOW))
    cs = ok(answerQuestion(cs, { questionId: 'q3', optionId: 'extend' }, NOW))
    expect(approvalBlockers(cs)).toEqual([])
    const approved = ok(approve(cs, NOW))
    expect(approved.status).toBe('approved')
    expect(approved.history.map(h => h.event)).toEqual(['created', 'map-edited', 'intent', 'submitted', 'questions', 'answered', 'answered', 'approved'])
  })
})

describe('plans follow the map', () => {
  const approved = () => {
    let { cs } = ok(addQuestions(inReview(), fraudQuestions(), NOW))
    cs = ok(answerQuestion(cs, { questionId: 'q2', optionId: 'open' }, NOW))
    cs = ok(answerQuestion(cs, { questionId: 'q3', optionId: 'extend' }, NOW))
    return ok(approve(cs, NOW))
  }

  it('refuses a task that builds nothing on the map', () => {
    const problems = checkPlan(approved(), [
      { id: 't1', title: 'Fraud service', ops: [0, 1, 3, 4, 5], files: ['src/fraud/service.ts'] },
      { id: 't2', title: 'Hold', ops: [2], files: ['src/orders/hold.ts'] },
      { id: 't3', title: 'Refactor the payment client while we are here', ops: [], files: ['src/payments/service.ts'] },
    ])
    expect(problems).toEqual(['task "Refactor the payment client while we are here" builds nothing on the map; work that isn\'t on the map isn\'t planned'])
  })

  it('refuses a plan that leaves an operation out', () => {
    const problems = checkPlan(approved(), [{ id: 't1', title: 'Most of it', ops: [0, 1, 2, 3], files: [] }])
    expect(problems).toEqual(['operation 4 (Branch < 0.8 → payments.capture) has no task', 'operation 5 (checkout.placeOrder → payments.capture) has no task'])
  })

  it('saves a plan that covers the map', () => {
    const cs = ok(savePlan(approved(), [{ id: 't1', title: 'All of it', ops: [0, 1, 2, 3, 4, 5], files: ['src/fraud/service.ts'] }], NOW))
    expect(cs.plan).toHaveLength(1)
  })

  it('only plans approved changes', () => {
    expect(savePlan(inReview(), [], NOW).ok).toBe(false)
  })
})

describe('drift and skips', () => {
  it('a clean drift report verifies the change; a dirty one keeps it implemented', () => {
    const cs = { ...fresh(), status: 'implemented' as const }
    const clean = ok(recordDrift(cs, { ok: true, checkedAt: NOW, missing: [], unexpected: [], stillPresent: [], missingNodes: [] }, NOW))
    expect(clean.status).toBe('verified')
    const dirty = ok(recordDrift(cs, { ok: false, checkedAt: NOW, missing: ['a->b'], unexpected: [], stillPresent: [], missingNodes: [] }, NOW))
    expect(dirty.status).toBe('implemented')
    expect(dirty.history.at(-1)).toMatchObject({ event: 'drift', detail: '1 difference(s)' })
  })

  it('a skip needs a reason', () => {
    expect(skip(fresh(), '  ', NOW).ok).toBe(false)
    expect(ok(skip(fresh(), 'typo in the receipt template', NOW))).toMatchObject({ status: 'skipped', skipReason: 'typo in the receipt template' })
  })

  it('slugs titles for ids', () => {
    expect(slugify('Add a fraud check, before capture!')).toBe('add-a-fraud-check-before-capture')
    expect(slugify('!!!')).toBe('change')
  })
})
