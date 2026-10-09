// The System Editor mod: the gate on writes, a band above the prompt that
// says what the process is waiting on, a status pane, and a check that the
// decisions Claude must not make alone (answers, approval, skipping) come
// from the engineer's own words.
//
// Everything it knows it reads from .sysedit/ in the project, which the MCP
// server, the CLI and the editor write. The decisions come from core/, the
// same code the server and the tests run.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { openBlocking, suggestedOps, type ChangeSet } from '../core/changeset.ts'
import { decide, stageOf, STAGE_LABEL, type GateMode, type SyseditState } from '../core/gate.ts'
import { checkApproval, checkQuote, isDelegation } from '../core/provenance.ts'
import type { SystemModel } from '../core/model.ts'
import type { SyseditSummary } from '../types'

const PANE = 'sysedit'
const MCP = 'mcp__plugin_sysedit_sysedit__'

const IDLE: SyseditSummary = { stage: 'idle', label: STAGE_LABEL.idle, openBlocking: [], questions: 0, suggested: 0, hasPlan: false }

const summary = atom({ plugin: 'sysedit', key: 'summary' } as const, IDLE)
const isBandHidden = atom({ plugin: 'sysedit', key: 'isBandHidden' } as const, false)

type Snapshot = { root: string; state: SyseditState; change: ChangeSet | null; model: SystemModel | null }

async function readJson<T>($: EngineInterface, path: string): Promise<T | null> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return null
  }
}

/** The active change as it is on disk now. A missing or unreadable .sysedit/ reads as no change. */
async function snapshot($: EngineInterface, withModel = false): Promise<Snapshot> {
  const root = await $.session.root()
  const state = (await readJson<SyseditState>($, `${root}/.sysedit/state.json`)) ?? { activeChange: null }
  const id = state.activeChange
  const change = id && /^[A-Za-z0-9_-]+$/.test(id) ? await readJson<ChangeSet>($, `${root}/.sysedit/changes/${id}.json`) : null
  const model = withModel ? await readJson<SystemModel>($, `${root}/.sysedit/model.json`) : null
  return { root, state, change, model }
}

function summarise(s: Snapshot): SyseditSummary {
  const cs = s.change
  if (!cs) return { ...IDLE, editorUrl: s.state.editorUrl }
  const stage = stageOf(cs, true)
  return {
    stage,
    label: STAGE_LABEL[stage],
    id: cs.id,
    title: cs.title,
    status: cs.status,
    openBlocking: openBlocking(cs).map(q => ({ id: q.id, target: q.target, question: q.question })),
    questions: cs.questions.length,
    suggested: suggestedOps(cs).length,
    hasPlan: !!cs.plan && cs.plan.length > 0,
    driftOk: cs.drift?.ok,
    editorUrl: s.state.editorUrl,
  }
}

const same = (a: SyseditSummary, b: SyseditSummary) => JSON.stringify(a) === JSON.stringify(b)

/** The one next step the band offers: one of the plugin's skills, run as its slash command. */
function nextStep(s: SyseditSummary): { label: string; command: string } | null {
  if (s.stage === 'grill' && s.questions === 0) return { label: 'Run the grill', command: 'sysedit:grill' }
  if (s.stage === 'implement' && !s.hasPlan) return { label: 'Plan and build it', command: 'sysedit:plan' }
  if (s.stage === 'verify') return { label: 'Verify against the map', command: 'sysedit:verify' }
  if (s.stage === 'done') return { label: 'Write the decision record', command: 'sysedit:record' }
  return null
}

/** Everything the engineer typed this session: their prompts and their answers to Claude's questions. */
async function engineerSaid($: EngineInterface): Promise<string[]> {
  const rows = await $.session.messages()
  const out: string[] = []
  const asked = new Set<string>()
  for (const row of rows) {
    if (row.role === 'assistant') {
      for (const use of row.toolUses) if (use.tool === 'AskUserQuestion') asked.add(use.tool_use_id)
      continue
    }
    if (row.text) out.push(row.text)
    for (const r of row.toolResults ?? []) if (asked.has(r.tool_use_id) && r.text) out.push(r.text)
  }
  return out
}

/** Re-read .sysedit/ and redraw what changed. */
async function refresh($: EngineInterface) {
  const next = summarise(await snapshot($))
  const prev = await read($, summary)
  if (same(prev, next)) return
  await update($, summary, () => next)
  if (next.stage === 'idle' || next.stage === 'done' || next.stage === 'skipped') $.ui.status(undefined)
  else if (prev.stage !== next.stage) $.ui.status(`sysedit: ${next.label}`)
}

