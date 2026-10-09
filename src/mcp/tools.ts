// The tools Claude gets from the sysedit MCP server. Their descriptions carry
// the rules of the process, because they are what Claude reads when it decides
// what to call: Claude maps, questions and builds; the engineer draws, answers
// and approves.

import type { Op, PlanTask, Question } from '../../plugins/sysedit/core/changeset.ts'
import { formatDrift } from '../../plugins/sysedit/core/drift.ts'
import { formatMetrics } from '../../plugins/sysedit/core/metrics.ts'
import { LEVELS, type Level, type SystemModel } from '../../plugins/sysedit/core/model.ts'
import { formatReport } from '../../plugins/sysedit/core/validate.ts'
import type { EditorServer } from '../http/server.ts'
import { Sysedit } from '../node/service.ts'

export type ToolResult = { text: string; data?: unknown; isError?: boolean }

export type ToolDef = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: any, ctx: ToolContext) => Promise<ToolResult> | ToolResult
}

export type ToolContext = {
  app: Sysedit
  openEditor: () => Promise<EditorServer>
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const evidenceSchema = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'Repository-relative path.' },
    line: { type: 'integer', minimum: 1 },
    endLine: { type: 'integer', minimum: 1 },
    snippet: { type: 'string', description: 'The code at those lines, verbatim.' },
  },
  required: ['file', 'line'],
}

const opSchema = {
  type: 'object',
  description:
    'One operation on the map: addNode {id, kind, label, file, takes, returns, note}, removeNode {id}, updateNode {id, ...}, ' +
    'addEdge {from, to, kind, label}, removeEdge {from, to}, rerouteEdge {from, to, newFrom?, newTo?}, addBranch {from, when, to}, annotate {target, note}.',
  properties: {
    op: { type: 'string', enum: ['addNode', 'removeNode', 'updateNode', 'addEdge', 'removeEdge', 'rerouteEdge', 'addBranch', 'annotate'] },
    quote: {
      type: 'string',
      description:
        "The engineer's own words that this operation transcribes, verbatim. Without a quote the operation is only a suggestion the engineer must accept in the editor.",
    },
  },
  required: ['op'],
  additionalProperties: true,
}

const modelSchema = {
  type: 'object',
  description:
    'A system model: {version: 1, commit, nodes: [{id, label, kind, level?, parent?, source: {file, lines: [first, last]}, external?, detail?, note?}], ' +
    "edges: [{from, to, kind, confidence: 'read'|'inferred', evidence?: {file, line, endLine?, snippet?}, when?, label?, note?}], " +
    'flows: [{id, entry, entryNode, steps: [{edge, title, note?}]}]}. See schemas/model.schema.json in the plugin.',
  properties: {
    version: { const: 1 },
    commit: { type: 'string' },
    nodes: { type: 'array', items: { type: 'object' } },
    edges: { type: 'array', items: { type: 'object' } },
    flows: { type: 'array', items: { type: 'object' } },
  },
  required: ['version', 'commit', 'nodes', 'edges', 'flows'],
}

const json = (value: unknown) => JSON.stringify(value, null, 2)

