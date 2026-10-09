// The change set: what the engineer drew, as operations against the model,
// plus Claude's questions and the engineer's answers. It is the contract
// Claude plans, builds and verifies against.
//
// Pure: no Node, no DOM.

import {
  edgeId,
  indexModel,
  type EdgeKind,
  type Evidence,
  type ModelEdge,
  type ModelNode,
  type NodeKind,
  type SystemModel,
} from './model.ts'

/** Who put an operation on the map. Only the engineer's count toward approval. */
export type Author = 'engineer' | 'claude'

type OpBase = {
  by?: Author
  /** When Claude transcribed the op from the engineer's words, those words. */
  quote?: string
}

export type Op = OpBase &
  (
    | {
        op: 'addNode'
        id: string
        kind: NodeKind
        label?: string
        file?: string
        takes?: string
        returns?: string
        detail?: string
        note?: string
        external?: boolean
      }
    | { op: 'removeNode'; id: string }
    | { op: 'updateNode'; id: string; label?: string; file?: string; takes?: string; returns?: string; note?: string }
    | { op: 'addEdge'; from: string; to: string; kind?: EdgeKind; label?: string; note?: string }
    | { op: 'removeEdge'; from: string; to: string }
    | { op: 'rerouteEdge'; from: string; to: string; newFrom?: string; newTo?: string }
    | { op: 'addBranch'; from: string; when: string; to: string }
    | { op: 'annotate'; target: string; note: string }
  )

export type OpName = Op['op']

export const OP_NAMES: readonly OpName[] = [
  'addNode',
  'removeNode',
  'updateNode',
  'addEdge',
  'removeEdge',
  'rerouteEdge',
  'addBranch',
  'annotate',
]

export type Severity = 'blocking' | 'worth-checking'

export type QuestionCategory =
  | 'intent'
  | 'failure-mode'
  | 'timeout'
  | 'consistency'
  | 'idempotency'
  | 'retries'
  | 'events'
  | 'security'
  | 'data'
  | 'other'

export const QUESTION_CATEGORIES: readonly QuestionCategory[] = [
  'intent',
  'failure-mode',
  'timeout',
  'consistency',
  'idempotency',
  'retries',
  'events',
  'security',
  'data',
  'other',
]

export type AnswerOption = {
  id: string
  label: string
  /** Map operations that picking this option applies, so an answer can redraw the map. */
  ops?: Op[]
  /** What Claude will record, shown after the pick: "Map updated: timeout branch → OrderHold.create." */
  effect?: string
}

export type Answer = {
  optionId?: string
  text?: string
  at: string
  /** True when the answer changed the map. Feeds the grill hit-rate metric. */
  changedMap?: boolean
  /** The engineer's words, when Claude recorded the answer from chat. Absent for answers given in the editor. */
  quote?: string
}

export type Question = {
  id: string
  severity: Severity
  category: QuestionCategory
  /** The node or edge the question is about, as the map labels it. */
  target: string
  /** A one-line headline for the evidence pane: "FraudService adds a network call inside a 3 s budget". */
  headline?: string
  question: string
  /** The code that prompted the question. Required: a question with no evidence is dropped. */
  evidence: Evidence[]
  /** What Claude looked at to ask it: "3 callers of placeOrder; only /checkout is user-facing". */
  checked?: string[]
  options?: AnswerOption[]
  status: 'open' | 'answered' | 'dismissed'
  answer?: Answer
  /** The engineer's rating, for tuning the rubric. */
  rating?: 'useful' | 'noise'
}

export type ChangeStatus = 'draft' | 'in-review' | 'approved' | 'implemented' | 'verified' | 'skipped'

export type Risk = 'low' | 'medium' | 'high'

export type PlanTask = {
  id: string
  title: string
  /** Indexes into `ops`: the operations this task builds. Every task names at least one. */
  ops: number[]
  files: string[]
  /** Question ids whose answers this task honours. */
  answers?: string[]
  done?: boolean
}

export type DriftReport = {
  ok: boolean
  checkedAt: string
  commit?: string
  /** Edges the engineer drew that the code does not have. */
  missing: string[]
  /** Edges in the code, among the nodes the change touched, that nobody drew. */
  unexpected: string[]
  /** Edges the engineer removed that the code still has. */
  stillPresent: string[]
  /** Nodes the engineer added that the code does not have. */
  missingNodes: string[]
}

