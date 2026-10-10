// 1 · Trace: step through a flow as the code runs it today, with the code for
// each step beside the map. Claude did the reading; the engineer does the
// tracing, fast, against evidence they can check.

import { useEffect, useMemo, useState } from 'preact/hooks'

import { atLevel, edgeId, flowSlice, LEVELS, modelStats, ownerAt, type Level, type SystemModel } from '../../plugins/sysedit/core/model.ts'
import { Canvas, Legend, type EdgeState, type NodeState } from './Canvas.tsx'
import { Code } from './Code.tsx'

const LEVEL_LABEL: Record<Level, string> = { services: 'Services', modules: 'Modules', functions: 'Functions' }

export function sliceForFlow(model: SystemModel, flowId: string, level: Level) {
  const slice = flowSlice(model, flowId)
  const owner = ownerAt(model, level)
  const ids = new Set(slice.nodes.map(n => owner(n.id)).filter((x): x is string => !!x))
  const leveled = atLevel(model, level)
  return {
    nodes: leveled.nodes.filter(n => ids.has(n.id)),
    edges: leveled.edges.filter(e => ids.has(e.from) && ids.has(e.to)),
    owner,
  }
}

export function Trace({ model, focus }: { model: SystemModel; focus?: string | null }) {
  const [flowId, setFlowId] = useState(model.flows[0]?.id ?? '')
  const [level, setLevel] = useState<Level>('functions')
  const [step, setStep] = useState(0)
  const flow = model.flows.find(f => f.id === flowId) ?? model.flows[0]

  useEffect(() => setStep(0), [flowId])
  useEffect(() => {
    // "Trace this on the map" from the grill: open the flow and step that reaches the target.
    if (!focus) return
    for (const f of model.flows) {
      const i = f.steps.findIndex(s => {
        const e = model.edges.find(x => edgeId(x) === s.edge)
        const label = (id: string) => model.nodes.find(n => n.id === id)?.label ?? id
        return e && (e.to === focus || e.from === focus || label(e.to) === focus || focus.includes(label(e.to)))
      })
      if (i >= 0) {
        setFlowId(f.id)
        setTimeout(() => setStep(i), 0)
        return
      }
    }
  }, [focus])

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.target as HTMLElement)?.closest('input, textarea, select')) return
      if (ev.key === 'ArrowRight' || ev.key === 'j') setStep(s => Math.min((flow?.steps.length ?? 1) - 1, s + 1))
      if (ev.key === 'ArrowLeft' || ev.key === 'k') setStep(s => Math.max(0, s - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flow?.id])

  const { nodes, edges, owner } = useMemo(() => (flow ? sliceForFlow(model, flow.id, level) : { nodes: [], edges: [], owner: (x: string) => x }), [model, flow?.id, level])

  if (!flow) {
    return (
      <div class="empty">
        <b>No flows on the map yet.</b>
        <span>Ask Claude to map the entry points your request touches: /sysedit:map</span>
      </div>
    )
  }

  const steps = flow.steps.map(s => ({ ...s, edge: model.edges.find(e => edgeId(e) === s.edge) }))
  const last = steps.length - 1
  const cur = Math.max(0, Math.min(last, step))
  const current = steps[cur]

  // Fold each step's edge to the level shown, so stepping works at every level.
  const folded = steps.map(s => (s.edge ? `${owner(s.edge.from)}->${owner(s.edge.to)}` : ''))
  const nodeState = (id: string): NodeState => {
    if (current?.edge && owner(current.edge.to) === id) return 'current'
    for (let i = 0; i <= cur; i++) {
      const e = steps[i]?.edge
      if (e && (owner(e.from) === id || owner(e.to) === id)) return 'visited'
    }
    return 'idle'
  }
  const edgeState = (id: string): EdgeState | undefined => {
    const e = edges.find(x => edgeId(x) === id)
    if (!e) return undefined
    const i = folded.indexOf(`${e.from}->${e.to}`)
    if (i < 0) return undefined
    const tone = i < cur ? 'done' : i === cur ? 'now' : ''
    return {
      color: i < cur ? 'var(--blue-soft)' : i === cur ? 'var(--blue)' : undefined,
      badge: { n: i + 1, tone },
    }
  }

  const ev = current?.edge?.evidence
  const node = current?.edge ? model.nodes.find(n => n.id === current.edge!.to) : undefined
  const codeAt = ev
    ? { file: ev.file, start: ev.line, end: ev.endLine ?? ev.line + 4, snippet: ev.snippet }
    : node?.source
      ? { file: node.source.file, start: node.source.lines[0], end: node.source.lines[1] }
      : null
  const stats = modelStats(model)
  const inferred = current?.edge?.confidence === 'inferred'

  return (
    <div class="body">
      <aside class="left">
        <section class="stack">
          <h2 class="label">Entry points</h2>
          {model.flows.map(f => (
            <button key={f.id} type="button" class="pick" aria-pressed={f.id === flow.id} onClick={() => setFlowId(f.id)}>
              {f.entry}
            </button>
          ))}
        </section>
        <section class="stack">
          <h2 class="label">Detail level</h2>
          <div class="seg" role="group" aria-label="Detail level">
            {LEVELS.map(l => (
              <button key={l} type="button" aria-pressed={l === level} onClick={() => setLevel(l)}>
                {LEVEL_LABEL[l]}
              </button>
            ))}
          </div>
        </section>
        <Legend />
        <section class="foot">
          <span>
            {stats.nodes} nodes · {stats.edges} edges · {stats.inferred} inferred
          </span>
          <span>Every box links to the lines it came from.</span>
          <span class="mono" style={{ fontSize: '12px' }}>
            Built from {model.commit}
          </span>
        </section>
      </aside>

      <main class="main">
        <div class="titlebar">
          <h1>
            <span class="mono">{flow.entry}</span>, as it works today
          </h1>
          <span class="muted" style={{ fontSize: '13px' }}>
            Step through the path (← →), or pick any step on the right.
          </span>
        </div>
        <Canvas nodes={nodes} edges={edges} entry={owner(flow.entryNode)} nodeState={nodeState} edgeState={edgeState} label={`Map of ${flow.entry}`} />
      </main>

      <aside class="right">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
          <span class="label" data-testid="step-count">
            Step {cur + 1} of {steps.length}
          </span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" class="btn" aria-label="Previous step" disabled={cur === 0} onClick={() => setStep(s => Math.max(0, Math.min(last, s) - 1))}>
              ‹
            </button>
            <button type="button" class="btn primary" disabled={cur === last} onClick={() => setStep(s => Math.min(last, Math.min(last, s) + 1))}>
              Next step ›
            </button>
          </div>
        </div>
        <h2 style={{ margin: 0, fontSize: '17px', lineHeight: '24px' }}>{current?.title}</h2>
        <Code at={codeAt} />
        {inferred ? (
          <div class="note">{current?.note ?? current?.edge?.note ?? 'Inferred: check this before relying on it.'}</div>
        ) : (
          (current?.note ?? current?.edge?.note) && <p class="muted" style={{ margin: 0, fontSize: '13px' }}>{current?.note ?? current?.edge?.note}</p>
        )}
        <div class="path-list">
          <h3 class="label" style={{ marginBottom: '4px' }}>
            The whole path
          </h3>
          {steps.map((s, i) => (
            <button key={i} type="button" class={`path-row ${i === cur ? 'now' : ''}`} onClick={() => setStep(i)}>
              <span class={`badge ${i < cur ? 'done' : i === cur ? 'now' : ''}`}>{i + 1}</span>
              <span class="mono" style={{ fontSize: '12px' }}>
                {s.edge ? `${label(model, s.edge.from)} → ${label(model, s.edge.to)}${s.edge.confidence === 'inferred' ? ' (inferred)' : ''}` : s.title}
              </span>
            </button>
          ))}
        </div>
      </aside>
    </div>
  )
}

function label(model: SystemModel, id: string) {
  return model.nodes.find(n => n.id === id)?.label ?? id
}
