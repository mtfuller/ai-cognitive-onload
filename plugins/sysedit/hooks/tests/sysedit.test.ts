// Tests for the System Editor mod, run with `claude plugin test plugins/sysedit`.
// They fire the events Claude Code would and stub the files under .sysedit/.

import { expect, mock, test } from 'claude-code/testing'

const ROOT = '/work'

type Files = Record<string, unknown>

const change = (status: string, extra: Record<string, unknown> = {}) => ({
  id: '0001-fraud-check',
  title: 'Fraud check before capture',
  base: 'fixture',
  request: 'Add a fraud check before we capture payment.',
  intent: 'Score every order before we charge it.',
  flow: 'checkout',
  ops: [{ op: 'addEdge', from: 'checkout.placeOrder', to: 'fraud.score', by: 'engineer' }],
  questions: [],
  status,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  history: [],
  ...extra,
})

const blockingQuestion = {
  id: 'q2',
  severity: 'blocking',
  category: 'failure-mode',
  target: 'FraudService.score',
  question: 'What happens when FraudService is slow or down?',
  evidence: [{ file: 'infra/gateway/routes.yaml', line: 19 }],
  status: 'open',
}

function withChange(cs: unknown, extra: Files = {}): Files {
  return {
    [`${ROOT}/.sysedit/state.json`]: { activeChange: '0001-fraud-check', editorUrl: 'http://127.0.0.1:4321/?t=abc' },
    [`${ROOT}/.sysedit/changes/0001-fraud-check.json`]: cs,
    ...extra,
  }
}

/** Stubs for everything the mod asks Claude Code for, with .sysedit/ served from `files`. */
function engine(on: any, files: Files, opts: { interactive?: boolean; askAnswer?: string; submitted?: string[] } = {}) {
  mock.clock(on)
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.read', ($, e) => (e.path in files ? { value: JSON.stringify(files[e.path]) } : { deny: `ENOENT: ${e.path}` }))
  on('command.register', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: false } }))
  on('session.start', () => ({ cwd: ROOT }))
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
  on('command.run', ($, e) => {
    opts.submitted?.push(e.command)
    return {}
  })
  const ran: string[] = []
  on('tool.call', ($, e) => {
    if (e.tool === 'AskUserQuestion') {
      const q = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
      return { result: { answers: { [q]: opts.askAnswer ?? 'Approve' } } }
    }
    ran.push(String(e.tool))
    return { result: 'ok' }
  })
  return { ran }
}

const start = ($: any, interactive = false) => $.session.start({ surface: interactive ? 'terminal' : null, isInteractive: interactive, cwd: ROOT })

test('holds a write to source while the change is being drawn', async ($, on) => {
  const { ran } = engine(on, withChange(change('draft')))
  await start($)
  const r = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/checkout/service.ts`, old_string: 'a', new_string: 'b' })
  expect(r.deny).toMatch(/still being drawn/)
  expect(ran).toEqual([])
})

test('lets sysedit write its own files while holding everything else', async ($, on) => {
  const { ran } = engine(on, withChange(change('draft')))
  await start($)
  const r = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/.sysedit/notes.md`, content: 'x' })
  expect(r.deny).toBeUndefined()
  expect(ran).toEqual(['Write'])
})

test('holds writes while a blocking question is open, and names it', async ($, on) => {
  engine(on, withChange(change('in-review', { questions: [blockingQuestion] })))
  await start($)
  const r = await $.tool.call({ tool: 'Write', file_path: 'src/fraud/service.ts', content: 'x' })
  expect(r.deny).toMatch(/1 blocking question to answer \(q2\)/)
})

