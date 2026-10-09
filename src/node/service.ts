// The operations behind every surface: the MCP tools Claude calls, the
// editor's HTTP API, and the CLI. Each one reads the store, applies a pure
// transition from core/, and writes the result back.

import { EventEmitter } from 'node:events'

import {
  acceptOp,
  addQuestions,
  addTranscribedOps,
  answerQuestion,
  applyOps,
  approvalBlockers,
  approve,
  dismissQuestion,
  markImplemented,
  newChangeSet,
  openBlocking,
  rateQuestion,
  recordDrift,
  savePlan,
  setIntent,
  setOps,
  skip,
  slugify,
  submit,
  suggestedOps,
  touchedFiles,
  type Author,
  type ChangeSet,
  type Op,
  type PlanTask,
  type Question,
  type Result,
  type Risk,
} from '../../plugins/sysedit/core/changeset.ts'
import { checkDrift } from '../../plugins/sysedit/core/drift.ts'
import { STAGE_LABEL, stageOf } from '../../plugins/sysedit/core/gate.ts'
import { toMermaid } from '../../plugins/sysedit/core/mermaid.ts'
import { computeMetrics, type ExplainBack } from '../../plugins/sysedit/core/metrics.ts'
import { atLevel, emptyModel, flowSlice, mergeModels, modelStats, type Level, type SystemModel } from '../../plugins/sysedit/core/model.ts'
import { guessRisk } from '../../plugins/sysedit/core/risk.ts'
import { validateModel, type ValidationReport } from '../../plugins/sysedit/core/validate.ts'
import { Store } from './store.ts'

export class SyseditError extends Error {}

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new SyseditError(r.reason)
  return r.value
}

export class Sysedit extends EventEmitter {
  readonly store: Store
  private clock: () => Date

  constructor(root?: string, clock: () => Date = () => new Date()) {
    super()
    this.store = new Store(root)
    this.clock = clock
  }

  private now() {
    return this.clock().toISOString()
  }

  private changed(what: string) {
    this.emit('changed', what)
  }

  // --- status ------------------------------------------------------------

  status() {
    const model = this.store.readModel()
    const cs = this.store.activeChange()
    const stage = stageOf(cs, !!model)
    const state = this.store.readState()
    return {
      root: this.store.root,
      repo: this.store.repoName(),
      head: this.store.headCommit(),
      stage,
      stageLabel: STAGE_LABEL[stage],
      model: model ? { commit: model.commit, ...modelStats(model), stale: model.commit !== this.store.headCommit() } : null,
      change: cs
        ? {
            id: cs.id,
            title: cs.title,
            status: cs.status,
            risk: cs.risk,
            ops: cs.ops.length,
            suggestedOps: suggestedOps(cs).length,
            openBlocking: openBlocking(cs).map(q => ({ id: q.id, target: q.target, question: q.question })),
            questions: cs.questions.length,
            blockers: cs.status === 'in-review' ? approvalBlockers(cs) : [],
          }
        : null,
      editorUrl: state.editorUrl,
    }
  }

  // --- the model -----------------------------------------------------------

  saveModel(model: SystemModel, opts: { merge?: boolean } = {}): { report: ValidationReport; stats: ReturnType<typeof modelStats> } {
    const existing = this.store.readModel()
    const next = opts.merge && existing ? mergeModels(existing, model) : model
    next.generatedAt ??= this.now()
    next.repo ??= this.store.repoName()
    const report = validateModel(next, this.store.fileFacts(next))
    if (!report.ok) return { report, stats: modelStats(next) }
    this.store.writeModel(next)
    this.changed('model')
    return { report, stats: modelStats(next) }
  }

  validate(model?: SystemModel): ValidationReport {
    const m = model ?? this.store.readModel()
    if (!m) return { ok: false, errors: [{ path: '', message: 'no model yet: run /sysedit:map' }], warnings: [] }
    return validateModel(m, this.store.fileFacts(m))
  }

  getModel(opts: { flow?: string; level?: Level } = {}): SystemModel {
    let model = this.store.readModel()
    if (!model) throw new SyseditError('no model yet: run /sysedit:map first')
    if (opts.flow) model = flowSlice(model, opts.flow)
    if (opts.level) model = atLevel(model, opts.level)
    return model
  }

  // --- change sets ---------------------------------------------------------

  startChange(args: { title: string; request: string; flow?: string; risk?: Risk }): ChangeSet {
    const active = this.store.activeChange()
    if (active && !['verified', 'skipped'].includes(active.status)) {
      throw new SyseditError(
        `change "${active.title}" (${active.id}) is still ${active.status}; finish it, or skip it with a reason, before starting another`,
      )
    }
    const model = this.store.readModel()
    const n = String(this.store.nextChangeNumber()).padStart(4, '0')
    const id = `${n}-${slugify(args.title)}`
    const cs = newChangeSet({
      id,
      title: args.title,
      base: model?.commit ?? this.store.headCommit(),
      request: args.request,
      flow: args.flow,
      risk: args.risk ?? guessRisk(args.request).risk,
      now: this.now(),
    })
    this.store.writeChange(cs)
    this.store.writeState({ activeChange: id })
    this.changed('change')
    return cs
  }

  private requireActive(id?: string): ChangeSet {
    const cs = id ? this.store.readChange(id) : this.store.activeChange()
    if (!cs) throw new SyseditError(id ? `no change "${id}"` : 'no change in progress: start one with /sysedit:map')
    return cs
  }

  private save(cs: ChangeSet): ChangeSet {
    this.store.writeChange(cs)
    this.changed('change')
    return cs
  }

