// The gate: nothing outside .sysedit/ is written until the engineer has drawn
// the change and answered the blocking questions about it. Pure, so the mod,
// the settings-hook script and the tests share one decision.

import { approvalBlockers, openBlocking, suggestedOps, touchedFiles, type ChangeSet } from './changeset.ts'
import type { SystemModel } from './model.ts'

export type Stage = 'idle' | 'map' | 'edit' | 'grill' | 'implement' | 'verify' | 'done' | 'skipped'

export const STAGE_LABEL: Record<Stage, string> = {
  idle: 'No change in progress',
  map: 'Mapping',
  edit: 'Drawing the change',
  grill: 'Answering Claude’s questions',
  implement: 'Approved: building',
  verify: 'Built: verifying against the map',
  done: 'Verified',
  skipped: 'Skipped',
}

/** `.sysedit/state.json`: which change is active, and where the editor is. */
export type SyseditState = {
  activeChange: string | null
  editorUrl?: string
  updatedAt?: string
}

export function stageOf(cs: ChangeSet | null | undefined, hasModel = true): Stage {
  if (!cs) return 'idle'
  switch (cs.status) {
    case 'draft':
      return hasModel ? 'edit' : 'map'
    case 'in-review':
      return 'grill'
    case 'approved':
      return 'implement'
    case 'implemented':
      return 'verify'
    case 'verified':
      return 'done'
    case 'skipped':
      return 'skipped'
  }
}

export type GateMode = 'approved-only' | 'strict' | 'off'

export const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const

export type GateInput = {
  tool: string
  /** The path the tool writes, as the tool call names it: absolute or relative to `cwd`. */
  filePath: string | undefined
  /** The project root, absolute. */
  root: string
  cwd?: string
  mode: GateMode
  change: ChangeSet | null
  /** The model the change was drawn on, for strict mode's file list. */
  model?: SystemModel | null
}

export type GateDecision = { allow: true; why: string } | { allow: false; reason: string }

/** Paths the gate never holds: the plugin's own files, and decision records. */
const ALWAYS_OPEN = [/^\.sysedit\//, /^docs\/adr\//]

/** Files strict mode lets through without a box on the map. */
const SUPPORTING = [/(^|\/)(__tests__|tests?|spec|e2e)\//, /\.(test|spec)\.[a-z]+$/, /(^|\/)CHANGELOG\.md$/i]

function normalisePath(p: string): string {
  const parts: string[] = []
  for (const part of p.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return (p.startsWith('/') ? '/' : '') + parts.join('/')
}

/** `filePath` relative to `root`, or null when it is outside the root. */
export function relativeToRoot(filePath: string, root: string, cwd = root): string | null {
  const abs = normalisePath(filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`)
  const base = normalisePath(root)
  if (abs === base) return ''
  if (!abs.startsWith(base.endsWith('/') ? base : `${base}/`)) return null
  return abs.slice(base.length + (base.endsWith('/') ? 0 : 1))
}

export function decide(input: GateInput): GateDecision {
  if (!(WRITE_TOOLS as readonly string[]).includes(input.tool)) return { allow: true, why: 'not a write' }
  if (input.mode === 'off') return { allow: true, why: 'gate is off' }
  if (!input.filePath) return { allow: true, why: 'no path' }
  const rel = relativeToRoot(input.filePath, input.root, input.cwd)
  if (rel === null) return { allow: true, why: 'outside the project' }
  if (ALWAYS_OPEN.some(re => re.test(rel))) return { allow: true, why: 'sysedit’s own files' }

  const cs = input.change
  if (!cs) return { allow: true, why: 'no change in progress' }

  switch (cs.status) {
    case 'skipped':
      return { allow: true, why: 'process skipped, reason logged' }
    case 'verified':
      return { allow: true, why: 'change verified' }
    case 'draft':
      return {
        allow: false,
        reason:
          `System Editor is holding writes to ${rel}: change "${cs.title}" is still being drawn. ` +
          (cs.ops.length === 0
            ? 'Ask the engineer to draw the change on the map (/sysedit:map opens the editor), '
            : 'Ask the engineer to finish the map and submit it for review, ') +
          'or run /sysedit:skip with a reason if this change is too small for the process. Do not write code yet.',
      }
    case 'in-review': {
      const blockers = approvalBlockers(cs)
      const open = openBlocking(cs)
      const suggested = suggestedOps(cs)
      return {
        allow: false,
        reason:
          `System Editor is holding writes to ${rel}: change "${cs.title}" is in review and not approved. ` +
          (open.length > 0
            ? `The engineer has ${open.length} blocking question${open.length === 1 ? '' : 's'} to answer (${open.map(q => q.id).join(', ')}). `
            : suggested.length > 0
              ? `${suggested.length} operation(s) you suggested still need the engineer's acceptance. `
              : `It still needs: ${blockers.join('; ')}. `) +
          'Do not answer the questions yourself; ask the engineer, record their answers, then approve.',
      }
    }
    case 'approved':
    case 'implemented': {
      if (input.mode !== 'strict' || !input.model) return { allow: true, why: 'change approved' }
      const files = touchedFiles(input.model, cs)
      if (files.includes(rel) || SUPPORTING.some(re => re.test(rel))) return { allow: true, why: 'on the approved map' }
      if (cs.plan?.some(t => t.files.includes(rel))) return { allow: true, why: 'in the approved plan' }
      return {
        allow: false,
        reason:
          `System Editor (strict) is holding writes to ${rel}: it isn't on the approved map for "${cs.title}". ` +
          `The map covers ${files.length > 0 ? files.join(', ') : 'no files yet'}. ` +
          'Ask the engineer whether this file belongs to the change; if so, they add it to the map, or name it in the plan.',
      }
    }
  }
}
