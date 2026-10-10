// Checks that hold the model to its first two rules: every box has a source,
// and whatever was guessed says so. Pure; the Node side passes in what it
// knows about the files on disk.

import { EDGE_KINDS, NODE_KINDS, edgeId, type SystemModel } from './model.ts'

export type Issue = { path: string; message: string }

export type ValidationReport = {
  ok: boolean
  errors: Issue[]
  warnings: Issue[]
}

export type FileFacts = {
  /** Line count for each file that exists, keyed by repository-relative path. */
  lineCounts: Map<string, number>
}

export function isSafeRelativePath(file: string): boolean {
  if (!file || file.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(file)) return false
  return !file.split(/[\\/]/).some(part => part === '..')
}

export function validateModel(model: unknown, facts?: FileFacts): ValidationReport {
  const errors: Issue[] = []
  const warnings: Issue[] = []
  const err = (path: string, message: string) => errors.push({ path, message })
  const warn = (path: string, message: string) => warnings.push({ path, message })

  if (!model || typeof model !== 'object') {
    err('', 'the model must be a JSON object')
    return { ok: false, errors, warnings }
  }
  const m = model as SystemModel
  if (m.version !== 1) err('version', 'must be 1')
  if (typeof m.commit !== 'string' || m.commit.length === 0) err('commit', 'must name the commit the model was read from')
  for (const key of ['nodes', 'edges', 'flows'] as const) {
    if (!Array.isArray(m[key])) err(key, 'must be an array')
  }
  if (errors.length > 0) return { ok: false, errors, warnings }

  const checkFile = (path: string, file: string, first: number, last: number) => {
    if (!isSafeRelativePath(file)) {
      err(path, `"${file}" must be a path relative to the repository root, without ".."`)
      return
    }
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first) {
      err(path, `line range ${first}–${last} is not a valid 1-based range`)
      return
    }
    if (facts) {
      const count = facts.lineCounts.get(file)
      if (count === undefined) err(path, `${file} does not exist in the repository`)
      else if (last > count) err(path, `${file} has ${count} lines, so ${first}–${last} is out of range`)
    }
  }

  const nodeIds = new Set<string>()
  m.nodes.forEach((n, i) => {
    const p = `nodes[${i}]`
    if (!n || typeof n.id !== 'string' || n.id.length === 0) {
      err(p, 'needs an id')
      return
    }
    if (nodeIds.has(n.id)) err(p, `duplicate node id "${n.id}"`)
    nodeIds.add(n.id)
    if (typeof n.label !== 'string' || n.label.length === 0) err(p, `node "${n.id}" needs a label`)
    if (!NODE_KINDS.includes(n.kind)) err(p, `node "${n.id}" has unknown kind "${String(n.kind)}"`)
    if (n.external || n.kind === 'external') {
      if (n.source) checkFile(`${p}.source`, n.source.file, n.source.lines?.[0], n.source.lines?.[1])
    } else if (!n.source) {
      err(p, `node "${n.id}" has no source: every box needs the file and lines it came from (mark it external if it lives outside the repo)`)
    } else {
      checkFile(`${p}.source`, n.source.file, n.source.lines?.[0], n.source.lines?.[1])
    }
  })
  m.nodes.forEach((n, i) => {
    if (n?.parent && !nodeIds.has(n.parent)) err(`nodes[${i}].parent`, `parent "${n.parent}" is not a node`)
  })

  const edgeIds = new Set<string>()
  m.edges.forEach((e, i) => {
    const p = `edges[${i}]`
    if (!e || typeof e.from !== 'string' || typeof e.to !== 'string') {
      err(p, 'needs from and to')
      return
    }
    const id = edgeId(e)
    if (edgeIds.has(id)) err(p, `duplicate edge "${id}"; give one of them an explicit id`)
    edgeIds.add(id)
    if (!nodeIds.has(e.from)) err(p, `edge "${id}" starts at unknown node "${e.from}"`)
    if (!nodeIds.has(e.to)) err(p, `edge "${id}" ends at unknown node "${e.to}"`)
    if (!EDGE_KINDS.includes(e.kind)) err(p, `edge "${id}" has unknown kind "${String(e.kind)}"`)
    if (e.confidence !== 'read' && e.confidence !== 'inferred') {
      err(p, `edge "${id}" must say whether it was read from code or inferred`)
    } else if (e.confidence === 'read' && !e.evidence) {
      err(p, `edge "${id}" is marked read but has no evidence: give the file and line, or mark it inferred`)
    } else if (e.confidence === 'inferred' && !e.note) {
      warn(p, `inferred edge "${id}" should say how it was inferred, so the engineer knows what to check`)
    }
    if (e.evidence) checkFile(`${p}.evidence`, e.evidence.file, e.evidence.line, e.evidence.endLine ?? e.evidence.line)
  })

  const flowIds = new Set<string>()
  m.flows.forEach((f, i) => {
    const p = `flows[${i}]`
    if (!f || typeof f.id !== 'string') {
      err(p, 'needs an id')
      return
    }
    if (flowIds.has(f.id)) err(p, `duplicate flow id "${f.id}"`)
    flowIds.add(f.id)
    if (!f.entry) err(p, `flow "${f.id}" needs an entry, such as "POST /checkout"`)
    if (!nodeIds.has(f.entryNode)) err(p, `flow "${f.id}" starts at unknown node "${f.entryNode}"`)
    if (!Array.isArray(f.steps) || f.steps.length === 0) {
      err(p, `flow "${f.id}" has no steps`)
      return
    }
    const visited = new Set<string>([f.entryNode])
    f.steps.forEach((s, j) => {
      const edge = m.edges.find(e => edgeId(e) === s.edge)
      if (!edge) {
        err(`${p}.steps[${j}]`, `step walks unknown edge "${s.edge}"`)
        return
      }
      if (!s.title) warn(`${p}.steps[${j}]`, 'step needs a title the engineer can read')
      if (!visited.has(edge.from)) {
        warn(`${p}.steps[${j}]`, `step starts at "${edge.from}", which no earlier step reached`)
      }
      visited.add(edge.from)
      visited.add(edge.to)
    })
  })

  return { ok: errors.length === 0, errors, warnings }
}

export function formatReport(report: ValidationReport): string {
  const lines: string[] = [report.ok ? 'Model is valid.' : `Model has ${report.errors.length} error(s).`]
  for (const e of report.errors) lines.push(`  error   ${e.path || '(root)'}: ${e.message}`)
  for (const w of report.warnings) lines.push(`  warning ${w.path || '(root)'}: ${w.message}`)
  return lines.join('\n')
}