export type HistoryEntry = { at: string; event: string; detail?: string }

export type ChangeSet = {
  id: string
  title: string
  /** The commit of the model the change was drawn on. */
  base: string
  /** The request as the engineer first typed it. */
  request: string
  /** What the engineer is trying to do, in their words. */
  intent: string
  /** The flow the change was drawn on, when it was drawn on one. */
  flow?: string
  ops: Op[]
  questions: Question[]
  status: ChangeStatus
  risk?: Risk
  plan?: PlanTask[]
  drift?: DriftReport
  adr?: string
  skipReason?: string
  createdAt: string
  updatedAt: string
  history: HistoryEntry[]
}

export function newChangeSet(args: {
  id: string
  title: string
  base: string
  request: string
  flow?: string
  risk?: Risk
  now: string
}): ChangeSet {
  return {
    id: args.id,
    title: args.title,
    base: args.base,
    request: args.request,
    intent: '',
    flow: args.flow,
    ops: [],
    questions: [],
    status: 'draft',
    risk: args.risk,
    createdAt: args.now,
    updatedAt: args.now,
    history: [{ at: args.now, event: 'created', detail: args.request }],
  }
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'change'
  )
}

// ---------------------------------------------------------------------------
// Applying operations

export type Mark = 'added' | 'removed' | 'modified'

export type ProposedNode = ModelNode & { mark?: Mark; takes?: string; returns?: string; file?: string }
export type ProposedEdge = ModelEdge & { mark?: Mark; was?: string }

export type ProposedModel = Omit<SystemModel, 'nodes' | 'edges'> & {
  nodes: ProposedNode[]
  edges: ProposedEdge[]
  /** Notes the engineer attached for things boxes and arrows can't express. */
  annotations: { target: string; note: string }[]
  /** Operations that could not apply, such as removing an edge that isn't there. */
  conflicts: { index: number; message: string }[]
}

/**
 * The model as it will be once the change is built. Removed nodes and edges
 * stay in the result, marked `removed`, so the editor can draw them struck
 * through; `afterOnly` drops them.
 */
export function applyOps(model: SystemModel, ops: readonly Op[]): ProposedModel {
  const nodes = new Map<string, ProposedNode>(model.nodes.map(n => [n.id, { ...n }]))
  const edges = new Map<string, ProposedEdge>(model.edges.map(e => [edgeId(e), { ...e }]))
  const annotations: { target: string; note: string }[] = []
  const conflicts: { index: number; message: string }[] = []
  const findEdge = (from: string, to: string) =>
    [...edges.values()].find(e => e.from === from && e.to === to && e.mark !== 'removed')
  const needNode = (index: number, id: string) => {
    const n = nodes.get(id)
    if (!n || n.mark === 'removed') {
      conflicts.push({ index, message: `no node "${id}" on the map` })
      return false
    }
    return true
  }

  ops.forEach((op, index) => {
    switch (op.op) {
      case 'addNode': {
        if (nodes.has(op.id) && nodes.get(op.id)!.mark !== 'removed') {
          conflicts.push({ index, message: `node "${op.id}" is already on the map` })
          return
        }
        nodes.set(op.id, {
          id: op.id,
          label: op.label ?? op.id,
          kind: op.kind,
          external: op.external,
          detail: op.detail ?? (op.file ? `NEW · ${op.file}` : 'NEW'),
          note: op.note,
          takes: op.takes,
          returns: op.returns,
          file: op.file,
          mark: 'added',
        })
        return
      }
      case 'removeNode': {
        if (!needNode(index, op.id)) return
        nodes.get(op.id)!.mark = 'removed'
        for (const e of edges.values()) {
          if (e.from === op.id || e.to === op.id) e.mark = 'removed'
        }
        return
      }
      case 'updateNode': {
        if (!needNode(index, op.id)) return
        const n = nodes.get(op.id)!
        Object.assign(n, {
          ...(op.label !== undefined && { label: op.label }),
          ...(op.file !== undefined && { file: op.file }),
          ...(op.takes !== undefined && { takes: op.takes }),
          ...(op.returns !== undefined && { returns: op.returns }),
          ...(op.note !== undefined && { note: op.note }),
        })
        if (n.mark !== 'added') n.mark = 'modified'
        return
      }
      case 'addEdge':
      case 'addBranch': {
        if (!needNode(index, op.from) || !needNode(index, op.to)) return
        const existing = findEdge(op.from, op.to)
        if (existing && op.op === 'addEdge') {
          conflicts.push({ index, message: `${op.from} → ${op.to} is already on the map` })
          return
        }
        const when = op.op === 'addBranch' ? op.when : undefined
        const id = edges.has(`${op.from}->${op.to}`) || existing ? `${op.from}->${op.to}#${index}` : undefined
        const edge: ProposedEdge = {
          ...(id && { id }),
          from: op.from,
          to: op.to,
          kind: op.op === 'addBranch' ? 'branch' : (op.kind ?? 'call'),
          confidence: 'read',
          when,
          label: op.op === 'addEdge' ? op.label : when,
          note: op.op === 'addEdge' ? op.note : undefined,
          mark: 'added',
        }
        edges.set(edgeId(edge), edge)
        return
      }
      case 'removeEdge': {
        const e = findEdge(op.from, op.to)
        if (!e) {
          conflicts.push({ index, message: `no edge ${op.from} → ${op.to} on the map` })
          return
        }
        if (e.mark === 'added') edges.delete(edgeId(e))
        else e.mark = 'removed'
        return
      }
      case 'rerouteEdge': {
        const e = findEdge(op.from, op.to)
        if (!e) {
          conflicts.push({ index, message: `no edge ${op.from} → ${op.to} to reroute` })
          return
        }
        const from = op.newFrom ?? op.from
        const to = op.newTo ?? op.to
        if (!needNode(index, from) || !needNode(index, to)) return
        if (e.mark === 'added') {
          edges.delete(edgeId(e))
        } else {
          e.mark = 'removed'
        }
        const next: ProposedEdge = {
          ...e,
          id: undefined,
          from,
          to,
          evidence: undefined,
          confidence: 'read',
          mark: 'added',
          was: `${op.from}->${op.to}`,
        }
        const key = edgeId(next)
        if (edges.has(key)) next.id = `${key}#${index}`
        edges.set(edgeId(next), next)
        return
      }
      case 'annotate': {
        annotations.push({ target: op.target, note: op.note })
        return
      }
    }
  })

  return {
    ...model,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    annotations,
    conflicts,
  }
}

