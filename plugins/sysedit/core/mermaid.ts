// Mermaid rendering, for checking a map in a terminal, a PR description or
// an ADR without the editor. Inferred edges are dashed; external nodes are
// drawn as stadiums; a proposed model colours what the engineer changed.

import type { ProposedModel } from './changeset.ts'
import { flowSlice, type SystemModel } from './model.ts'

const safeId = (id: string) => id.replace(/[^A-Za-z0-9_]/g, '_')
const text = (s: string) => s.replace(/"/g, '#quot;').replace(/[<>]/g, '')

export function toMermaid(model: SystemModel | ProposedModel, opts: { flow?: string; title?: string } = {}): string {
  const m = opts.flow ? flowSlice(model as SystemModel, opts.flow) : model
  const lines: string[] = []
  if (opts.title) lines.push('---', `title: ${text(opts.title)}`, '---')
  lines.push('flowchart TD')
  for (const n of m.nodes) {
    const label = n.detail ? `${text(n.label)}<br/><small>${text(n.detail)}</small>` : text(n.label)
    const shape = n.external || n.kind === 'external' ? [`([`, `])`] : n.kind === 'datastore' ? ['[(', ')]'] : n.kind === 'topic' ? ['[/', '/]'] : ['[', ']']
    lines.push(`  ${safeId(n.id)}${shape[0]}"${label}"${shape[1]}`)
  }
  const classes: Record<string, string[]> = { added: [], removed: [], modified: [] }
  const linkStyles: string[] = []
  m.edges.forEach((e, i) => {
    const label = e.when ?? e.label
    const arrow = e.confidence === 'inferred' ? '-.->' : '-->'
    lines.push(`  ${safeId(e.from)} ${arrow}${label ? `|"${text(label)}"|` : ''} ${safeId(e.to)}`)
    const mark = (e as { mark?: string }).mark
    if (mark === 'added') linkStyles.push(`  linkStyle ${i} stroke:#1D7347,stroke-width:2px`)
    if (mark === 'removed') linkStyles.push(`  linkStyle ${i} stroke:#B42318,stroke-width:2px,stroke-dasharray:4 4`)
    if (e.confidence === 'inferred' && !mark) linkStyles.push(`  linkStyle ${i} stroke:#B26B00`)
  })
  for (const n of m.nodes) {
    const mark = (n as { mark?: string }).mark
    if (mark && classes[mark]) classes[mark].push(safeId(n.id))
  }
  lines.push(...linkStyles)
  lines.push('  classDef added fill:#E7F3EC,stroke:#1D7347,stroke-width:2px')
  lines.push('  classDef removed fill:#FBE9E7,stroke:#B42318,stroke-dasharray:4 4')
  lines.push('  classDef modified fill:#FBF0DE,stroke:#8F5400')
  for (const [name, ids] of Object.entries(classes)) {
    if (ids.length > 0) lines.push(`  class ${ids.join(',')} ${name}`)
  }
  return lines.join('\n')
}
