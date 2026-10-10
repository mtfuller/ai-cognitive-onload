// A layered layout for the editor's canvas: the entry at the top, each node a
// row below the deepest node that calls it, siblings spread across the row
// with the busiest child in the middle, as in the mockup.

import type { ModelEdge, ModelNode } from './model.ts'

export type Placed = { id: string; x: number; y: number; row: number; col: number }

export const BOX = { width: 232, height: 64, gapX: 64, gapY: 64 }

export function layout(
  nodes: readonly Pick<ModelNode, 'id'>[],
  edges: readonly Pick<ModelEdge, 'from' | 'to'>[],
  entry?: string,
): { placed: Map<string, Placed>; width: number; height: number } {
  const ids = nodes.map(n => n.id)
  const known = new Set(ids)
  const out = new Map<string, string[]>()
  const indeg = new Map<string, number>(ids.map(id => [id, 0]))
  for (const e of edges) {
    if (!known.has(e.from) || !known.has(e.to) || e.from === e.to) continue
    out.set(e.from, [...(out.get(e.from) ?? []), e.to])
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  }

  // Rows: longest path from the roots, ignoring back edges found by DFS.
  const roots = entry && known.has(entry) ? [entry, ...ids.filter(id => id !== entry && indeg.get(id) === 0)] : ids.filter(id => indeg.get(id) === 0)
  if (roots.length === 0 && ids.length > 0) roots.push(ids[0]!)
  const row = new Map<string, number>()
  const onStack = new Set<string>()
  const visit = (id: string, depth: number) => {
    if (onStack.has(id)) return
    if ((row.get(id) ?? -1) >= depth) return
    row.set(id, depth)
    onStack.add(id)
    for (const next of out.get(id) ?? []) visit(next, depth + 1)
    onStack.delete(id)
  }
  for (const r of roots) visit(r, 0)
  for (const id of ids) if (!row.has(id)) visit(id, 0)

  // Columns: order each row by the mean column of its parents, so children sit under callers.
  const rows: string[][] = []
  for (const id of ids) {
    const r = row.get(id)!
    ;(rows[r] ??= []).push(id)
  }
  const col = new Map<string, number>()
  const parents = new Map<string, string[]>()
  for (const [from, tos] of out) for (const to of tos) parents.set(to, [...(parents.get(to) ?? []), from])
  rows.forEach((list, r) => {
    if (r === 0) {
      list.forEach((id, i) => col.set(id, i))
      return
    }
    const score = (id: string) => {
      const ps = (parents.get(id) ?? []).filter(p => col.has(p) && row.get(p)! < r)
      return ps.length === 0 ? Number.MAX_SAFE_INTEGER : ps.reduce((a, p) => a + col.get(p)!, 0) / ps.length
    }
    list.sort((a, b) => score(a) - score(b))
    list.forEach((id, i) => col.set(id, i))
  })

  const widest = Math.max(1, ...rows.map(r => r?.length ?? 0))
  const pitchX = BOX.width + BOX.gapX
  const pitchY = BOX.height + BOX.gapY
  const placed = new Map<string, Placed>()
  rows.forEach((list, r) => {
    if (!list) return
    const offset = ((widest - list.length) * pitchX) / 2
    list.forEach((id, i) => {
      placed.set(id, { id, row: r, col: i, x: 24 + offset + i * pitchX, y: 40 + r * pitchY })
    })
  })
  return {
    placed,
    width: 48 + widest * pitchX - BOX.gapX,
    height: 80 + rows.length * pitchY - BOX.gapY,
  }
}

/** The points of an arrow from one box to another: out of the bottom or side, into the top or side. */
export function route(a: Placed, b: Placed): { x1: number; y1: number; x2: number; y2: number } {
  const ax = a.x + BOX.width / 2
  const bx = b.x + BOX.width / 2
  if (a.row === b.row) {
    const leftToRight = a.x < b.x
    return {
      x1: leftToRight ? a.x + BOX.width : a.x,
      y1: a.y + BOX.height / 2,
      x2: leftToRight ? b.x : b.x + BOX.width,
      y2: b.y + BOX.height / 2,
    }
  }
  if (b.row > a.row) return { x1: ax, y1: a.y + BOX.height, x2: bx, y2: b.y }
  return { x1: ax, y1: a.y, x2: bx, y2: b.y + BOX.height }
}