/** The proposed model with removed parts dropped and the marks cleared: what the code should look like. */
export function afterOnly(proposed: ProposedModel): SystemModel {
  const edges = proposed.edges.filter(e => e.mark !== 'removed').map(({ mark, was, ...e }) => e)
  const kept = new Set(edges.map(edgeId))
  return {
    version: 1,
    commit: proposed.commit,
    repo: proposed.repo,
    nodes: proposed.nodes.filter(n => n.mark !== 'removed').map(({ mark, takes, returns, file, ...n }) => n),
    edges,
    // A flow keeps the steps whose edges survive; the re-map writes the new path.
    flows: proposed.flows.map(f => ({ ...f, steps: f.steps.filter(s => kept.has(s.edge)) })),
  }
}

/** One readable line per operation, as the editor's "Your changes" list shows it. */
export function describeOp(op: Op, labels?: Map<string, string>): { sign: '+' | '−' | '~' | '•'; text: string } {
  const l = (id: string) => labels?.get(id) ?? id
  switch (op.op) {
    case 'addNode':
      return { sign: '+', text: `New ${op.kind} ${op.label ?? op.id}` }
    case 'removeNode':
      return { sign: '−', text: `Remove ${l(op.id)}` }
    case 'updateNode':
      return { sign: '~', text: `Change ${l(op.id)}` }
    case 'addEdge':
      return { sign: '+', text: `${l(op.from)} → ${l(op.to)}` }
    case 'removeEdge':
      return { sign: '−', text: `${l(op.from)} → ${l(op.to)}` }
    case 'rerouteEdge':
      return {
        sign: '~',
        text: `${l(op.newFrom ?? op.from)} → ${l(op.newTo ?? op.to)}, was ${l(op.from)} → ${l(op.to)}`,
      }
    case 'addBranch':
      return { sign: '+', text: `Branch ${op.when} → ${l(op.to)}` }
    case 'annotate':
      return { sign: '•', text: `Note on ${l(op.target)}: ${op.note}` }
  }
}

