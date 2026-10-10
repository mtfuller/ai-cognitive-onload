// 2 · Edit: the engineer draws the change. Every click is an operation in the
// change set, saved as the engineer's own. Operations Claude suggested are
// dashed until the engineer accepts them.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks'

import { applyOps, describeOp, type Op } from '../../plugins/sysedit/core/changeset.ts'
import type { NodeKind, SystemModel } from '../../plugins/sysedit/core/model.ts'
import { edgeId } from '../../plugins/sysedit/core/model.ts'
import { api, type ChangeView } from './api.ts'
import { Canvas } from './Canvas.tsx'
import { sliceForFlow } from './Trace.tsx'

type Tool = 'select' | 'connect' | 'reroute' | 'remove' | 'branch'

const ADD_KINDS: { kind: NodeKind; label: string }[] = [
  { kind: 'service', label: 'Service' },
  { kind: 'function', label: 'Function' },
  { kind: 'topic', label: 'Topic / queue' },
  { kind: 'datastore', label: 'Datastore' },
  { kind: 'external', label: 'External API' },
]

const TOOLS: { id: Tool; label: string }[] = [
  { id: 'select', label: 'Select' },
  { id: 'connect', label: 'Connect' },
  { id: 'reroute', label: 'Reroute' },
  { id: 'remove', label: 'Remove' },
]