export const TOOLS: ToolDef[] = [
  {
    name: 'status',
    description:
      'Where the System Editor process stands: the stage, the active change, open blocking questions, whether the model is stale, and the editor URL. Call it first.',
    inputSchema: obj({}),
    run: ({}, { app }) => {
      const s = app.status()
      return { text: json(s), data: s }
    },
  },
  {
    name: 'save_model',
    description:
      'Validate and save the system model to .sysedit/model.json. Every node needs a source file and line range (unless external), and every edge read from code needs ' +
      'evidence (file and line); anything guessed from config, dynamic dispatch or an event bus must be confidence "inferred" with a note saying how. ' +
      'An invalid model is not saved; fix the errors and call again. Set merge: true when saving one entry point\'s slice into an existing model.',
    inputSchema: obj({ model: modelSchema, merge: { type: 'boolean' } }, ['model']),
    run: ({ model, merge }, { app }) => {
      const { report, stats } = app.saveModel(model as SystemModel, { merge: !!merge })
      return {
        text: `${report.ok ? 'Saved.' : 'Not saved.'} ${stats.nodes} nodes, ${stats.edges} edges (${stats.inferred} inferred), ${stats.flows} flows.\n${formatReport(report)}`,
        data: { report, stats },
        isError: !report.ok,
      }
    },
  },
  {
    name: 'validate_model',
    description: 'Check .sysedit/model.json against the files on disk: every source and evidence line must exist.',
    inputSchema: obj({}),
    run: ({}, { app }) => {
      const report = app.validate()
      return { text: formatReport(report), data: report, isError: !report.ok }
    },
  },
  {
    name: 'get_model',
    description: 'Read the system model, optionally one flow and one detail level (services, modules, functions).',
    inputSchema: obj({ flow: { type: 'string' }, level: { type: 'string', enum: [...LEVELS] } }),
    run: ({ flow, level }, { app }) => {
      const model = app.getModel({ flow, level: level as Level | undefined })
      return { text: json(model), data: model }
    },
  },
  {
    name: 'start_change',
    description:
      'Start a change set for the engineer\'s request, after the map is saved. Writes are then held outside .sysedit/ until the engineer has drawn the change, ' +
      'answered the blocking questions and approved it. Give the request verbatim and a short title.',
    inputSchema: obj(
      {
        title: { type: 'string' },
        request: { type: 'string', description: "The engineer's request, verbatim." },
        flow: { type: 'string', description: 'The flow the change will be drawn on.' },
        risk: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      ['title', 'request'],
    ),
    run: ({ title, request, flow, risk }, { app }) => {
      const cs = app.startChange({ title, request, flow, risk })
      return { text: `Started change ${cs.id} (${cs.risk} risk). Now ask the engineer to draw it: call open_editor.`, data: cs }
    },
  },
  {
    name: 'get_change',
    description:
      'Read the active change set: the engineer\'s intent, the operations they drew, the proposed model with what was added and removed, the files it touches, questions and answers, and what still blocks approval.',
    inputSchema: obj({ id: { type: 'string' } }),
    run: ({ id }, { app }) => {
      const c = app.getChange(id)
      return { text: json(c), data: c }
    },
  },
  {
    name: 'propose_ops',
    description:
      'Add operations to the map that the ENGINEER stated in chat, transcribed with their verbatim words in `quote`. Never invent the design: an operation without a quote ' +
      'is recorded as Claude\'s suggestion, shown dashed in the editor, and blocks approval until the engineer accepts or removes it.',
    inputSchema: obj({ ops: { type: 'array', items: opSchema } }, ['ops']),
    run: ({ ops }, { app }) => {
      const cs = app.transcribeOps(ops as Op[])
      const suggested = cs.ops.filter(o => o.by === 'claude').length
      return {
        text: `The map has ${cs.ops.length} operation(s)${suggested ? `, ${suggested} of them suggestions the engineer must accept` : ''}.`,
        data: cs,
      }
    },
  },
  {
    name: 'set_intent',
    description: "Record what the engineer is trying to do, in the engineer's words. Ask them; don't write it for them.",
    inputSchema: obj({ intent: { type: 'string' } }, ['intent']),
    run: ({ intent }, { app }) => ({ text: 'Intent recorded.', data: app.setIntent(intent) }),
  },
  {
    name: 'submit_change',
    description: 'Submit the drawn change for review (usually the engineer does this from the editor). Needs an intent and at least one operation.',
    inputSchema: obj({}),
    run: ({}, { app }) => ({ text: 'Submitted for review. Run the grill: /sysedit:grill.', data: app.submit() }),
  },
  {
    name: 'add_questions',
    description:
      'Ask the engineer questions about their change (the grill). Each question needs `evidence`: the file and line(s) of the code that prompted it; a question without evidence ' +
      'is dropped. severity is "blocking" only for a real risk the change does not address (rare); otherwise "worth-checking". Give 2–4 answer `options` where you can, each with ' +
      'the map `ops` that picking it applies and an `effect` sentence. category: intent, failure-mode, timeout, consistency, idempotency, retries, events, security, data, other.',
    inputSchema: obj(
      {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              severity: { type: 'string', enum: ['blocking', 'worth-checking'] },
              category: { type: 'string' },
              target: { type: 'string', description: 'The node or edge, as the map labels it.' },
              headline: { type: 'string' },
              question: { type: 'string' },
              evidence: { type: 'array', items: evidenceSchema, minItems: 1 },
              checked: { type: 'array', items: { type: 'string' } },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    effect: { type: 'string' },
                    ops: { type: 'array', items: opSchema },
                  },
                  required: ['id', 'label'],
                },
              },
            },
            required: ['severity', 'category', 'target', 'question', 'evidence'],
          },
        },
      },
      ['questions'],
    ),
    run: ({ questions }, { app }) => {
      const r = app.addQuestions(questions as Partial<Question>[])
      return {
        text:
          `Asked ${r.accepted.length} question(s); ${r.openBlocking} blocking open.` +
          (r.dropped.length ? `\nDropped:\n${r.dropped.map(d => `  ${d.id}: ${d.reason}`).join('\n')}` : ''),
        data: r,
      }
    },
  },
  {
    name: 'record_answer',
    description:
      "Record the ENGINEER's answer to a question: the option they picked, or their own words in `text`. `quote` is required: the engineer's words that give " +
      'this answer, verbatim from what they typed (a word or two is enough, such as "q2 b"). Never answer for them, even when they ask you to; ' +
      'instead give each open question in one line with lettered options so they can answer in seconds, or point them to /sysedit:skip. ' +
      '`ops` adds map changes their answer implies.',
    inputSchema: obj(
      {
        questionId: { type: 'string' },
        optionId: { type: 'string' },
        text: { type: 'string', description: "The engineer's answer, in their words." },
        quote: { type: 'string', description: 'What the engineer typed that gives this answer, verbatim.' },
        ops: { type: 'array', items: opSchema },
      },
      ['questionId', 'quote'],
    ),
    run: ({ questionId, optionId, text, ops, quote }, { app }) => {
      if (typeof quote !== 'string' || quote.trim().length === 0) {
        return { text: "Not recorded: `quote` must hold the engineer's own words for this answer. If they haven't answered, ask them.", isError: true }
      }
      const cs = app.answer({ questionId, optionId, text, ops, quote })
      const open = cs.questions.filter(q => q.severity === 'blocking' && q.status === 'open').length
      return { text: `Recorded. ${open} blocking question(s) still open.`, data: cs }
    },
  },
  {
    name: 'rate_question',
    description: 'Record whether the engineer found a question useful or noise; noisy rubric items get cut.',
    inputSchema: obj({ questionId: { type: 'string' }, rating: { type: 'string', enum: ['useful', 'noise'] } }, ['questionId', 'rating']),
    run: ({ questionId, rating }, { app }) => ({ text: 'Rated.', data: app.rate(questionId, rating) }),
  },
  {
    name: 'approve_change',
    description:
      'Approve the change once the engineer says so. `quote` is required: their words approving it, verbatim ("approve it", "yes, go ahead"). ' +
      'Refused while a blocking question is open or a suggested operation is unaccepted. After approval, writes the map covers are allowed.',
    inputSchema: obj({ quote: { type: 'string', description: 'What the engineer typed to approve, verbatim.' } }, ['quote']),
    run: ({ quote }, { app }) => {
      if (typeof quote !== 'string' || quote.trim().length === 0) {
        return { text: "Not approved: `quote` must hold the engineer's words approving the change. Ask them whether to approve.", isError: true }
      }
      return { text: 'Approved. Plan it with /sysedit:plan.', data: app.approve(quote) }
    },
  },
  {
    name: 'save_plan',
    description:
      'Save the implementation plan for the approved change: one task per operation or group of operations. Each task lists `ops` (indexes into the change set\'s ops) and `files`. ' +
      'Every operation must be covered and no task may build anything that is not on the map; a plan that breaks either rule is refused.',
    inputSchema: obj(
      {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              ops: { type: 'array', items: { type: 'integer', minimum: 0 } },
              files: { type: 'array', items: { type: 'string' } },
              answers: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'title', 'ops', 'files'],
          },
        },
      },
      ['tasks'],
    ),
    run: ({ tasks }, { app }) => ({ text: 'Plan saved.', data: app.savePlan(tasks as PlanTask[]) }),
  },
  {
    name: 'mark_implemented',
    description: 'Mark the approved change as built, before verifying it.',
    inputSchema: obj({}),
    run: ({}, { app }) => ({ text: 'Marked implemented. Verify it with /sysedit:verify.', data: app.markImplemented() }),
  },
  {
    name: 'verify_change',
    description:
      'Compare the built code with the approved map. Pass `actual`, a model re-mapped from the changed code (same ids for unchanged nodes, the drawn ids for new ones); ' +
      'without it the saved model is used. Reports edges drawn but not built, edges built but not drawn, and edges removed on the map but still in the code.',
    inputSchema: obj({ actual: modelSchema }),
    run: ({ actual }, { app }) => {
      const drift = app.verify(actual as SystemModel | undefined)
      return { text: formatDrift(drift), data: drift, isError: false }
    },
  },
  {
    name: 'set_adr',
    description: 'Record the path of the decision record written for the change.',
    inputSchema: obj({ path: { type: 'string' } }, ['path']),
    run: ({ path }, { app }) => ({ text: 'Recorded.', data: app.setAdr(path) }),
  },
  {
    name: 'skip_change',
    description:
      "Skip the process for a change too small to need it, when the ENGINEER asks to. `reason` is the engineer's reason and `quote` their words asking to skip, verbatim. " +
      'Never skip on your own initiative. The skip is logged (the skip rate is a tracked metric) and writes are let through.',
    inputSchema: obj(
      {
        reason: { type: 'string' },
        quote: { type: 'string', description: 'What the engineer typed asking to skip, verbatim.' },
        title: { type: 'string' },
      },
      ['reason', 'quote'],
    ),
    run: ({ reason, title, quote }, { app }) => {
      if (typeof quote !== 'string' || quote.trim().length === 0) {
        return { text: "Not skipped: `quote` must hold the engineer's words asking to skip. Skipping is their call.", isError: true }
      }
      const r = app.skip(reason, { title })
      return { text: r.change ? `Skipped ${r.change.id}; reason logged.` : 'Skip logged; no change was in progress.', data: r }
    },
  },
  {
    name: 'close_change',
    description: 'Clear the active change once it is verified or skipped.',
    inputSchema: obj({}),
    run: ({}, { app }) => {
      app.closeChange()
      return { text: 'No change is active now.' }
    },
  },
  {
    name: 'open_editor',
    description:
      'Start the System Editor on localhost and return its URL, for the engineer to trace the flow, draw the change and answer questions. Give the engineer the URL.',
    inputSchema: obj({}),
    run: async ({}, { app, openEditor }) => {
      const server = await openEditor()
      app.store.writeState({ editorUrl: server.url })
      return { text: `System Editor: ${server.url}`, data: { url: server.url } }
    },
  },
  {
    name: 'render_mermaid',
    description: 'Render the model, one flow, or the proposed change as a Mermaid flowchart, for a terminal, PR or ADR.',
    inputSchema: obj({ flow: { type: 'string' }, proposed: { type: 'boolean' } }),
    run: ({ flow, proposed }, { app }) => {
      const text = app.mermaid({ flow, proposed })
      return { text, data: { mermaid: text } }
    },
  },
  {
    name: 'record_explain_back',
    description:
      'Record an explain-back check: the engineer explained a flow without the tool, and you scored the share of its steps they got right (0 to 1) and listed what they missed.',
    inputSchema: obj(
      {
        flow: { type: 'string' },
        change: { type: 'string' },
        score: { type: 'number', minimum: 0, maximum: 1 },
        missed: { type: 'array', items: { type: 'string' } },
      },
      ['flow', 'score', 'missed'],
    ),
    run: ({ flow, change, score, missed }, { app }) => {
      const r = app.explainBack({ flow, change, score, missed })
      return { text: `Recorded explain-back for ${flow}: ${Math.round(r.score * 100)}%.`, data: r }
    },
  },
  {
    name: 'get_metrics',
    description: 'The process metrics: time to submit, time in review, grill hit rate, drift caught, skip rate, explain-back scores.',
    inputSchema: obj({}),
    run: ({}, { app }) => {
      const m = app.metrics()
      return { text: formatMetrics(m), data: m }
    },
  },
]