/** Every file the change set touches: new nodes' files and the source of every node it names. */
export function touchedFiles(model: SystemModel, cs: Pick<ChangeSet, 'ops'>): string[] {
  const { nodes } = indexModel(model)
  const files = new Set<string>()
  const add = (id: string) => {
    const n = nodes.get(id)
    if (n?.source?.file) files.add(n.source.file)
  }
  for (const op of cs.ops) {
    switch (op.op) {
      case 'addNode':
        if (op.file) files.add(op.file)
        break
      case 'removeNode':
      case 'updateNode':
        add(op.id)
        if (op.op === 'updateNode' && op.file) files.add(op.file)
        break
      case 'addEdge':
      case 'removeEdge':
      case 'addBranch':
        add(op.from)
        break
      case 'rerouteEdge':
        add(op.from)
        add(op.newFrom ?? op.from)
        break
      case 'annotate':
        break
    }
  }
  // An edge from a new node lives in the new node's file, which addNode already added.
  return [...files].sort()
}

/** The ids of every node the change set touches, for scoping the drift check. */
export function touchedNodes(cs: Pick<ChangeSet, 'ops'>): string[] {
  const ids = new Set<string>()
  for (const op of cs.ops) {
    switch (op.op) {
      case 'addNode':
      case 'removeNode':
      case 'updateNode':
        ids.add(op.id)
        break
      case 'addEdge':
      case 'removeEdge':
      case 'addBranch':
        ids.add(op.from)
        ids.add(op.to)
        break
      case 'rerouteEdge':
        ids.add(op.from)
        ids.add(op.to)
        if (op.newFrom) ids.add(op.newFrom)
        if (op.newTo) ids.add(op.newTo)
        break
      case 'annotate':
        break
    }
  }
  return [...ids]
}

// ---------------------------------------------------------------------------
// Questions

export function openBlocking(cs: Pick<ChangeSet, 'questions'>): Question[] {
  return cs.questions.filter(q => q.severity === 'blocking' && q.status === 'open')
}

export type QuestionCheck = { accepted: Question[]; dropped: { id: string; reason: string }[] }

/**
 * Admit questions under the rule "questions earn their place": a question
 * with no evidence is dropped, and so is one whose wording repeats another.
 */
export function admitQuestions(existing: readonly Question[], incoming: readonly Partial<Question>[]): QuestionCheck {
  const accepted: Question[] = []
  const dropped: { id: string; reason: string }[] = []
  const seen = new Set(existing.map(q => normalise(q.question)))
  const ids = new Set(existing.map(q => q.id))
  incoming.forEach((q, i) => {
    const id = q.id ?? `q${existing.length + accepted.length + 1}`
    if (!q.question || q.question.trim().length < 10) {
      dropped.push({ id, reason: 'the question is empty or too short to answer' })
      return
    }
    if (!Array.isArray(q.evidence) || q.evidence.length === 0) {
      dropped.push({ id, reason: 'no evidence: every question must cite the code that prompted it' })
      return
    }
    if (q.evidence.some(e => !e || typeof e.file !== 'string' || !Number.isInteger(e.line))) {
      dropped.push({ id, reason: 'each piece of evidence needs a file and a line' })
      return
    }
    const key = normalise(q.question)
    if (seen.has(key)) {
      dropped.push({ id, reason: 'repeats an earlier question' })
      return
    }
    if (ids.has(id)) {
      dropped.push({ id, reason: `id "${id}" is taken` })
      return
    }
    seen.add(key)
    ids.add(id)
    accepted.push({
      id,
      severity: q.severity === 'blocking' ? 'blocking' : 'worth-checking',
      category: QUESTION_CATEGORIES.includes(q.category as QuestionCategory) ? (q.category as QuestionCategory) : 'other',
      target: q.target ?? '',
      headline: q.headline,
      question: q.question.trim(),
      evidence: q.evidence,
      checked: q.checked,
      options: q.options,
      status: 'open',
    })
    void i
  })
  return { accepted, dropped }
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// Transitions. Each returns a new change set or a reason it can't.

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string }

const fail = <T>(reason: string): Result<T> => ({ ok: false, reason })
const done = <T>(value: T): Result<T> => ({ ok: true, value })

function touch(cs: ChangeSet, now: string, event: string, detail?: string): ChangeSet {
  return { ...cs, updatedAt: now, history: [...cs.history, { at: now, event, ...(detail && { detail }) }] }
}

export function setOps(cs: ChangeSet, ops: Op[], now: string, by: Author): Result<ChangeSet> {
  if (cs.status !== 'draft' && cs.status !== 'in-review') {
    return fail(`the change is ${cs.status}; the map can only change while it is a draft or in review`)
  }
  const stamped = ops.map(op => ({ ...op, by: op.by ?? by }))
  return done(touch({ ...cs, ops: stamped }, now, 'map-edited', `${ops.length} operation(s) by ${by}`))
}

