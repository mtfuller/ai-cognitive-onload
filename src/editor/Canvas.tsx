// The map. Boxes are absolutely placed by core/layout; arrows are one SVG
// layer under them. Read edges are solid, inferred ones dashed amber, and in
// a proposed model added parts are green and removed ones red and struck.

import { Fragment } from 'preact'

import type { ProposedEdge, ProposedNode } from '../../plugins/sysedit/core/changeset.ts'
import { BOX, layout, route } from '../../plugins/sysedit/core/layout.ts'
import { edgeId } from '../../plugins/sysedit/core/model.ts'

export type NodeState = 'idle' | 'visited' | 'current'
export type EdgeState = { color?: string; badge?: { n: number; tone: '' | 'done' | 'now' } }

export type CanvasProps = {
  nodes: ProposedNode[]
  edges: ProposedEdge[]
  entry?: string
  nodeState?: (id: string) => NodeState
  edgeState?: (id: string) => EdgeState | undefined
  selected?: string | null
  pending?: string | null
  suggested?: Set<string>
  onNode?: (id: string) => void
  onEdge?: (id: string) => void
  label?: string
}

const COLORS = {
  arrow: 'var(--arrow)',
  inferred: 'var(--amber)',
  added: 'var(--green)',
  removed: 'var(--red)',
}

export function Canvas(props: CanvasProps) {
  const { placed, width, height } = layout(props.nodes, props.edges, props.entry)
  const markers = ['arrow', 'inferred', 'added', 'removed', 'blue', 'soft'] as const
  const markerColor: Record<(typeof markers)[number], string> = {
    arrow: COLORS.arrow,
    inferred: COLORS.inferred,
    added: COLORS.added,
    removed: COLORS.removed,
    blue: 'var(--blue)',
    soft: 'var(--blue-soft)',
  }

  const arrows = props.edges.flatMap(e => {
    const a = placed.get(e.from)
    const b = placed.get(e.to)
    if (!a || !b) return []
    const id = edgeId(e)
    const pts = route(a, b)
    const state = props.edgeState?.(id)
    const base = e.mark === 'added' ? 'added' : e.mark === 'removed' ? 'removed' : e.confidence === 'inferred' ? 'inferred' : 'arrow'
    const color = state?.color ?? COLORS[base]
    const marker = state?.color === 'var(--blue)' ? 'blue' : state?.color === 'var(--blue-soft)' ? 'soft' : base
    const dashed = e.confidence === 'inferred' || e.mark === 'removed'
    const midX = (pts.x1 + pts.x2) / 2
    const midY = (pts.y1 + pts.y2) / 2
    const isSelected = props.selected === id
    return [{ e, id, pts, color, marker, dashed, midX, midY, state, isSelected }]
  })

  return (
    <div class="canvas-wrap" role="img" aria-label={props.label ?? 'System map'}>
      <div class="canvas" style={{ width: `${Math.max(width, 480)}px`, height: `${Math.max(height, 240)}px` }}>
        <svg class="arrows" width={Math.max(width, 480)} height={Math.max(height, 240)} aria-hidden="true">
          <defs>
            {markers.map(m => (
              <marker id={`m-${m}`} key={m} orient="auto" markerWidth="8" markerHeight="8" refX="7" refY="4">
                <path d="M0 0 L8 4 L0 8 Z" style={{ fill: markerColor[m] }} />
              </marker>
            ))}
          </defs>
          {arrows.map(({ id, pts, color, marker, dashed, isSelected }) => (
            <g key={id}>
              <line
                x1={pts.x1}
                y1={pts.y1}
                x2={pts.x2}
                y2={pts.y2}
                style={{ stroke: color, strokeWidth: isSelected ? 4 : 2, strokeDasharray: dashed ? '6 6' : undefined }}
                marker-end={`url(#m-${marker})`}
              />
              {props.onEdge && (
                <line
                  class="hit"
                  data-edge={id}
                  x1={pts.x1}
                  y1={pts.y1}
                  x2={pts.x2}
                  y2={pts.y2}
                  stroke="transparent"
                  stroke-width="14"
                  onClick={() => props.onEdge?.(id)}
                />
              )}
            </g>
          ))}
        </svg>
        {props.nodes.map(n => {
          const p = placed.get(n.id)
          if (!p) return null
          const st = props.nodeState?.(n.id) ?? 'idle'
          const cls = [
            'node',
            n.external || n.kind === 'external' ? 'external' : '',
            n.mark ?? '',
            st !== 'idle' ? st : '',
            props.selected === n.id ? 'selected' : '',
            props.pending === n.id ? 'pending' : '',
            props.suggested?.has(n.id) ? 'suggested' : '',
          ]
            .filter(Boolean)
            .join(' ')
          const sub = n.detail ?? (n.source ? n.source.file : n.external ? 'external' : '')
          return (
            <button
              key={n.id}
              type="button"
              class={cls}
              data-node={n.id}
              style={{ left: `${p.x}px`, top: `${p.y}px` }}
              onClick={() => props.onNode?.(n.id)}
              aria-pressed={props.selected === n.id}
            >
              <span>
                <b>{n.label}</b>
                <span class="sub">{sub}</span>
              </span>
            </button>
          )
        })}
        {arrows.map(({ e, id, midX, midY, state }) => (
          <Fragment key={`f-${id}`}>
            {state?.badge && (
              <div key={`b-${id}`} class={`badge ${state.badge.tone}`} style={{ left: `${midX + 8}px`, top: `${midY - 11}px` }}>
                {state.badge.n}
              </div>
            )}
            {(e.when || e.label || e.confidence === 'inferred' || e.mark === 'removed') && (
              <div
                key={`l-${id}`}
                class={`edge-label ${e.mark ?? (e.confidence === 'inferred' ? 'inferred' : '')}`}
                style={{ left: `${midX - 30}px`, top: `${midY + (state?.badge ? 14 : -8)}px` }}
              >
                {e.when ?? e.label ?? (e.mark === 'removed' ? 'removed' : 'inferred')}
              </div>
            )}
          </Fragment>
        ))}
      </div>
    </div>
  )
}

export function Legend() {
  return (
    <section class="stack">
      <h2 class="label">Legend</h2>
      <div class="legend-row">
        <svg width="32" height="8" aria-hidden="true"><path d="M0 4 H32" style={{ stroke: 'var(--muted)', strokeWidth: 2 }} /></svg>Read directly from code
      </div>
      <div class="legend-row">
        <svg width="32" height="8" aria-hidden="true"><path d="M0 4 H32" style={{ stroke: 'var(--amber)', strokeWidth: 2, strokeDasharray: '6 6' }} /></svg>Inferred, needs a look
      </div>
      <div class="legend-row">
        <svg width="32" height="16" aria-hidden="true"><rect x="1" y="1" width="30" height="14" rx="3" fill="none" style={{ stroke: 'var(--muted)', strokeDasharray: '4 3' }} /></svg>Outside this repo
      </div>
      <div class="legend-row">
        <svg width="32" height="16" aria-hidden="true"><rect x="1" y="1" width="30" height="14" rx="3" style={{ fill: 'var(--blue-bg)', stroke: 'var(--blue)', strokeWidth: 2 }} /></svg>Current step
      </div>
    </section>
  )
}

export const BOX_SIZE = BOX
