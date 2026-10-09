// The editor's client for the local server. The token arrives in the URL the
// engineer opened and goes back on every call as a header.

import type { ChangeSet, Op, ProposedModel } from '../../plugins/sysedit/core/changeset.ts'
import type { Stage } from '../../plugins/sysedit/core/gate.ts'
import type { SystemModel } from '../../plugins/sysedit/core/model.ts'

export type Status = {
  repo: string
  head: string
  stage: Stage
  stageLabel: string
  model: { commit: string; nodes: number; edges: number; inferred: number; flows: number; stale: boolean } | null
  change: { id: string; title: string; status: string; openBlocking: { id: string }[]; blockers: string[] } | null
}

export type ChangeView = {
  change: ChangeSet
  stage: Stage
  proposed: ProposedModel
  files: string[]
  blockers: string[]
  suggestedOps: number[]
}

export type AppState = { status: Status; model: SystemModel | null; change: ChangeView | null }

export type SourceLines = { file: string; start: number; lines: string[]; total: number }

const token = new URLSearchParams(location.search).get('t') ?? ''

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'x-sysedit-token': token, ...(body !== undefined && { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status} ${res.statusText}`)
  return data as T
}

export const api = {
  state: () => call<AppState>('GET', '/api/state'),
  source: (file: string, start: number, end: number) =>
    call<SourceLines>('GET', `/api/source?file=${encodeURIComponent(file)}&start=${start}&end=${end}`),
  setOps: (ops: Op[], intent?: string) => call<ChangeSet>('PUT', '/api/change/ops', { ops, intent }),
  setIntent: (intent: string) => call<ChangeSet>('POST', '/api/change/intent', { intent }),
  acceptOp: (index: number) => call<ChangeSet>('POST', '/api/change/accept-op', { index }),
  removeOp: (index: number) => call<ChangeSet>('POST', '/api/change/remove-op', { index }),
  submit: () => call<ChangeSet>('POST', '/api/change/submit'),
  answer: (questionId: string, args: { optionId?: string; text?: string }) => call<ChangeSet>('POST', '/api/answer', { questionId, ...args }),
  rate: (questionId: string, rating: 'useful' | 'noise') => call<ChangeSet>('POST', '/api/rate', { questionId, rating }),
  dismiss: (questionId: string) => call<ChangeSet>('POST', '/api/dismiss', { questionId }),
  approve: () => call<ChangeSet>('POST', '/api/approve'),
  /** Calls `onChange` whenever .sysedit/ changes, from Claude or the CLI. */
  subscribe: (onChange: () => void) => {
    const es = new EventSource(`/api/events?t=${encodeURIComponent(token)}`)
    es.addEventListener('changed', () => onChange())
    return () => es.close()
  },
}