export function Edit({ model, view, onSubmitted }: { model: SystemModel; view: ChangeView; onSubmitted: () => void }) {
  const cs = view.change
  const editable = cs.status === 'draft' || cs.status === 'in-review'
  const [ops, setOps] = useState<Op[]>(cs.ops)
  const [undo, setUndo] = useState<Op[][]>([])
  const [intent, setIntent] = useState(cs.intent)
  const [tool, setTool] = useState<Tool>('select')
  const [selected, setSelected] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Saves still in flight. Two can overlap (add a box, then name it); the first to land mustn't let a stale copy in.
  const inFlight = useRef(0)
  const editingIntent = useRef(false)
  const counter = useRef(1)

  // When our last save landed, so a copy of the change fetched before it can't undo it.
  const savedAt = useRef('')

  // Follow the server when Claude or another tab changes the change set, unless we have unsaved edits.
  useEffect(() => {
    if (inFlight.current === 0 && cs.updatedAt >= savedAt.current) {
      setOps(cs.ops)
      if (!editingIntent.current) setIntent(cs.intent)
    }
  }, [cs.updatedAt])

  const save = async (next: Op[], nextIntent = intent) => {
    inFlight.current += 1
    setSaving(true)
    try {
      const at = await api.setOps(next, nextIntent)
      if (at && at > savedAt.current) savedAt.current = at
      setError(null)
    } catch (e) {
      setError(String((e as Error).message))
    } finally {
      inFlight.current -= 1
      setSaving(false)
    }
  }

  const commit = (next: Op[]) => {
    setUndo(u => [...u, ops])
    setOps(next)
    void save(next)
  }
  const push = (op: Op) => commit([...ops, { ...op, by: 'engineer' }])

  const base = useMemo(() => {
    if (!cs.flow || !model.flows.some(f => f.id === cs.flow)) return model
    const s = sliceForFlow(model, cs.flow, 'functions')
    return { ...model, nodes: s.nodes, edges: s.edges }
  }, [model, cs.flow])
  const proposed = useMemo(() => applyOps(base, ops), [base, ops])
  const fullProposed = useMemo(() => applyOps(model, ops), [model, ops])
  const shown = showOriginal ? { ...base, annotations: [], conflicts: [] } : proposed
  const labels = useMemo(() => new Map(fullProposed.nodes.map(n => [n.id, n.label])), [fullProposed])
  const suggestedIds = new Set(
    ops.flatMap(o => (o.by === 'claude' ? (o.op === 'addNode' ? [o.id] : 'from' in o ? [`${o.from}->${o.to}`] : []) : [])),
  )

  const findEdge = (id: string) => proposed.edges.find(e => edgeId(e) === id)

  const onNode = (id: string) => {
    if (!editable) return setSelected(id)
    switch (tool) {
      case 'select':
        setSelected(id)
        return
      case 'connect':
      case 'branch':
        if (!pending) {
          setPending(id)
          return
        }
        if (pending !== id) {
          push(tool === 'branch' ? { op: 'addBranch', from: pending, to: id, when: 'condition' } : { op: 'addEdge', from: pending, to: id })
          setSelected(tool === 'branch' ? `${pending}->${id}` : id)
        }
        setPending(null)
        if (tool === 'branch') setTool('select')
        return
      case 'reroute': {
        const e = selected ? findEdge(selected) : undefined
        if (!e) {
          setError('Pick the arrow to reroute first, then the box it should go to.')
          return
        }
        push({ op: 'rerouteEdge', from: e.from, to: e.to, newTo: id })
        setSelected(null)
        return
      }
      case 'remove': {
        const n = proposed.nodes.find(x => x.id === id)
        if (n?.mark === 'added') {
          commit(ops.filter(o => !(o.op === 'addNode' && o.id === id) && !('from' in o && (o.from === id || o.to === id))))
        } else if (n && n.mark !== 'removed') {
          push({ op: 'removeNode', id })
        }
        return
      }
    }
  }

  const onEdge = (id: string) => {
    if (!editable) return
    const e = findEdge(id)
    if (!e) return
    if (tool === 'remove') {
      if (e.mark === 'added') {
        commit(ops.filter(o => !('from' in o && o.from === e.from && o.to === e.to && o.op !== 'removeEdge')))
      } else if (e.mark !== 'removed') {
        push({ op: 'removeEdge', from: e.from, to: e.to })
      }
      return
    }
    setSelected(id)
    if (tool !== 'reroute') setTool('select')
  }

  const addNode = (kind: NodeKind, label: string) => {
    if (!editable) return
    let id = `new.${kind}${counter.current++}`
    while (fullProposed.nodes.some(n => n.id === id)) id = `new.${kind}${counter.current++}`
    push({ op: 'addNode', id, kind, label: `New ${label.toLowerCase()}`, external: kind === 'external' || undefined })
    setSelected(id)
    setTool('select')
  }

  const updateAddedNode = (id: string, patch: Partial<Extract<Op, { op: 'addNode' }>>) => {
    // A new box gets a stable id from its name the first time it is named, and its arrows follow.
    let newId = id
    if (patch.label && id.startsWith('new.')) {
      const candidate = slug(patch.label)
      if (candidate && !fullProposed.nodes.some(n => n.id === candidate)) newId = candidate
    }
    const ref = (x: string | undefined) => (x === id ? newId : x)
    commit(
      ops.map(o => {
        if (o.op === 'addNode' && o.id === id) return { ...o, ...patch, id: newId }
        if (newId === id || !('from' in o)) return o
        return {
          ...o,
          from: ref(o.from)!,
          to: ref(o.to)!,
          ...('newFrom' in o && o.newFrom ? { newFrom: ref(o.newFrom) } : {}),
          ...('newTo' in o && o.newTo ? { newTo: ref(o.newTo) } : {}),
        } as Op
      }),
    )
    if (newId !== id) setSelected(newId)
  }

  const selNode = selected ? fullProposed.nodes.find(n => n.id === selected) : undefined
  const selEdge = selected ? fullProposed.edges.find(e => edgeId(e) === selected) : undefined
  const addOp = selNode?.mark === 'added' ? ops.find(o => o.op === 'addNode' && o.id === selNode.id) : undefined

  const submit = async () => {
    try {
      await api.setOps(ops, intent)
      await api.submit()
      setError(null)
      onSubmitted()
    } catch (e) {
      setError(String((e as Error).message))
    }
  }

  return (
    <div class="body">
      <aside class="left">
        <section class="stack">
          <h2 class="label">Add to the map</h2>
          <div class="grid2">
            {ADD_KINDS.map(k => (
              <button key={k.kind} type="button" class="btn small" disabled={!editable} onClick={() => addNode(k.kind, k.label)}>
                {k.label}
              </button>
            ))}
            <button type="button" class="btn small" disabled={!editable} aria-pressed={tool === 'branch'} onClick={() => { setTool('branch'); setPending(null) }}>
              Branch
            </button>
          </div>
        </section>
        <section class="stack">
          <h2 class="label">Your changes · {ops.length}</h2>
          {ops.length === 0 && <p class="muted" style={{ margin: 0, fontSize: '13px' }}>Nothing yet. Add a box, connect two boxes, or remove an arrow.</p>}
          <ul class="changes" data-testid="changes">
            {ops.map((o, i) => {
              const d = describeOp(o, labels)
              const conflict = fullProposed.conflicts.find(c => c.index === i)
              return (
                <li key={i}>
                  <b class={`sign ${d.sign === '+' ? 'add' : d.sign === '−' ? 'rem' : 'mod'}`}>{d.sign}</b>
                  <span>
                    {d.text}
                    {o.by === 'claude' && <div class="by">suggested by Claude</div>}
                    {conflict && <div class="by">{conflict.message}</div>}
                  </span>
                  {editable && o.by === 'claude' && (
                    <button type="button" class="btn small" onClick={() => api.acceptOp(i).catch(e => setError(e.message))}>
                      Accept
                    </button>
                  )}
                  {editable && (
                    <button type="button" class="x" aria-label={`Remove change ${i + 1}`} onClick={() => commit(ops.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
        <section class="stack">
          <label class="label" for="intent">
            What you're trying to do
          </label>
          <textarea
            id="intent"
            rows={4}
            value={intent}
            disabled={!editable}
            placeholder="In a sentence or two: the outcome, and why."
            onFocus={() => (editingIntent.current = true)}
            onInput={e => setIntent((e.target as HTMLTextAreaElement).value)}
            onBlur={() => {
              editingIntent.current = false
              if (editable) api.setIntent(intent).catch(e => setError(e.message))
            }}
          />
        </section>
        <div class="submit-box">
          {cs.status === 'draft' ? (
            <>
              <button type="button" class="btn primary" onClick={submit} disabled={ops.length === 0 || intent.trim().length < 10}>
                Submit for Claude's review
              </button>
              <span>No code is written until you've answered the review.</span>
            </>
          ) : (
            <span>
              Change is <b>{cs.status}</b>. {cs.status === 'in-review' ? 'You can still adjust the map while you answer.' : ''}
            </span>
          )}
          {saving && <span>Saving…</span>}
        </div>
      </aside>

      <main class="main">
        <div class="titlebar">
          <h1>
            Your change{cs.flow ? ' to ' : ''}
            <span class="mono">{model.flows.find(f => f.id === cs.flow)?.entry ?? ''}</span>
          </h1>
          <div class="toolbar" role="toolbar" aria-label="Map tools">
            {TOOLS.map(t => (
              <button key={t.id} type="button" class="btn small" aria-pressed={tool === t.id} disabled={!editable} onClick={() => { setTool(t.id); setPending(null) }}>
                {t.label}
              </button>
            ))}
            <button type="button" class="btn small" disabled={undo.length === 0 || !editable} onClick={() => { const prev = undo[undo.length - 1]!; setUndo(undo.slice(0, -1)); setOps(prev); void save(prev) }}>
              Undo
            </button>
            <button type="button" class="btn small" aria-pressed={showOriginal} onClick={() => setShowOriginal(!showOriginal)}>
              Show original
            </button>
          </div>
        </div>
        {error && <div class="error">{error}</div>}
        {(tool === 'connect' || tool === 'branch') && (
          <div class="hint">{pending ? `From ${labels.get(pending) ?? pending}: now pick the box it goes to.` : `Pick the box the ${tool === 'branch' ? 'branch' : 'arrow'} starts from.`}</div>
        )}
        {tool === 'reroute' && <div class="hint">Pick the arrow to reroute, then the box it should go to instead.</div>}
        {tool === 'remove' && <div class="hint">Pick a box or an arrow to remove it.</div>}
        <Canvas
          nodes={shown.nodes}
          edges={shown.edges}
          entry={model.flows.find(f => f.id === cs.flow)?.entryNode}
          selected={selected}
          pending={pending}
          suggested={suggestedIds}
          onNode={onNode}
          onEdge={onEdge}
          label="Your change, drawn on the map"
        />
        <div class="legend-strip">
          <span class="chip"><span class="swatch" style={{ background: 'var(--green-bg)', border: '2px solid var(--green)' }} />Added by you</span>
          <span class="chip"><span class="swatch" style={{ background: 'var(--red-bg)', border: '2px dashed var(--red)' }} />Removed by you</span>
          <span class="chip"><span class="swatch" style={{ border: '2px dashed var(--muted)' }} />Suggested by Claude, needs your OK</span>
          <span>Boxes you didn't touch stay linked to their source lines.</span>
        </div>
      </main>

      <aside class="right">
        {!selNode && !selEdge && (
          <div class="muted" style={{ fontSize: '13px' }}>
            Select a box or an arrow to see it here. Use the tools above to connect, reroute or remove; add new boxes from the left.
          </div>
        )}
        {selNode && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span class="label">Selected</span>
              {selNode.mark && <span class={`tag ${selNode.mark === 'added' ? 'answered' : 'blocking'}`}>{selNode.mark === 'added' ? 'New' : selNode.mark}</span>}
            </div>
            {addOp && addOp.op === 'addNode' && editable ? (
              <NewNodeInspector op={addOp} onChange={patch => updateAddedNode(addOp.id, patch)} />
            ) : (
              <>
                <h2 style={{ margin: 0, fontSize: '17px' }}>{selNode.label}</h2>
                {selNode.source && <span class="filepath">{selNode.source.file}:{selNode.source.lines[0]}–{selNode.source.lines[1]}</span>}
                {selNode.note && <p class="muted" style={{ margin: 0 }}>{selNode.note}</p>}
              </>
            )}
            <TouchedCode model={model} nodeId={selNode.id} ops={ops} />
          </>
        )}
        {selEdge && (
          <>
            <span class="label">Selected arrow</span>
            <h2 style={{ margin: 0, fontSize: '17px' }}>
              {labels.get(selEdge.from)} → {labels.get(selEdge.to)}
            </h2>
            {selEdge.kind === 'branch' && editable && selEdge.mark === 'added' && (
              <label class="field">
                When
                <DraftField
                  value={selEdge.when ?? ''}
                  onCommit={when => commit(ops.map(o => (o.op === 'addBranch' && o.from === selEdge.from && o.to === selEdge.to ? { ...o, when } : o)))}
                />
              </label>
            )}
            {selEdge.evidence && <span class="filepath">{selEdge.evidence.file}:{selEdge.evidence.line}</span>}
            {selEdge.confidence === 'inferred' && <div class="note">{selEdge.note ?? 'Inferred: check it before relying on it.'}</div>}
            {editable && selEdge.mark !== 'removed' && (
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                <button type="button" class="btn small" onClick={() => setTool('reroute')}>Reroute…</button>
                <button type="button" class="btn small" onClick={() => onEdgeRemove(selEdge)}>Remove</button>
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  )

  function onEdgeRemove(e: { from: string; to: string; mark?: string }) {
    if (e.mark === 'added') commit(ops.filter(o => !('from' in o && o.from === e.from && o.to === e.to)))
    else push({ op: 'removeEdge', from: e.from, to: e.to })
    setSelected(null)
  }
}

/**
 * A text field that commits on Enter or blur, and keeps what the engineer is
 * typing while the editor refreshes underneath it.
 */
function DraftField(props: { value: string; multiline?: boolean; rows?: number; placeholder?: string; label?: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(props.value)
  const editing = useRef(false)
  useEffect(() => {
    if (!editing.current) setDraft(props.value)
  }, [props.value])
  const commit = () => {
    editing.current = false
    if (draft !== props.value) props.onCommit(draft)
  }
  const common = {
    value: draft,
    placeholder: props.placeholder,
    'aria-label': props.label,
    onFocus: () => (editing.current = true),
    onInput: (e: Event) => {
      editing.current = true
      setDraft((e.target as HTMLInputElement).value)
    },
    onBlur: commit,
  }
  return props.multiline ? (
    <textarea rows={props.rows ?? 3} {...common} />
  ) : (
    <input type="text" {...common} onKeyDown={e => e.key === 'Enter' && commit()} />
  )
}

function NewNodeInspector({ op, onChange }: { op: Extract<Op, { op: 'addNode' }>; onChange: (patch: Partial<Extract<Op, { op: 'addNode' }>>) => void }) {
  const field = (key: 'label' | 'file' | 'takes' | 'returns', label: string, placeholder = '') => (
    <label class="field">
      {label}
      <DraftField value={(op[key] as string) ?? ''} placeholder={placeholder} onCommit={value => onChange({ [key]: value })} />
    </label>
  )
  return (
    <>
      {field('label', 'Name', 'FraudService.score')}
      <label class="field">
        Kind
        <select value={op.kind} onChange={e => onChange({ kind: (e.target as HTMLSelectElement).value as NodeKind })}>
          {['service', 'function', 'module', 'topic', 'datastore', 'external', 'worker', 'job'].map(k => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </label>
      {field('file', 'Lives in', 'src/fraud/service.ts')}
      {field('takes', 'Takes', 'order draft, customer')}
      {field('returns', 'Returns', 'risk score, 0 to 1')}
      <label class="field">
        Notes for Claude
        <DraftField multiline value={op.note ?? ''} onCommit={note => onChange({ note })} />
      </label>
    </>
  )
}

function TouchedCode({ model, nodeId, ops }: { model: SystemModel; nodeId: string; ops: Op[] }) {
  const related = ops.flatMap(o => ('from' in o && (o.from === nodeId || o.to === nodeId) ? [o.from, o.to] : [])).filter(id => id !== nodeId)
  const nodes = [nodeId, ...new Set(related)].map(id => model.nodes.find(n => n.id === id)).filter(n => n?.source)
  if (nodes.length === 0) return null
  return (
    <div class="stack" style={{ display: 'flex', flexDirection: 'column', gap: '6px', paddingTop: '12px', borderTop: '1px solid var(--rule)' }}>
      <h3 class="label">Existing code this touches</h3>
      {nodes.map(n => (
        <span key={n!.id} style={{ fontSize: '13px' }}>
          <span class="filepath">{n!.source!.file}:{n!.source!.lines[0]}–{n!.source!.lines[1]}</span>
          <br />
          <span class="muted">{n!.label}</span>
        </span>
      ))}
    </div>
  )
}

function slug(label: string) {
  return label
    .trim()
    .replace(/[^A-Za-z0-9.]+/g, '')
    .replace(/^\.+|\.+$/g, '')
    .replace(/^./, c => c.toLowerCase())
}