export const register: Register = (on, options) => {
  const mode = ((options as { gate_mode?: string }).gate_mode ?? 'approved-only') as GateMode
  let isInteractive = false

  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive
    await $.command.register({ name: 'sysedit-status', description: 'Show where the System Editor process stands: stage, open questions, next step' })
    await refresh($)
    // The editor and the CLI write .sysedit/ from outside this session; follow them.
    $.clock.every(2000, () => void refresh($).catch(() => undefined))
    return next(e)
  })

  // The gate. Judged before next(e), from the files as they are now, so a
  // change approved a moment ago in the browser lets the write through.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as { file_path?: string; notebook_path?: string }
    const s = await snapshot($, mode === 'strict')
    const decision = decide({
      tool,
      filePath: input.file_path ?? input.notebook_path,
      root: s.root,
      cwd: await $.session.cwd(),
      mode,
      change: s.change,
      model: s.model,
    })
    if (!decision.allow) return { deny: decision.reason }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Answers, approvals and skips are the engineer's. Claude passes the
  // engineer's words as `quote`; check them against what the engineer typed
  // this session, so a delegation ("answer them yourself") or a paraphrase
  // Claude made up can't stand in for a decision. With a person at the
  // prompt, approving and skipping also take their explicit yes.
  on(
    'tool.call',
    {
      tool: [
        'mcp__plugin_sysedit_sysedit__record_answer',
        'mcp__plugin_sysedit_sysedit__approve_change',
        'mcp__plugin_sysedit_sysedit__skip_change',
        'mcp__plugin_sysedit_sysedit__propose_ops',
      ],
    },
    async ($, e, next) => {
      const tool = String(e.tool)
      const args = e as unknown as { quote?: unknown; reason?: string; ops?: { quote?: unknown }[] }
      const said = await engineerSaid($)

      if (tool.endsWith('propose_ops')) {
        // An op whose quote the engineer never said goes on the map as Claude's suggestion.
        const ops = (args.ops ?? []).map(op => (op.quote !== undefined && !checkQuote(op.quote, said).ok ? { ...op, quote: undefined } : op))
        return next({ ...e, ops } as typeof e)
      }

      const isApprove = tool.endsWith('approve_change')
      const check = isApprove ? checkApproval(args.quote, said) : checkQuote(args.quote, said)
      if (!check.ok) return { deny: check.reason }
      if (tool.endsWith('record_answer') || !isInteractive) return next(e)

      const s = await snapshot($)
      const isSkip = !isApprove
      const question = isSkip
        ? `Claude wants to skip System Editor for "${s.change?.title ?? 'this change'}"${args.reason ? ` because: ${args.reason}` : ''}. Allow the skip?`
        : `Approve "${s.change?.title ?? 'the change'}" as drawn and answered, and let Claude build it?`
      let answer = ''
      try {
        answer = await $.ui.ask(question, { header: isSkip ? 'Skip' : 'Approve', options: isSkip ? ['Allow the skip', 'Keep the process'] : ['Approve', 'Not yet'] })
      } catch {
        return { deny: 'The engineer did not confirm. Ask them in chat what they want to do.' }
      }
      if (answer === 'Allow the skip' || answer === 'Approve') return next(e)
      return {
        deny: isSkip
          ? `The engineer kept the process for this change${answer && answer !== 'Keep the process' ? `: "${answer}"` : ''}. Continue with the next stage.`
          : `The engineer has not approved yet${answer && answer !== 'Not yet' ? `: "${answer}"` : ''}. Ask what they want to change.`,
      }
    },
  ).catch(($, e, next) => (next.called ? next(e) : { deny: "sysedit couldn't check that this came from the engineer; ask them in chat." }))

  // Keep Claude oriented: every prompt during a change carries a one-line
  // status. When the engineer tries to hand a decision back, steer Claude to
  // the fast path rather than the shortcut.
  on('prompt.submit', async ($, e, next) => {
    const s = await read($, summary)
    if (s.stage === 'idle' || s.stage === 'done' || s.stage === 'skipped') return next(e)
    const lines = [
      `System Editor: change "${s.title}" (${s.id}) is at stage "${s.label}".` +
        (s.openBlocking.length > 0 ? ` ${s.openBlocking.length} blocking question(s) are open; only the engineer answers them.` : '') +
        (s.stage === 'edit' ? ' The engineer designs the change; if they have described it in their own words, transcribe it with propose_ops, quoting them.' : '') +
        ' Writes outside .sysedit/ are held until the change is approved.',
    ]
    if ((s.stage === 'edit' || s.stage === 'grill') && isDelegation(e.text)) {
      lines.push(
        'The engineer is asking you to make the design decisions for them. Do not: answers, drawing and approval must be theirs, and the plugin refuses answers they did not give. ' +
          'Make it fast instead. List each open blocking question in one line with lettered options and the one fact that matters, so they can reply in a few words (for example "q2 b, q3 a"). ' +
          'Mention that /sysedit:skip <reason> bypasses the process if this change does not need it (the skip is logged). Do not write code.',
      )
    }
    return next({ ...e, context: [...(e.context ?? []), ...lines] })
  }).catch(($, e, next) => next(e))

  // After a sysedit tool runs, redraw from disk at once rather than at the next tick.
  on('tool.call', { tool: /^mcp__plugin_sysedit_sysedit__/ }, async ($, e, next) => {
    const ran = await next(e)
    await refresh($).catch(() => undefined)
    return ran
  })

  on('command.run', { command: 'sysedit-status' }, async $ => {
    await refresh($)
    const s = await read($, summary)
    await update($, isBandHidden, () => false)
    const placed = await $.ui.open({ id: PANE, title: 'System Editor' }).catch(() => ({ isPlaced: false }))
    if (placed.isPlaced) return {}
    // Nowhere to draw (a -p run, VS Code): answer in text.
    const lines = [`System Editor: ${s.label}`]
    if (s.title) lines.push(`Change ${s.id}: ${s.title} [${s.status}]`)
    for (const q of s.openBlocking) lines.push(`  blocking ${q.id} · ${q.target}: ${q.question}`)
    if (s.suggested) lines.push(`  ${s.suggested} suggested operation(s) need the engineer's OK`)
    const step = nextStep(s)
    if (step) lines.push(`Next: /${step.command}`)
    if (s.editorUrl) lines.push(`Editor: ${s.editorUrl}`)
    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, summary)
    if (s.stage === 'idle' || s.stage === 'skipped' || e.props.hasSurvey || (await read($, isBandHidden))) return next(e)
    const { Box, Button, Text, Link } = $.ui.resolve(e)
    const step = nextStep(s)
    const blocking = s.openBlocking.length
    return (
      <Box flexDirection="row" gap={1}>
        <Text bold color={blocking > 0 ? 'red' : 'blue'}>
          sysedit
        </Text>
        <Text>{s.label}</Text>
        {s.title && <Text dimColor>· {s.title}</Text>}
        {blocking > 0 && (
          <Text color="red">
            · {blocking} blocking question{blocking === 1 ? '' : 's'} for you
          </Text>
        )}
        {s.suggested > 0 && <Text color="yellow">· {s.suggested} suggestion(s) to accept</Text>}
        {s.editorUrl && (s.stage === 'edit' || s.stage === 'grill') && <Link href={s.editorUrl} label="open editor" />}
        {step && (
          <Button key="next" hotkey="1" label={step.label} onPress={() => void $.command.run({ command: step.command, args: '' })} />
        )}
        <Button key="hide" label="Hide" plain dimColor onPress={() => update($, isBandHidden, () => true)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = await read($, summary)
    const { Box, Button, Text, Link } = $.ui.resolve(e)
    const step = nextStep(s)
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{s.label}</Text>
        {s.title ? (
          <Text>
            {s.id}: {s.title} <Text dimColor>[{s.status}]</Text>
          </Text>
        ) : (
          <Text dimColor>No change in progress. Start one with /sysedit:map and your request.</Text>
        )}
        {s.openBlocking.length > 0 && (
          <Box flexDirection="column">
            <Text color="red">Blocking questions only you can answer:</Text>
            {s.openBlocking.map(q => (
              <Text key={q.id}>
                {'  '}
                {q.id} · <Text dimColor>{q.target}</Text> {q.question}
              </Text>
            ))}
          </Box>
        )}
        {s.suggested > 0 && <Text color="yellow">{s.suggested} operation(s) Claude suggested are waiting for your OK in the editor.</Text>}
        {s.driftOk === false && <Text color="red">Verify found drift between the code and your map.</Text>}
        {s.editorUrl && <Link href={s.editorUrl} label={`Editor: ${s.editorUrl}`} />}
        {step && <Button key="pane-next" label={step.label} onPress={() => void $.command.run({ command: step.command, args: '' })} />}
      </Box>
    )
  })
}