/**
 * Add operations Claude transcribed. Without the engineer's own words as
 * `quote`, they go on the map as suggestions the engineer must accept.
 */
export function addTranscribedOps(cs: ChangeSet, ops: Op[], now: string): Result<ChangeSet> {
  if (cs.status !== 'draft' && cs.status !== 'in-review') {
    return fail(`the change is ${cs.status}; the map can only change while it is a draft or in review`)
  }
  const stamped = ops.map(op => ({ ...op, by: (op.quote && op.quote.trim().length > 0 ? 'engineer' : 'claude') as Author }))
  return done(touch({ ...cs, ops: [...cs.ops, ...stamped] }, now, 'map-edited', `${ops.length} operation(s) transcribed`))
}

export function acceptOp(cs: ChangeSet, index: number, now: string): Result<ChangeSet> {
  const op = cs.ops[index]
  if (!op) return fail(`no operation ${index}`)
  const ops = cs.ops.map((o, i) => (i === index ? { ...o, by: 'engineer' as Author } : o))
  return done(touch({ ...cs, ops }, now, 'op-accepted', String(index)))
}

export function suggestedOps(cs: Pick<ChangeSet, 'ops'>): number[] {
  return cs.ops.flatMap((op, i) => (op.by === 'claude' ? [i] : []))
}

export function setIntent(cs: ChangeSet, intent: string, now: string): Result<ChangeSet> {
  return done(touch({ ...cs, intent }, now, 'intent'))
}

export function submit(cs: ChangeSet, now: string): Result<ChangeSet> {
  if (cs.status !== 'draft') return fail(`the change is already ${cs.status}`)
  if (cs.intent.trim().length < 10) {
    return fail('say what you are trying to do, in a sentence, before Claude reviews the change')
  }
  if (cs.ops.length === 0) return fail('draw the change on the map first: add, remove or reroute something')
  return done(touch({ ...cs, status: 'in-review' }, now, 'submitted'))
}

export function addQuestions(cs: ChangeSet, incoming: Partial<Question>[], now: string): Result<{ cs: ChangeSet; check: QuestionCheck }> {
  if (cs.status !== 'in-review') return fail(`questions are asked while the change is in review; it is ${cs.status}`)
  const check = admitQuestions(cs.questions, incoming)
  const next = touch({ ...cs, questions: [...cs.questions, ...check.accepted] }, now, 'questions', `${check.accepted.length} asked, ${check.dropped.length} dropped`)
  return done({ cs: next, check })
}

export function answerQuestion(
  cs: ChangeSet,
  args: { questionId: string; optionId?: string; text?: string; ops?: Op[]; quote?: string },
  now: string,
): Result<ChangeSet> {
  if (cs.status !== 'in-review') return fail(`answers are recorded while the change is in review; it is ${cs.status}`)
  const q = cs.questions.find(x => x.id === args.questionId)
  if (!q) return fail(`no question "${args.questionId}"`)
  const option = args.optionId ? q.options?.find(o => o.id === args.optionId) : undefined
  if (args.optionId && !option) return fail(`question ${q.id} has no option "${args.optionId}"`)
  const text = args.text?.trim()
  if (!option && !text) return fail('pick an option or answer in your own words')
  const mapOps = [...(option?.ops ?? []), ...(args.ops ?? [])].map(op => ({ ...op, by: 'engineer' as Author }))
  const answer: Answer = {
    ...(option && { optionId: option.id }),
    ...(text && { text }),
    at: now,
    changedMap: mapOps.length > 0,
    ...(args.quote && { quote: args.quote }),
  }
  const questions = cs.questions.map(x => (x.id === q.id ? { ...x, status: 'answered' as const, answer } : x))
  return done(touch({ ...cs, questions, ops: [...cs.ops, ...mapOps] }, now, 'answered', q.id))
}

export function rateQuestion(cs: ChangeSet, questionId: string, rating: 'useful' | 'noise', now: string): Result<ChangeSet> {
  const q = cs.questions.find(x => x.id === questionId)
  if (!q) return fail(`no question "${questionId}"`)
  const questions = cs.questions.map(x => (x.id === questionId ? { ...x, rating } : x))
  return done(touch({ ...cs, questions }, now, 'rated', `${questionId}:${rating}`))
}