  getChange(id?: string) {
    const cs = this.requireActive(id)
    const model = this.store.readModel() ?? emptyModel(cs.base)
    const proposed = applyOps(model, cs.ops)
    return {
      change: cs,
      stage: stageOf(cs, true),
      proposed,
      files: touchedFiles(model, cs),
      blockers: approvalBlockers(cs),
      suggestedOps: suggestedOps(cs),
    }
  }

  /** Ops from the editor: the engineer drew them. */
  setOps(ops: Op[], by: Author = 'engineer', intent?: string): ChangeSet {
    let cs = unwrap(setOps(this.requireActive(), ops, this.now(), by))
    if (intent !== undefined) cs = unwrap(setIntent(cs, intent, this.now()))
    return this.save(cs)
  }

  /** Ops from Claude: suggestions unless they quote the engineer's own words. */
  transcribeOps(ops: Op[]): ChangeSet {
    return this.save(unwrap(addTranscribedOps(this.requireActive(), ops, this.now())))
  }

  acceptOp(index: number): ChangeSet {
    return this.save(unwrap(acceptOp(this.requireActive(), index, this.now())))
  }

  removeOp(index: number): ChangeSet {
    const cs = this.requireActive()
    if (!cs.ops[index]) throw new SyseditError(`no operation ${index}`)
    return this.save(unwrap(setOps(cs, cs.ops.filter((_, i) => i !== index), this.now(), 'engineer')))
  }

  setIntent(intent: string): ChangeSet {
    return this.save(unwrap(setIntent(this.requireActive(), intent, this.now())))
  }

  submit(): ChangeSet {
    return this.save(unwrap(submit(this.requireActive(), this.now())))
  }

  addQuestions(questions: Partial<Question>[]) {
    const { cs, check } = unwrap(addQuestions(this.requireActive(), questions, this.now()))
    this.save(cs)
    return { accepted: check.accepted.map(q => q.id), dropped: check.dropped, openBlocking: openBlocking(cs).length }
  }

  answer(args: { questionId: string; optionId?: string; text?: string; ops?: Op[] }): ChangeSet {
    return this.save(unwrap(answerQuestion(this.requireActive(), args, this.now())))
  }

  rate(questionId: string, rating: 'useful' | 'noise'): ChangeSet {
    return this.save(unwrap(rateQuestion(this.requireActive(), questionId, rating, this.now())))
  }

  dismiss(questionId: string): ChangeSet {
    return this.save(unwrap(dismissQuestion(this.requireActive(), questionId, this.now())))
  }

  approve(): ChangeSet {
    return this.save(unwrap(approve(this.requireActive(), this.now())))
  }

  savePlan(tasks: PlanTask[]): ChangeSet {
    return this.save(unwrap(savePlan(this.requireActive(), tasks, this.now())))
  }

  markImplemented(): ChangeSet {
    return this.save(unwrap(markImplemented(this.requireActive(), this.now())))
  }

  setAdr(path: string): ChangeSet {
    const cs = this.requireActive()
    return this.save({ ...cs, adr: path, updatedAt: this.now() })
  }

  /**
   * Compare a re-mapped model with the approved map. `actual` defaults to the
   * current model.json, which the verify skill refreshes before calling this.
   */
  verify(actual?: SystemModel) {
    const cs = this.requireActive()
    const base = this.store.readCachedModel(cs.base) ?? this.store.readModel()
    if (!base) throw new SyseditError('no base model to compare against')
    const current = actual ?? this.store.readModel()
    if (!current) throw new SyseditError('no re-mapped model: map the changed code first')
    if (actual) {
      const report = validateModel(actual, this.store.fileFacts(actual))
      if (!report.ok) throw new SyseditError(`the re-mapped model is invalid: ${report.errors.map(e => e.message).join('; ')}`)
    }
    const drift = checkDrift(base, cs, current, this.now())
    const next = unwrap(recordDrift(cs.status === 'approved' ? unwrap(markImplemented(cs, this.now())) : cs, drift, this.now()))
    this.save(next)
    return drift
  }

  skip(reason: string, opts: { title?: string } = {}): { change: ChangeSet | null; logged: true } {
    let cs = this.store.activeChange()
    const now = this.now()
    if (!cs || ['verified', 'skipped'].includes(cs.status)) {
      // Nothing in progress: log the skip on its own, for the skip-rate metric.
      this.store.logSkip({ at: now, reason, risk: guessRisk(opts.title ?? reason).risk })
      this.changed('skip')
      return { change: null, logged: true }
    }
    cs = this.save(unwrap(skip(cs, reason, now)))
    this.store.logSkip({ at: now, reason, change: cs.id, risk: cs.risk })
    return { change: cs, logged: true }
  }

  closeChange(): void {
    this.store.writeState({ activeChange: null })
    this.changed('change')
  }

  explainBack(entry: Omit<ExplainBack, 'at'>) {
    const score = Math.max(0, Math.min(1, entry.score))
    const record: ExplainBack = { ...entry, score, at: this.now() }
    this.store.logExplainBack(record)
    return record
  }

  metrics() {
    return computeMetrics(this.store.listChanges(), this.store.readSkips(), this.store.readExplainBacks())
  }

  mermaid(opts: { flow?: string; proposed?: boolean } = {}): string {
    const model = this.store.readModel()
    if (!model) throw new SyseditError('no model yet: run /sysedit:map first')
    if (opts.proposed) {
      const cs = this.requireActive()
      return toMermaid(applyOps(model, cs.ops), { title: cs.title })
    }
    return toMermaid(model, { flow: opts.flow })
  }
}
