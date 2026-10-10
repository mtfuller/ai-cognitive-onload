// 4 · Plan: what Claude will build, task by task, each tied to the operations
// the engineer drew, and afterwards whether the code matched the map.

import { describeOp } from '../../plugins/sysedit/core/changeset.ts'
import type { ChangeView } from './api.ts'

export function Plan({ view }: { view: ChangeView }) {
  const cs = view.change
  const labels = new Map(view.proposed.nodes.map(n => [n.id, n.label]))
  return (
    <div class="body">
      <aside class="left">
        <section class="stack">
          <h2 class="label">Change</h2>
          <b>{cs.title}</b>
          <span class="muted">{cs.status}{cs.risk ? ` · ${cs.risk} risk` : ''}</span>
        </section>
        <section class="stack">
          <h2 class="label">Files on the map</h2>
          {view.files.length === 0 ? <span class="muted">None yet.</span> : view.files.map(f => <span key={f} class="filepath">{f}</span>)}
        </section>
        <section class="stack">
          <h2 class="label">History</h2>
          <ul class="timeline">
            {cs.history.map((h, i) => (
              <li key={i}>
                <span class="mono muted" style={{ fontSize: '11px' }}>{h.at.slice(0, 16).replace('T', ' ')}</span> {h.event}
                {h.detail ? <span class="muted"> · {h.detail}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      </aside>
      <main class="main">
        <div class="titlebar">
          <h1>Implementation plan</h1>
          <span class="muted">Each task builds operations you drew. Nothing else is built.</span>
        </div>
        {!cs.plan || cs.plan.length === 0 ? (
          <div class="hint">
            {cs.status === 'approved'
              ? 'Approved. Ask Claude to plan it: /sysedit:plan'
              : 'The plan is made once the change is approved.'}
          </div>
        ) : (
          cs.plan.map(t => (
            <div class="task" key={t.id}>
              <b>{t.title}</b>
              <ul class="changes">
                {t.ops.map(i => {
                  const op = cs.ops[i]
                  if (!op) return null
                  const d = describeOp(op, labels)
                  return (
                    <li key={i}>
                      <b class={`sign ${d.sign === '+' ? 'add' : d.sign === '−' ? 'rem' : 'mod'}`}>{d.sign}</b>
                      <span>{d.text}</span>
                    </li>
                  )
                })}
              </ul>
              <span class="muted" style={{ fontSize: '12px' }}>{t.files.join(', ')}</span>
            </div>
          ))
        )}
        {cs.drift && (
          <div class="task" data-testid="drift">
            <b class={cs.drift.ok ? 'drift-ok' : 'drift-bad'}>{cs.drift.ok ? 'Verified: the code matches your map.' : 'Drift: the code and your map disagree.'}</b>
            {[
              ['Drawn, not built', [...cs.drift.missingNodes, ...cs.drift.missing]],
              ['Removed on the map, still in the code', cs.drift.stillPresent],
              ['In the code, not drawn', cs.drift.unexpected],
            ].map(([title, items]) =>
              (items as string[]).length > 0 ? (
                <div key={title as string}>
                  <span class="label">{title}</span>
                  <ul class="checked">{(items as string[]).map(x => <li key={x} class="mono">{x}</li>)}</ul>
                </div>
              ) : null,
            )}
          </div>
        )}
      </main>
    </div>
  )
}
