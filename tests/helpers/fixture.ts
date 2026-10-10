// Test fixtures: a throwaway git copy of the storefront repo, its golden model,
// and the mockup's fraud-check change at each stage of the process.

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ChangeSet, Op, Question } from '../../plugins/sysedit/core/changeset.ts'
import type { SystemModel } from '../../plugins/sysedit/core/model.ts'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const PLUGIN = join(ROOT, 'plugins', 'sysedit')
export const CLI = join(PLUGIN, 'dist', 'sysedit.mjs')
export const FIXTURE_REPO = join(ROOT, 'fixtures', 'storefront')

export function goldenModel(): SystemModel {
  return JSON.parse(readFileSync(join(ROOT, 'fixtures', 'storefront.model.json'), 'utf8'))
}

/** A fresh git repository with the storefront code in it. Remove it with `cleanup`. */
export function makeRepo(): { dir: string; commit: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sysedit-repo-'))
  cpSync(FIXTURE_REPO, dir, { recursive: true })
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' },
    })
      .toString()
      .trim()
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'storefront fixture')
  const commit = git('rev-parse', '--short', 'HEAD')
  return { dir, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

/** The engineer's drawing from the mockup: score every order before charging it. */
export const FRAUD_OPS: Op[] = [
  { op: 'addNode', id: 'fraud.score', kind: 'service', label: 'FraudService.score', file: 'src/fraud/service.ts', takes: 'order draft, customer', returns: 'risk score, 0 to 1', note: 'Threshold should be configurable.', by: 'engineer' },
  { op: 'addEdge', from: 'checkout.placeOrder', to: 'fraud.score', by: 'engineer' },
  { op: 'addNode', id: 'orderHold.create', kind: 'function', label: 'OrderHold.create', file: 'src/orders/hold.ts', detail: 'NEW · manual review queue', by: 'engineer' },
  { op: 'addBranch', from: 'fraud.score', when: '≥ 0.8', to: 'orderHold.create', by: 'engineer' },
  { op: 'addBranch', from: 'fraud.score', when: '< 0.8', to: 'payments.capture', by: 'engineer' },
  { op: 'removeEdge', from: 'checkout.placeOrder', to: 'payments.capture', by: 'engineer' },
]

export const FRAUD_INTENT = 'Score every order before we charge it. Risky orders go to manual review instead of being charged.'

export function fraudQuestions(): Partial<Question>[] {
  return [
    {
      id: 'q2',
      severity: 'blocking',
      category: 'failure-mode',
      target: 'FraudService.score',
      headline: 'FraudService adds a network call inside a 3 s budget',
      question: 'What happens when FraudService is slow or down? The gateway times out /checkout at 3 s, and the Stripe call already runs inside that budget.',
      evidence: [
        { file: 'infra/gateway/routes.yaml', line: 19, endLine: 24 },
        { file: 'src/checkout/service.ts', line: 51, endLine: 55 },
      ],
      checked: ['3 callers of placeOrder; only /checkout is user-facing', 'No timeout wrapper around external calls in checkout', 'src/lib/retry.ts already has withRetry() you could reuse'],
      options: [
        { id: 'open', label: 'Fail open: charge now, score in the background, flag for review', effect: 'Map updated: timeout branch → PaymentService.capture.' },
        {
          id: 'closed',
          label: 'Fail closed: hold the order for review',
          effect: 'Map updated: timeout branch → OrderHold.create.',
          ops: [{ op: 'annotate', target: 'fraud.score', note: 'On timeout, hold the order for review.' }],
        },
        { id: 'retry', label: 'Retry once, then hold the order', effect: 'Map updated: score wrapped in withRetry(1), timeout → OrderHold.create.' },
      ],
    },
    {
      id: 'q3',
      severity: 'blocking',
      category: 'consistency',
      target: 'InventoryService.reserve',
      question:
        'Stock is reserved before the score runs. When an order is held for review, what happens to that reservation? Today it expires after 15 min unless the order is saved as paid.',
      evidence: [{ file: 'src/inventory/service.ts', line: 7 }],
      options: [
        { id: 'release', label: 'Release the stock as soon as the order is held', ops: [{ op: 'addEdge', from: 'orderHold.create', to: 'inventory.release' }] },
        { id: 'extend', label: 'Keep it reserved until a reviewer decides' },
        { id: 'expire', label: 'Keep the 15 min expiry; cancel holds nobody reviews in time' },
      ],
    },
    {
      id: 'q4',
      severity: 'worth-checking',
      category: 'events',
      target: 'order.placed → EmailWorker (inferred)',
      question: "Held orders aren't paid. Should they still emit order.placed and get a receipt email, or a new order.held?",
      evidence: [{ file: 'workers/email/index.ts', line: 8 }],
    },
  ]
}

/** Write a model, and optionally an active change at a given stage, into a repo's .sysedit/. */
export function seed(dir: string, opts: { model?: SystemModel; change?: Partial<ChangeSet> & { id: string } } = {}) {
  const model = opts.model ?? goldenModel()
  writeJson(join(dir, '.sysedit', 'model.json'), model)
  if (opts.change) {
    const now = new Date().toISOString()
    const cs: ChangeSet = {
      title: 'Fraud check before capture',
      base: model.commit,
      request: 'Add a fraud check before we capture payment.',
      intent: '',
      flow: 'checkout',
      ops: [],
      questions: [],
      status: 'draft',
      risk: 'high',
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, event: 'created' }],
      ...opts.change,
    }
    writeJson(join(dir, '.sysedit', 'changes', `${cs.id}.json`), cs)
    writeJson(join(dir, '.sysedit', 'state.json'), { activeChange: cs.id })
  }
}

