import { describe, expect, it } from 'vitest'

import { atLevel, edgeId, flowSlice, mergeModels, modelStats, nodeLevel, ownerAt, type SystemModel } from '../../plugins/sysedit/core/model.ts'
import { isSafeRelativePath, validateModel } from '../../plugins/sysedit/core/validate.ts'
import { goldenModel } from '../helpers/fixture.ts'

describe('the golden storefront model', () => {
  const model = goldenModel()

  it('is valid, with every box sourced and every read edge evidenced', () => {
    const r = validateModel(model)
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('marks the event-bus subscription as inferred, and only that', () => {
    const inferred = model.edges.filter(e => e.confidence === 'inferred').map(edgeId)
    expect(inferred).toEqual(['bus.orderPlaced->email.sendReceipt'])
    expect(modelStats(model).inferred).toBe(1)
  })
})

describe('validateModel', () => {
  const base = (): SystemModel => ({
    version: 1,
    commit: 'abc1234',
    nodes: [
      { id: 'a', label: 'A', kind: 'function', source: { file: 'src/a.ts', lines: [1, 5] } },
      { id: 'b', label: 'B', kind: 'function', source: { file: 'src/b.ts', lines: [1, 5] } },
      { id: 'x', label: 'X', kind: 'external', external: true },
    ],
    edges: [
      { from: 'a', to: 'b', kind: 'call', confidence: 'read', evidence: { file: 'src/a.ts', line: 3 } },
      { from: 'b', to: 'x', kind: 'http', confidence: 'inferred', note: 'via config' },
    ],
    flows: [{ id: 'f', entry: 'GET /a', entryNode: 'a', steps: [{ edge: 'a->b', title: 'a calls b' }, { edge: 'b->x', title: 'b calls x' }] }],
  })

  it('accepts a well-formed model', () => {
    expect(validateModel(base()).ok).toBe(true)
  })

  it('refuses a box with no source', () => {
    const m = base()
    delete m.nodes[0]!.source
    const r = validateModel(m)
    expect(r.ok).toBe(false)
    expect(r.errors[0]!.message).toMatch(/has no source/)
  })

  it('refuses a read edge with no evidence, and asks for it or an inferred mark', () => {
    const m = base()
    delete m.edges[0]!.evidence
    expect(validateModel(m).errors[0]!.message).toMatch(/marked read but has no evidence/)
  })

  it('warns when an inferred edge does not say how it was inferred', () => {
    const m = base()
    delete m.edges[1]!.note
    const r = validateModel(m)
    expect(r.ok).toBe(true)
    expect(r.warnings[0]!.message).toMatch(/should say how it was inferred/)
  })

  it('refuses edges to unknown nodes, duplicate ids and unknown flow edges', () => {
    const m = base()
    m.edges.push({ from: 'a', to: 'ghost', kind: 'call', confidence: 'inferred', note: 'n' })
    m.nodes.push({ id: 'a', label: 'dup', kind: 'function', source: { file: 'src/a.ts', lines: [1, 1] } })
    m.flows[0]!.steps.push({ edge: 'b->ghost', title: 'nope' })
    const messages = validateModel(m).errors.map(e => e.message).join('\n')
    expect(messages).toMatch(/unknown node "ghost"/)
    expect(messages).toMatch(/duplicate node id "a"/)
    expect(messages).toMatch(/unknown edge "b->ghost"/)
  })

  it('checks lines against the files on disk when it knows them', () => {
    const r = validateModel(base(), { lineCounts: new Map([['src/a.ts', 2], ['src/b.ts', 10]]) })
    expect(r.errors.map(e => e.message)).toEqual([
      'src/a.ts has 2 lines, so 1–5 is out of range',
      'src/a.ts has 2 lines, so 3–3 is out of range',
    ])
  })

  it('refuses paths that escape the repository', () => {
    const m = base()
    m.nodes[0]!.source = { file: '../../etc/passwd', lines: [1, 1] }
    expect(validateModel(m).errors[0]!.message).toMatch(/relative to the repository root/)
    expect(isSafeRelativePath('/etc/passwd')).toBe(false)
    expect(isSafeRelativePath('C:\\x')).toBe(false)
    expect(isSafeRelativePath('src/../x')).toBe(false)
    expect(isSafeRelativePath('src/x.ts')).toBe(true)
  })

  it('rejects things that are not models', () => {
    expect(validateModel(null).ok).toBe(false)
    expect(validateModel({ version: 2, commit: 'x', nodes: [], edges: [], flows: [] }).errors[0]!.path).toBe('version')
  })
})

describe('levels and slices', () => {
  const model = goldenModel()

  it('derives a level from the kind when none is given', () => {
    expect(nodeLevel({ id: 'x', label: 'x', kind: 'external' })).toBe('services')
    expect(nodeLevel({ id: 'x', label: 'x', kind: 'module' })).toBe('modules')
    expect(nodeLevel({ id: 'x', label: 'x', kind: 'function' })).toBe('functions')
  })

  it('folds functions into their modules, dropping self-loops', () => {
    const m = atLevel(model, 'modules')
    const pairs = m.edges.map(edgeId)
    expect(pairs).toContain('mod.checkout->mod.inventory')
    expect(pairs).toContain('mod.checkout->mod.payments')
    expect(pairs).toContain('mod.payments->stripe')
    expect(pairs.some(p => p.split('->')[0] === p.split('->')[1])).toBe(false)
    expect(m.nodes.some(n => n.kind === 'function')).toBe(false)
  })

  it('folds to services, where the whole API is one box', () => {
    const owner = ownerAt(model, 'services')
    expect(owner('checkout.placeOrder')).toBe('svc.ordersApi')
    expect(owner('email.sendReceipt')).toBe('svc.emailWorker')
    expect(owner('stripe')).toBe('stripe')
    const pairs = atLevel(model, 'services').edges.map(edgeId)
    expect(pairs).toContain('svc.ordersApi->stripe')
    expect(pairs).toContain('bus.orderPlaced->svc.emailWorker')
  })

  it('slices one flow', () => {
    const s = flowSlice(model, 'checkout')
    expect(s.edges).toHaveLength(8)
    expect(s.nodes.map(n => n.id)).toContain('email.sendReceipt')
    expect(s.nodes.map(n => n.id)).not.toContain('cron.releaseExpiredHolds')
    expect(flowSlice(model, 'nope').nodes).toEqual([])
  })

  it('merges slices by id, newest wins', () => {
    const a: SystemModel = { version: 1, commit: 'c1', nodes: [{ id: 'n', label: 'old', kind: 'function', source: { file: 'f', lines: [1, 1] } }], edges: [], flows: [] }
    const b: SystemModel = { version: 1, commit: 'c2', nodes: [{ id: 'n', label: 'new', kind: 'function', source: { file: 'f', lines: [1, 1] } }, { id: 'm', label: 'm', kind: 'external' }], edges: [], flows: [] }
    const m = mergeModels(a, b)
    expect(m.commit).toBe('c2')
    expect(m.nodes.map(n => n.label)).toEqual(['new', 'm'])
  })
})
