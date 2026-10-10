// The system model: a map of how the code fits together, generated from the
// code itself. Every box and arrow carries the evidence it came from, so an
// engineer can check the map instead of trusting it.
//
// This file is pure: no Node, no DOM. The hooks module, the MCP server, the
// CLI and the editor all import it.

export type Confidence = 'read' | 'inferred'

export type Level = 'services' | 'modules' | 'functions'

export const LEVELS: readonly Level[] = ['services', 'modules', 'functions']

export type NodeKind =
  | 'endpoint'
  | 'config'
  | 'service'
  | 'module'
  | 'function'
  | 'datastore'
  | 'topic'
  | 'worker'
  | 'job'
  | 'external'

export const NODE_KINDS: readonly NodeKind[] = [
  'endpoint',
  'config',
  'service',
  'module',
  'function',
  'datastore',
  'topic',
  'worker',
  'job',
  'external',
]

export type EdgeKind = 'call' | 'route' | 'event' | 'http' | 'read' | 'write' | 'config' | 'branch'

export const EDGE_KINDS: readonly EdgeKind[] = [
  'call',
  'route',
  'event',
  'http',
  'read',
  'write',
  'config',
  'branch',
]

/** Where a node lives in the code. */
export type SourceRef = {
  file: string
  /** First and last line, 1-based and inclusive. */
  lines: [number, number]
}

/** The line(s) that prove an edge exists. */
export type Evidence = {
  file: string
  line: number
  endLine?: number
  /** The code at those lines, as Claude read it. Optional; the editor reads the file when absent. */
  snippet?: string
}

export type ModelNode = {
  id: string
  label: string
  kind: NodeKind
  /** The coarsest level the node is drawn at. A function node is hidden at the services level. */
  level?: Level
  /** The module or service this node belongs to, for collapsing to coarser levels. */
  parent?: string
  source?: SourceRef
  /** Outside this repository (a vendor API, a managed queue). Drawn dashed; needs no source. */
  external?: boolean
  /** One line under the label, such as `Postgres · orders, outbox`. */
  detail?: string
  note?: string
}

export type ModelEdge = {
  /** Defaults to `from->to`. Set it when two edges join the same pair. */
  id?: string
  from: string
  to: string
  kind: EdgeKind
  confidence: Confidence
  evidence?: Evidence
  /** A guard on the edge, such as `score >= 0.8`. */
  when?: string
  label?: string
  /** Why it is inferred, or anything the engineer should check. */
  note?: string
}

export type FlowStep = {
  /** The edge this step walks. */
  edge: string
  title: string
  note?: string
}

export type Flow = {
  id: string
  /** What starts the flow: `POST /checkout`, `cron release-expired-holds`. */
  entry: string
  /** The node the flow starts at. */
  entryNode: string
  steps: FlowStep[]
}

export type SystemModel = {
  version: 1
  repo?: string
  branch?: string
  /** The commit the model was read from. */
  commit: string
  generatedAt?: string
  /** The request the map was drawn for, when it was. */
  request?: string
  nodes: ModelNode[]
  edges: ModelEdge[]
  flows: Flow[]
}

export function edgeId(edge: Pick<ModelEdge, 'id' | 'from' | 'to'>): string {
  return edge.id ?? `${edge.from}->${edge.to}`
}

export function nodeLevel(node: ModelNode): Level {
  if (node.level) return node.level
  switch (node.kind) {
    case 'service':
    case 'external':
    case 'datastore':
    case 'topic':
    case 'endpoint':
    case 'config':
      return 'services'
    case 'module':
    case 'worker':
    case 'job':
      return 'modules'
    default:
      return 'functions'
  }
}

export function emptyModel(commit = 'unknown'): SystemModel {
  return { version: 1, commit, nodes: [], edges: [], flows: [] }
}

export function indexModel(model: SystemModel) {
  const nodes = new Map(model.nodes.map(n => [n.id, n]))
  const edges = new Map(model.edges.map(e => [edgeId(e), e]))
  return { nodes, edges }
}

