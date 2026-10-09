// The whole System Editor process through the real MCP server binary, on a
// throwaway git copy of the storefront fixture: map → draw → grill → answer →
// approve → plan → build → verify, with the gate's view checked at each stage.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CLI, FRAUD_INTENT, FRAUD_OPS, fraudQuestions, goldenModel, implementFraudCheck, makeRepo } from '../helpers/fixture.ts'
import { McpClient } from '../helpers/mcp.ts'

let repo: ReturnType<typeof makeRepo>
let mcp: McpClient

beforeEach(async () => {
  repo = makeRepo()
  mcp = new McpClient(repo.dir)
  await mcp.initialize()
})

afterEach(async () => {
  await mcp.close()
  repo.cleanup()
})

/** What the settings-hook gate says about a write, via the CLI, as Claude Code would call it. */
function gate(file: string): string {
  return execFileSync(process.execPath, [CLI, 'gate', '--root', repo.dir], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(repo.dir, file) }, cwd: repo.dir }),
  }).toString()
}

describe('the MCP server', () => {
  it('speaks MCP: initialize, tools/list, ping, unknown methods', async () => {
    const list = await mcp.request<{ tools: { name: string; inputSchema: object }[] }>('tools/list')
    const names = list.tools.map(t => t.name)
    for (const n of ['status', 'save_model', 'start_change', 'propose_ops', 'add_questions', 'record_answer', 'approve_change', 'save_plan', 'verify_change', 'skip_change', 'open_editor']) {
      expect(names).toContain(n)
    }
    for (const t of list.tools) expect(t.inputSchema).toMatchObject({ type: 'object' })
    await expect(mcp.request('ping')).resolves.toEqual({})
    await expect(mcp.request('resources/list')).rejects.toThrow(/method not found/)
    const bad = await mcp.request('tools/call', { name: 'nope', arguments: {} }).catch(e => e)
    expect(String(bad)).toMatch(/unknown tool/)
  })

  it('answers a malformed line with a parse error and keeps going', async () => {
    mcp.writeRaw('{not json')
    await expect(mcp.request('ping')).resolves.toEqual({})
  })

  it('reports tool failures as tool errors, not protocol errors', async () => {
    const r = await mcp.call('approve_change')
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/no change in progress/)
  })

  it('refuses to save a model without evidence, and says why', async () => {
    const model = goldenModel()
    delete model.edges[1]!.evidence
    const r = await mcp.call('save_model', { model })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/Not saved/)
    expect(r.text).toMatch(/orders.create->checkout.placeOrder" is marked read but has no evidence/)
    expect(existsSync(join(repo.dir, '.sysedit', 'model.json'))).toBe(false)
  })

  it('refuses evidence that points past the end of a file', async () => {
    const model = goldenModel()
    model.edges[1]!.evidence!.line = 9999
    const r = await mcp.call('save_model', { model })
    expect(r.text).toMatch(/src\/orders\/controller.ts has \d+ lines, so 9999–9999 is out of range/)
  })
})