/**
 * Build the fraud check in a repo the way Claude would after approval, and
 * return the model a mapper would produce from the new code, with evidence.
 * `forgetHold` leaves out the branch to OrderHold, for drift tests.
 */
export function implementFraudCheck(dir: string, opts: { forgetHold?: boolean } = {}): SystemModel {
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  write(
    'src/fraud/service.ts',
    [
      "import type { Order } from '../orders/order.ts'",
      '',
      'export class FraudService {',
      '  constructor(private readonly threshold = Number(process.env.FRAUD_THRESHOLD ?? 0.8)) {}',
      '',
      '  async score(order: Order): Promise<number> {',
      '    return order.total > 10_000 ? 0.9 : 0.1',
      '  }',
      '',
      '  isRisky(score: number) {',
      '    return score >= this.threshold',
      '  }',
      '}',
      '',
    ].join('\n'),
  )
  write(
    'src/orders/hold.ts',
    ['export class OrderHold {', '  async create(orderId: string) {', '    return { orderId, status: "held" }', '  }', '}', ''].join('\n'),
  )
  const service = join(dir, 'src/checkout/service.ts')
  const src = readFileSync(service, 'utf8')
  const hold = opts.forgetHold ? '' : '    if (this.fraud.isRisky(score)) return this.holds.create(draft.id)\n'
  writeFileSync(
    service,
    src.replace(
      '    const payment = await this.payments.capture({',
      `    const score = await this.fraud.score(draft)\n${hold}    const payment = await this.payments.capture({`,
    ),
  )
  const lines = (file: string) => readFileSync(join(dir, file), 'utf8').split('\n')
  const at = (file: string, text: string) => lines(file).findIndex(l => l.includes(text)) + 1

  const base = goldenModel()
  const model: SystemModel = {
    ...base,
    commit: 'built',
    nodes: [
      ...base.nodes,
      { id: 'fraud.score', label: 'FraudService.score', kind: 'service', source: { file: 'src/fraud/service.ts', lines: [6, 8] } },
      ...(opts.forgetHold ? [] : [{ id: 'orderHold.create', label: 'OrderHold.create', kind: 'function' as const, source: { file: 'src/orders/hold.ts', lines: [2, 4] as [number, number] } }]),
    ],
    edges: [
      ...base.edges.filter(e => !(e.from === 'checkout.placeOrder' && e.to === 'payments.capture')),
      { from: 'checkout.placeOrder', to: 'fraud.score', kind: 'call', confidence: 'read', evidence: { file: 'src/checkout/service.ts', line: at('src/checkout/service.ts', 'this.fraud.score(') } },
      ...(opts.forgetHold
        ? []
        : [{ from: 'fraud.score', to: 'orderHold.create', kind: 'branch' as const, when: '≥ 0.8', confidence: 'read' as const, evidence: { file: 'src/checkout/service.ts', line: at('src/checkout/service.ts', 'this.holds.create(') } }]),
      { from: 'fraud.score', to: 'payments.capture', kind: 'branch', when: '< 0.8', confidence: 'read', evidence: { file: 'src/checkout/service.ts', line: at('src/checkout/service.ts', 'this.payments.capture({') } },
    ],
  }
  model.flows = model.flows.map(f =>
    f.id !== 'checkout'
      ? f
      : { ...f, steps: f.steps.filter(s => s.edge !== 'checkout.placeOrder->payments.capture').concat({ edge: 'checkout.placeOrder->fraud.score', title: 'placeOrder scores the order' }) },
  )
  return model
}