/**
 * Merge `incoming` into `base`: nodes, edges and flows with the same id are
 * replaced, new ones appended. Mapper subagents each write one entry point's
 * slice, and the slices merge into one model.
 */
export function mergeModels(base: SystemModel, incoming: SystemModel): SystemModel {
  const nodes = new Map(base.nodes.map(n => [n.id, n]))
  for (const n of incoming.nodes) nodes.set(n.id, n)
  const edges = new Map(base.edges.map(e => [edgeId(e), e]))
  for (const e of incoming.edges) edges.set(edgeId(e), e)
  const flows = new Map(base.flows.map(f => [f.id, f]))
  for (const f of incoming.flows) flows.set(f.id, f)
  return {
    ...base,
    ...incoming,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    flows: [...flows.values()],
  }
}

/**
 * The part of the model at a detail level. Nodes finer than the level are
 * folded into their nearest visible parent, and edges are re-pointed to match,
 * dropping self-loops and duplicates.
 */
/**
 * A function from a node id to the id that stands for it at `level`: itself
 * when it is drawn at that level, else its nearest visible parent.
 */
export function ownerAt(model: SystemModel, level: Level): (id: string) => string | undefined {
  const rank = (l: Level) => LEVELS.indexOf(l)
  const byId = new Map(model.nodes.map(n => [n.id, n]))
  const visible = (n: ModelNode) => rank(nodeLevel(n)) <= rank(level)
  return (id: string) => {
    let cur = byId.get(id)
    const seen = new Set<string>()
    while (cur && !visible(cur)) {
      if (seen.has(cur.id) || !cur.parent) return undefined
      seen.add(cur.id)
      cur = byId.get(cur.parent)
    }
    return cur?.id
  }
}

/**
 * The part of the model at a detail level. Nodes finer than the level are
 * folded into their nearest visible parent, and edges are re-pointed to match,
 * dropping self-loops and duplicates.
 */
export function atLevel(model: SystemModel, level: Level): SystemModel {
  const rank = (l: Level) => LEVELS.indexOf(l)
  const owner = ownerAt(model, level)
  const nodes = model.nodes.filter(n => rank(nodeLevel(n)) <= rank(level))
  const edges: ModelEdge[] = []
  const seen = new Set<string>()
  for (const e of model.edges) {
    const from = owner(e.from)
    const to = owner(e.to)
    if (!from || !to || from === to) continue
    const key = `${from}->${to}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push(from === e.from && to === e.to ? e : { ...e, id: undefined, from, to })
  }
  return { ...model, nodes, edges }
}

/** Nodes reachable from `start` along edges, in breadth-first order. */
export function reachable(model: SystemModel, start: string): string[] {
  const out = new Map<string, string[]>()
  for (const e of model.edges) {
    const list = out.get(e.from) ?? []
    list.push(e.to)
    out.set(e.from, list)
  }
  const order: string[] = []
  const seen = new Set<string>([start])
  const queue = [start]
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const next of out.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return order
}

/** The sub-model a flow walks: its entry, every node on its steps, and those edges. */
export function flowSlice(model: SystemModel, flowId: string): SystemModel {
  const flow = model.flows.find(f => f.id === flowId)
  if (!flow) return { ...model, nodes: [], edges: [], flows: [] }
  const { edges } = indexModel(model)
  const ids = new Set<string>([flow.entryNode])
  const keep: ModelEdge[] = []
  for (const step of flow.steps) {
    const e = edges.get(step.edge)
    if (!e) continue
    keep.push(e)
    ids.add(e.from)
    ids.add(e.to)
  }
  return {
    ...model,
    nodes: model.nodes.filter(n => ids.has(n.id)),
    edges: keep,
    flows: [flow],
  }
}

export function modelStats(model: SystemModel) {
  return {
    nodes: model.nodes.length,
    edges: model.edges.length,
    inferred: model.edges.filter(e => e.confidence === 'inferred').length,
    external: model.nodes.filter(n => n.external).length,
    flows: model.flows.length,
  }
}