describe('the process, end to end', () => {
  it('holds code until the engineer has drawn, defended and approved the change, then verifies the build', async () => {
    // Map
    const saved = await mcp.call('save_model', { model: { ...goldenModel(), commit: repo.commit } })
    expect(saved.isError).toBe(false)
    expect(saved.text).toMatch(/Saved. 17 nodes, 9 edges \(1 inferred\), 2 flows/)
    expect(gate('src/checkout/service.ts')).toBe('')

    // Start: the gate closes
    const started = await mcp.call('start_change', { title: 'Fraud check before capture', request: 'Add a fraud check before we capture payment.', flow: 'checkout' })
    expect(started.text).toMatch(/Started change 0001-fraud-check-before-capture \(high risk\)/)
    expect(JSON.parse(gate('src/checkout/service.ts')).hookSpecificOutput.permissionDecision).toBe('deny')
    expect(gate('.sysedit/scratch.md')).toBe('')

    // A second change can't start while this one is open
    const second = await mcp.call('start_change', { title: 'Other', request: 'x' })
    expect(second.isError).toBe(true)

    // Claude transcribes the engineer's words; an op without a quote is only a suggestion
    await mcp.call('propose_ops', { ops: FRAUD_OPS.map(({ by, ...op }) => ({ ...op, quote: 'score every order before capture; hold at 0.8' })) })
    const suggested = await mcp.call('propose_ops', { ops: [{ op: 'addEdge', from: 'fraud.score', to: 'stripe' }] })
    expect(suggested.text).toMatch(/1 of them suggestions the engineer must accept/)
    await mcp.call('set_intent', { intent: FRAUD_INTENT })
    expect((await mcp.call('submit_change')).isError).toBe(false)

    // Grill: the evidence-free question is dropped
    const asked = await mcp.call('add_questions', {
      questions: [...fraudQuestions(), { severity: 'blocking', category: 'other', target: 'x', question: 'Have you thought about scale at all here?', evidence: [] }],
    })
    expect(asked.text).toMatch(/Asked 3 question\(s\); 2 blocking open/)
    expect(asked.text).toMatch(/no evidence: every question must cite the code/)

    // Still held, and the gate says why
    const held = JSON.parse(gate('src/fraud/service.ts')).hookSpecificOutput.permissionDecisionReason
    expect(held).toMatch(/2 blocking questions to answer \(q2, q3\)/)

    // The engineer answers
    await mcp.call('record_answer', { questionId: 'q2', optionId: 'closed' })
    await mcp.call('record_answer', { questionId: 'q3', text: 'Keep it reserved until a reviewer decides, max 24h.' })

    // Approval still refused: Claude's suggestion hasn't been accepted
    const refused = await mcp.call('approve_change')
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/suggested by Claude/)

    // The engineer accepts it in the editor
    const editor = await mcp.call('open_editor')
    const url = new URL(editor.text.match(/http\S+/)![0])
    const token = url.searchParams.get('t')!
    const ops = (await mcp.json('get_change')).change.ops as { by: string }[]
    const res = await fetch(new URL('/api/change/accept-op', url), {
      method: 'POST',
      headers: { 'x-sysedit-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ index: ops.findIndex(o => o.by === 'claude') }),
    })
    expect(res.status).toBe(200)

    // Approve: the gate opens
    expect((await mcp.call('approve_change')).isError).toBe(false)
    expect(gate('src/fraud/service.ts')).toBe('')

    // Plan: refused when it builds off the map, accepted when it covers the map
    const offMap = await mcp.call('save_plan', { tasks: [{ id: 't1', title: 'Rewrite payments', ops: [], files: ['src/payments/service.ts'] }] })
    expect(offMap.isError).toBe(true)
    const all = (await mcp.json('get_change')).change.ops.map((_: unknown, i: number) => i)
    const plan = await mcp.call('save_plan', { tasks: [{ id: 't1', title: 'Fraud check', ops: all, files: ['src/fraud/service.ts', 'src/orders/hold.ts', 'src/checkout/service.ts'] }] })
    expect(plan.isError).toBe(false)

    // Build, then verify: first a build that forgot the hold branch...
    await mcp.call('mark_implemented')
    const incomplete = implementFraudCheck(repo.dir, { forgetHold: true })
    const drift = await mcp.call('verify_change', { actual: incomplete })
    expect(drift.text).toMatch(/missing node\s+orderHold.create/)
    expect(drift.text).toMatch(/missing edge\s+fraud.score->orderHold.create/)
    expect((await mcp.json('status')).change.status).toBe('implemented')
    expect(() => execFileSync(process.execPath, [CLI, 'ci', '--root', repo.dir], { stdio: 'pipe' })).toThrow()

    // ...then the complete build. (Claude's accepted fraud.score -> stripe suggestion is on the map, so it's built too.)
    execFileSync('git', ['checkout', '--', 'src/checkout/service.ts'], { cwd: repo.dir })
    const built = implementFraudCheck(repo.dir)
    built.edges.push({ from: 'fraud.score', to: 'stripe', kind: 'http', confidence: 'read', evidence: { file: 'src/fraud/service.ts', line: 7 } })
    const clean = await mcp.call('verify_change', { actual: built })
    expect(clean.text).toMatch(/No drift/)
    expect((await mcp.json('status')).stage).toBe('done')

    // CI is satisfied, and the metrics saw the drift and the map-changing answer
    expect(() => execFileSync(process.execPath, [CLI, 'ci', '--root', repo.dir])).not.toThrow()
    const metrics = await mcp.call('get_metrics')
    expect(metrics.text).toMatch(/Drift caught before merge: 100%/)
    expect(metrics.text).toMatch(/Grill hit rate .*: 50% of 2 blocking asked/)

    // Everything lives in the repo as reviewable JSON
    const cs = JSON.parse(readFileSync(join(repo.dir, '.sysedit', 'changes', '0001-fraud-check-before-capture.json'), 'utf8'))
    expect(cs.history.map((h: { event: string }) => h.event)).toEqual([
      'created',
      'map-edited',
      'map-edited',
      'intent',
      'submitted',
      'questions',
      'answered',
      'answered',
      'op-accepted',
      'approved',
      'planned',
      'implemented',
      'drift',
      'verified',
    ])
  })

  it('logs a skip with its reason and opens the gate', async () => {
    await mcp.call('save_model', { model: goldenModel() })
    await mcp.call('start_change', { title: 'Receipt typo', request: 'Fix the typo in the receipt email' })
    expect(gate('workers/email/index.ts')).not.toBe('')
    const r = await mcp.call('skip_change', { reason: 'one-word typo in a template' })
    expect(r.text).toMatch(/Skipped 0001-receipt-typo; reason logged/)
    expect(gate('workers/email/index.ts')).toBe('')
    const log = readFileSync(join(repo.dir, '.sysedit', 'skips.jsonl'), 'utf8')
    expect(JSON.parse(log.trim())).toMatchObject({ reason: 'one-word typo in a template', change: '0001-receipt-typo', risk: 'low' })
  })

  it('records explain-back checks', async () => {
    const r = await mcp.call('record_explain_back', { flow: 'checkout', score: 0.625, missed: ['outbox relay', 'inferred email edge', 'cart idempotency key'] })
    expect(r.text).toMatch(/63%/)
    expect((await mcp.call('get_metrics')).text).toMatch(/Explain-back mean score: 63% over 1 check/)
  })

  it('renders the proposed change as Mermaid for terminals and PRs', async () => {
    await mcp.call('save_model', { model: goldenModel() })
    await mcp.call('start_change', { title: 'Fraud', request: 'fraud check', flow: 'checkout' })
    await mcp.call('propose_ops', { ops: FRAUD_OPS.map(op => ({ ...op, quote: 'as drawn' })) })
    const out = (await mcp.call('render_mermaid', { proposed: true })).text
    expect(out).toMatch(/title: Fraud/)
    expect(out).toMatch(/class fraud_score,orderHold_create added/)
  })
})
