// The editor's client. In a browser tab it talks to the localhost server,
// with the token from the URL the engineer opened. Inside a chat host it is
// an MCP App and talks to the same sysedit server through the host.

import type { ChangeSet, Op, ProposedModel } from '../../plugins/sysedit/core/changeset.ts'
import type { Stage } from '../../plugins/sysedit/core/gate.ts'
import type { SystemModel } from '../../plugins/sysedit/core/model.ts'
import { AppHost } from './apphost.ts'

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

/** What every screen calls. Two transports implement it: the localhost server, and the chat host. */
export type Api = {
  state: () => Promise<AppState>
  source: (file: string, start: number, end: number) => Promise<SourceLines>
  /** Resolves to the saved change's `updatedAt`, so the editor can ignore older copies still in flight. */
  setOps: (ops: Op[], intent?: string) => Promise<string | undefined>
  setIntent: (intent: string) => Promise<unknown>
  acceptOp: (index: number) => Promise<unknown>
  removeOp: (index: number) => Promise<unknown>
  submit: () => Promise<unknown>
  answer: (questionId: string, args: { optionId?: string; text?: string }) => Promise<unknown>
  rate: (questionId: string, rating: 'useful' | 'noise') => Promise<unknown>
  dismiss: (questionId: string) => Promise<unknown>
  approve: () => Promise<unknown>
  /** Calls `onChange` whenever .sysedit/ changes, from Claude or the CLI. */
  subscribe: (onChange: () => void) => () => void
  /** Present in a chat host: the conversation the editor is drawn in. */
  chat?: Chat
}

export type Chat = {
  host: AppHost
  /** Tell Claude, as the engineer, what they just did, so its next turn starts. */
  say: (text: string) => Promise<unknown>
  /** Keep Claude's view of the editor current. */
  context: (text: string) => Promise<unknown>
  /** The tab and focus show_editor was called with. */
  input: Promise<{ tab?: string; focus?: string }>
}

// --- the localhost server -----------------------------------------------------

function httpApi(): Api {
  const token = new URLSearchParams(location.search).get('t') ?? ''
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(path, {
      method,
      headers: { 'x-sysedit-token': token, ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status} ${res.statusText}`)
    return data as T
  }
  return {
    state: () => call<AppState>('GET', '/api/state'),
    source: (file, start, end) => call<SourceLines>('GET', `/api/source?file=${encodeURIComponent(file)}&start=${start}&end=${end}`),
    setOps: async (ops, intent) => (await call<ChangeSet>('PUT', '/api/change/ops', { ops, intent })).updatedAt,
    setIntent: intent => call('POST', '/api/change/intent', { intent }),
    acceptOp: index => call('POST', '/api/change/accept-op', { index }),
    removeOp: index => call('POST', '/api/change/remove-op', { index }),
    submit: () => call('POST', '/api/change/submit'),
    answer: (questionId, args) => call('POST', '/api/answer', { questionId, ...args }),
    rate: (questionId, rating) => call('POST', '/api/rate', { questionId, rating }),
    dismiss: questionId => call('POST', '/api/dismiss', { questionId }),
    approve: () => call('POST', '/api/approve'),
    subscribe: onChange => {
      const es = new EventSource(`/api/events?t=${encodeURIComponent(token)}`)
      es.addEventListener('changed', () => onChange())
      return () => es.close()
    },
  }
}

// --- the chat host (MCP Apps) ---------------------------------------------------

function chatApi(): Api {
  const host = new AppHost()
  const tool = (name: string, args?: Record<string, unknown>) => host.callTool(name, args)
  return {
    state: () => tool('app_state') as Promise<AppState>,
    source: (file, start, end) => tool('app_source', { file, start, end }) as Promise<SourceLines>,
    setOps: async (ops, intent) => ((await tool('app_set_ops', { ops, ...(intent !== undefined && { intent }) })) as AppState).change?.change.updatedAt,
    setIntent: intent => tool('app_set_intent', { intent }),
    acceptOp: index => tool('app_accept_op', { index }),
    removeOp: index => tool('app_remove_op', { index }),
    submit: () => tool('app_submit'),
    answer: (questionId, args) => tool('app_answer', { questionId, ...args }),
    rate: (questionId, rating) => tool('app_rate', { questionId, rating }),
    dismiss: questionId => tool('app_dismiss', { questionId }),
    approve: () => tool('app_approve'),
    // No push channel through the host: poll, and refresh when Claude's tool results arrive.
    subscribe: onChange => {
      const timer = setInterval(onChange, 2500)
      const off = host.on('ui/notifications/tool-result', () => onChange())
      return () => {
        clearInterval(timer)
        off()
      }
    },
    chat: {
      host,
      say: text => host.say(text),
      context: text => host.updateContext(text),
      input: host.toolInput as Promise<{ tab?: string; focus?: string }>,
    },
  }
}

declare global {
  interface Window {
    __SYSEDIT__?: { transport?: 'http' | 'mcp-app' }
  }
}

export const inChat = window.__SYSEDIT__?.transport === 'mcp-app'

export const api: Api = inChat ? chatApi() : httpApi()