export function dismissQuestion(cs: ChangeSet, questionId: string, now: string): Result<ChangeSet> {
  const q = cs.questions.find(x => x.id === questionId)
  if (!q) return fail(`no question "${questionId}"`)
  if (q.severity === 'blocking') return fail('a blocking question has to be answered, not dismissed')
  const questions = cs.questions.map(x => (x.id === questionId ? { ...x, status: 'dismissed' as const } : x))
  return done(touch({ ...cs, questions }, now, 'dismissed', questionId))
}

/** Why the change can't be approved yet, or nothing when it can. */
export function approvalBlockers(cs: ChangeSet): string[] {
  const out: string[] = []
  if (cs.status !== 'in-review') out.push(`the change is ${cs.status}, not in review`)
  const open = openBlocking(cs)
  if (open.length > 0) {
    out.push(`answer ${open.length} more blocking question${open.length === 1 ? '' : 's'} first (${open.map(q => q.id).join(', ')})`)
  }
  const suggested = suggestedOps(cs)
  if (suggested.length > 0) {
    out.push(`${suggested.length} operation(s) on the map were suggested by Claude; the engineer has to accept or remove them`)
  }
  if (cs.ops.length === 0) out.push('the map has no changes')
  return out
}

export function approve(cs: ChangeSet, now: string, quote?: string): Result<ChangeSet> {
  const blockers = approvalBlockers(cs)
  if (blockers.length > 0) return fail(blockers.join('; '))
  return done(touch({ ...cs, status: 'approved' }, now, 'approved', quote))
}

/**
 * A plan follows the map: each task names the operations it builds, and
 * every operation is covered. Work that isn't on the map is refused.
 */
export function checkPlan(cs: Pick<ChangeSet, 'ops'>, tasks: readonly PlanTask[]): string[] {
  const problems: string[] = []
  const covered = new Set<number>()
  tasks.forEach((t, i) => {
    if (!t.title) problems.push(`task ${i + 1} needs a title`)
    if (!Array.isArray(t.ops) || t.ops.length === 0) {
      problems.push(`task "${t.title || i + 1}" builds nothing on the map; work that isn't on the map isn't planned`)
      return
    }
    for (const n of t.ops) {
      const op = cs.ops[n]
      if (!op) problems.push(`task "${t.title}" names operation ${n}, which the change set doesn't have`)
      else covered.add(n)
    }
  })
  cs.ops.forEach((op, i) => {
    if (op.op !== 'annotate' && !covered.has(i)) {
      problems.push(`operation ${i} (${describeOp(op).text}) has no task`)
    }
  })
  return problems
}

export function savePlan(cs: ChangeSet, tasks: PlanTask[], now: string): Result<ChangeSet> {
  if (cs.status !== 'approved' && cs.status !== 'implemented') {
    return fail(`a plan is made from an approved change; this one is ${cs.status}`)
  }
  const problems = checkPlan(cs, tasks)
  if (problems.length > 0) return fail(problems.join('; '))
  return done(touch({ ...cs, plan: tasks }, now, 'planned', `${tasks.length} task(s)`))
}

export function markImplemented(cs: ChangeSet, now: string): Result<ChangeSet> {
  if (cs.status !== 'approved') return fail(`only an approved change can be marked implemented; this one is ${cs.status}`)
  return done(touch({ ...cs, status: 'implemented' }, now, 'implemented'))
}

export function recordDrift(cs: ChangeSet, drift: DriftReport, now: string): Result<ChangeSet> {
  if (cs.status !== 'implemented' && cs.status !== 'approved' && cs.status !== 'verified') {
    return fail(`verify runs on an implemented change; this one is ${cs.status}`)
  }
  const status: ChangeStatus = drift.ok ? 'verified' : 'implemented'
  return done(touch({ ...cs, drift, status }, now, drift.ok ? 'verified' : 'drift', drift.ok ? undefined : `${drift.missing.length + drift.unexpected.length + drift.stillPresent.length + drift.missingNodes.length} difference(s)`))
}

export function skip(cs: ChangeSet, reason: string, now: string): Result<ChangeSet> {
  if (reason.trim().length < 5) return fail('give a reason for skipping; it is logged')
  return done(touch({ ...cs, status: 'skipped', skipReason: reason.trim() }, now, 'skipped', reason.trim()))
}