test('lets writes through once the change is approved', async ($, on) => {
  const { ran } = engine(on, withChange(change('approved')))
  await start($)
  const r = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/checkout/service.ts`, old_string: 'a', new_string: 'b' })
  expect(r.deny).toBeUndefined()
  expect(ran).toEqual(['Edit'])
})

test('gets out of the way when no change is in progress', async ($, on) => {
  const { ran } = engine(on, {})
  await start($)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/README.md`, old_string: 'a', new_string: 'b' })
  expect(ran).toEqual(['Edit'])
})

test('strict mode holds files that are not on the approved map', { options: { gate_mode: 'strict' } }, async ($, on) => {
  const model = {
    version: 1,
    commit: 'fixture',
    nodes: [{ id: 'checkout.placeOrder', label: 'placeOrder', kind: 'function', source: { file: 'src/checkout/service.ts', lines: [1, 10] } }],
    edges: [],
    flows: [],
  }
  const { ran } = engine(on, withChange(change('approved'), { [`${ROOT}/.sysedit/model.json`]: model }))
  await start($)
  const off = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/payments/service.ts`, old_string: 'a', new_string: 'b' })
  expect(off.deny).toMatch(/isn't on the approved map/)
  const onMap = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/checkout/service.ts`, old_string: 'a', new_string: 'b' })
  expect(onMap.deny).toBeUndefined()
  expect(ran).toEqual(['Edit'])
})

test('tells Claude where the process stands on every prompt', async ($, on) => {
  engine(on, withChange(change('in-review', { questions: [blockingQuestion] })))
  await start($)
  const r = await $.prompt.submit({ text: 'just build it', attachments: undefined, wait: false } as any)
  expect(String(r.context?.join('\n'))).toMatch(/1 blocking question\(s\) are open; only the engineer answers them/)
})

test('in a -p run, approval goes through without a dialog', async ($, on) => {
  const { ran } = engine(on, withChange(change('in-review')))
  await start($, false)
  await $.tool.call({ tool: 'mcp__plugin_sysedit_sysedit__approve_change' } as any)
  expect(ran).toEqual(['mcp__plugin_sysedit_sysedit__approve_change'])
})

test('with a person at the prompt, approval waits for their yes', async ($, on) => {
  const { ran } = engine(on, withChange(change('in-review')), { askAnswer: 'Not yet' })
  await start($, true)
  const r = await $.tool.call({ tool: 'mcp__plugin_sysedit_sysedit__approve_change' } as any)
  expect(r.deny).toMatch(/has not approved yet/)
  expect(ran).toEqual([])
})

test('a skip the engineer allows goes through', async ($, on) => {
  const { ran } = engine(on, withChange(change('draft')), { askAnswer: 'Allow the skip' })
  await start($, true)
  await $.tool.call({ tool: 'mcp__plugin_sysedit_sysedit__skip_change', reason: 'typo fix' } as any)
  expect(ran).toEqual(['mcp__plugin_sysedit_sysedit__skip_change'])
})

test('/sysedit-status answers in text where no pane can be placed', async ($, on) => {
  engine(on, withChange(change('in-review', { questions: [blockingQuestion] })))
  await start($)
  const r = await $.command.run({ command: 'sysedit-status', args: '' })
  expect(r.text).toMatch(/Answering Claude’s questions/)
  expect(r.text).toMatch(/blocking q2 · FraudService.score/)
  expect(r.text).toMatch(/Editor: http:\/\/127.0.0.1:4321/)
})

const BAND = {
  plugin: 'sysedit',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 118, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const

test('the band shows the open blocking questions on every surface', async ($, on) => {
  engine(on, withChange(change('in-review', { questions: [blockingQuestion] })))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  await start($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface } as any)
    expect(await ui.find({ type: 'Text', text: /1 blocking question for you/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the band offers the next step once the change is approved', async ($, on) => {
  const submitted: string[] = []
  engine(on, withChange(change('approved')), { submitted })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await ui.press({ key: 'next' })
  expect(submitted).toEqual(['sysedit:plan'])
})

test('the band stays out of the way when nothing is in progress', async ($, on) => {
  engine(on, {})
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
})
