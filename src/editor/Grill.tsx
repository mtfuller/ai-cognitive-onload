// 3 · Grill: Claude's questions about the engineer's change, each with the code
// that prompted it. Blocking questions hold the build until answered; the
// engineer answers by picking an option or in their own words.

import { useEffect, useState } from 'preact/hooks'

import { describeOp, type Question } from '../../plugins/sysedit/core/changeset.ts'
import type { SystemModel } from '../../plugins/sysedit/core/model.ts'
import { api, type ChangeView } from './api.ts'
import { Code } from './Code.tsx'

const CATEGORY: Record<string, string> = {
  intent: 'Intent',
  'failure-mode': 'Failure mode',
  timeout: 'Timeouts',
  consistency: 'Data consistency',
  idempotency: 'Idempotency',
  retries: 'Retries',
  events: 'Events',
  security: 'Security',
  data: 'Data',
  other: 'Other',
}

export function Grill({
  model,
  view,
  onBack,
  onTrace,
  onApproved,
}: {
  model: SystemModel
  view: ChangeView
  onBack: () => void
  onTrace: (target: string) => void
  onApproved: () => void
}) {
  const cs = view.change
  const qs = cs.questions
  const [selected, setSelected] = useState<string | null>(qs.find(q => q.status === 'open' && q.severity === 'blocking')?.id ?? qs[0]?.id ?? null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!selected && qs[0]) setSelected(qs[0].id)
  }, [qs.length])

  const labels = new Map(view.proposed.nodes.map(n => [n.id, n.label]))
  const answered = qs.filter(q => q.status !== 'open').length
  const blockingLeft = qs.filter(q => q.severity === 'blocking' && q.status === 'open').length
  const run = (p: Promise<unknown>) => p.then(() => setError(null)).catch(e => setError(String(e.message ?? e)))
  const sel = qs.find(q => q.id === selected) ?? null

  if (cs.status === 'draft') {
    return (
      <div class="empty">
        <b>Draw the change and submit it first.</b>
        <span>Claude reviews what you drew, so the questions are about your decisions.</span>
        <button type="button" class="btn" onClick={onBack}>Back to the map</button>
      </div>
    )
  }

  return (
    <div class="body">
      <aside class="left">
        <section class="stack">
          <h2 class="label">Your intent</h2>
          <p style={{ margin: 0 }}>{cs.intent || <span class="muted">Not written yet.</span>}</p>
        </section>
        <section class="stack">
          <h2 class="label">Your changes</h2>
          <ul class="changes">
            {cs.ops.map((o, i) => {
              const d = describeOp(o, labels)
              return (
                <li key={i}>
                  <b class={`sign ${d.sign === '+' ? 'add' : d.sign === '−' ? 'rem' : 'mod'}`}>{d.sign}</b>
                  <span class="mono" style={{ fontSize: '12px' }}>{d.text}</span>
                </li>
              )
            })}
          </ul>
          <button type="button" class="btn small" onClick={onBack}>Back to the map</button>
        </section>
        <section class="foot">
          <span>Your answers are saved with the change and go into its decision record.</span>
          <span class="mono" style={{ fontSize: '12px' }}>{cs.adr ?? `.sysedit/changes/${cs.id}.json`}</span>
        </section>
      </aside>

      <main class="main">
        <div class="titlebar">
          <h1>{qs.length === 0 ? 'Claude is reviewing your change' : `Claude has ${qs.length} question${qs.length === 1 ? '' : 's'} about your change`}</h1>
          <span class="muted" data-testid="grill-progress">
            {answered} of {qs.length} answered · {blockingLeft} blocking left
          </span>
        </div>
        {qs.length === 0 && (
          <div class="hint">Waiting for questions. If nothing appears, ask Claude to run <span class="mono">/sysedit:grill</span>.</div>
        )}
        {error && <div class="error">{error}</div>}
        {qs.map(q => (
          <QuestionCard
            key={q.id}
            q={q}
            selected={q.id === selected}
            open={q.severity === 'blocking' || expanded.has(q.id) || q.status !== 'open'}
            draft={drafts[q.id] ?? ''}
            onSelect={() => setSelected(q.id)}
            onExpand={() => setExpanded(new Set([...expanded, q.id]))}
            onDraft={text => setDrafts({ ...drafts, [q.id]: text })}
            onPick={optionId => run(api.answer(q.id, { optionId }))}
            onText={() => run(api.answer(q.id, { text: drafts[q.id] ?? '' }))}
            onRate={rating => run(api.rate(q.id, rating))}
            onDismiss={() => run(api.dismiss(q.id))}
          />
        ))}
        <div class="plan-bar">
          <button
            type="button"
            class="btn primary"
            disabled={cs.status !== 'in-review' || view.blockers.length > 0}
            onClick={() => run(api.approve().then(onApproved))}
          >
            Approve and generate implementation plan
          </button>
          <span class="muted" style={{ fontSize: '13px' }} data-testid="approve-hint">
            {cs.status !== 'in-review'
              ? `This change is ${cs.status}.`
              : view.blockers.length > 0
                ? view.blockers.join('; ')
                : 'The plan follows your map and answers. You review the code in the PR.'}
          </span>
        </div>
      </main>

      <aside class="right">
        {sel ? (
          <>
            <span class="label">Why Claude asked</span>
            <h2 style={{ margin: 0, fontSize: '17px', lineHeight: '24px' }}>{sel.headline ?? sel.question}</h2>
            {sel.evidence.map((e, i) => (
              <Code key={i} at={{ file: e.file, start: e.line, end: e.endLine ?? e.line, snippet: e.snippet }} />
            ))}
            {sel.checked && sel.checked.length > 0 && (
              <div class="stack" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <h3 class="label">What Claude checked</h3>
                <ul class="checked">
                  {sel.checked.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
            <button type="button" class="btn small" onClick={() => onTrace(sel.target)}>
              Trace this on the map
            </button>
          </>
        ) : (
          <span class="muted">Pick a question to see the code behind it.</span>
        )}
        {model.nodes.length === 0 && <span class="muted">No model loaded.</span>}
      </aside>
    </div>
  )
}

function QuestionCard(p: {
  q: Question
  selected: boolean
  open: boolean
  draft: string
  onSelect: () => void
  onExpand: () => void
  onDraft: (text: string) => void
  onPick: (optionId: string) => void
  onText: () => void
  onRate: (rating: 'useful' | 'noise') => void
  onDismiss: () => void
}) {
  const { q } = p
  const isOpen = q.status === 'open'
  const tag =
    q.status === 'answered'
      ? ['answered', 'Answered']
      : q.status === 'dismissed'
        ? ['dismissed', 'Dismissed']
        : q.severity === 'blocking'
          ? ['blocking', 'Blocking']
          : ['worth', 'Worth checking']
  const picked = q.options?.find(o => o.id === q.answer?.optionId)
  return (
    <article
      class={`qcard ${isOpen && q.severity === 'blocking' ? 'open-blocking' : ''} ${p.selected ? 'selected' : ''}`}
      data-question={q.id}
      onClick={p.onSelect}
    >
      <div class="qhead">
        <span class={`tag ${tag[0]}`}>{tag[1]}</span>
        <span class="cat">{CATEGORY[q.category] ?? q.category}</span>
        <span class="target">{q.target}</span>
      </div>
      <p class="qtext">{q.question}</p>
      {isOpen && !p.open && (
        <div>
          <button type="button" class="btn small" onClick={e => { e.stopPropagation(); p.onExpand() }}>
            Answer
          </button>{' '}
          <button type="button" class="btn small" onClick={e => { e.stopPropagation(); p.onDismiss() }}>
            Not relevant
          </button>
        </div>
      )}
      {isOpen && p.open && (
        <>
          {q.options && q.options.length > 0 && (
            <div class="options" role="group" aria-label="Answer">
              {q.options.map(o => (
                <button key={o.id} type="button" class="btn" data-option={o.id} onClick={e => { e.stopPropagation(); p.onPick(o.id) }}>
                  {o.label}
                </button>
              ))}
            </div>
          )}
          <label class="field" onClick={e => e.stopPropagation()}>
            Or answer in your own words
            <div style={{ display: 'flex', gap: '6px' }}>
              <input type="text" value={p.draft} placeholder="e.g. fail closed, but only for orders over a threshold" onInput={e => p.onDraft((e.target as HTMLInputElement).value)} />
              <button type="button" class="btn small" disabled={p.draft.trim().length === 0} onClick={p.onText}>
                Answer
              </button>
            </div>
          </label>
        </>
      )}
      {q.status === 'answered' && (
        <div class="answer">
          <b>You:</b> {picked?.label ?? q.answer?.text}
          {picked?.effect && (
            <>
              <br />
              <span>{picked.effect}</span>
            </>
          )}
          {picked && q.answer?.text && (
            <>
              <br />
              <span>{q.answer.text}</span>
            </>
          )}
        </div>
      )}
      {!isOpen && (
        <div class="rating" onClick={e => e.stopPropagation()}>
          Was this question worth asking?
          <button type="button" class="btn small" aria-pressed={q.rating === 'useful'} onClick={() => p.onRate('useful')}>Useful</button>
          <button type="button" class="btn small" aria-pressed={q.rating === 'noise'} onClick={() => p.onRate('noise')}>Noise</button>
        </div>
      )}
    </article>
  )
}
