// The System Editor app: one header with the four stages, and the screen for
// the stage picked. State comes from the local server and follows .sysedit/
// as Claude writes to it.

import { render } from 'preact'
import { useCallback, useEffect, useState } from 'preact/hooks'

import { api, type AppState } from './api.ts'
import { Edit } from './Edit.tsx'
import { Grill } from './Grill.tsx'
import { Plan } from './Plan.tsx'
import { Trace } from './Trace.tsx'

type Tab = 'trace' | 'edit' | 'grill' | 'plan'

function defaultTab(state: AppState): Tab {
  switch (state.status.stage) {
    case 'edit':
      return 'edit'
    case 'grill':
      return 'grill'
    case 'implement':
    case 'verify':
    case 'done':
      return 'plan'
    default:
      return 'trace'
  }
}

function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab | null>(() => (new URLSearchParams(location.search).get('tab') as Tab) || null)
  const [focus, setFocus] = useState<string | null>(null)

  const refresh = useCallback(() => {
    api
      .state()
      .then(s => {
        setState(s)
        setError(null)
      })
      .catch(e => setError(String(e.message ?? e)))
  }, [])

  useEffect(() => {
    refresh()
    const off = api.subscribe(refresh)
    // Belt and braces: a watcher can miss writes on some file systems.
    const timer = setInterval(refresh, 5000)
    return () => {
      off()
      clearInterval(timer)
    }
  }, [])

  if (error && !state) return <div class="body"><div class="main"><div class="error">{error}</div></div></div>
  if (!state) return <p class="boot">Loading System Editor…</p>

  const current = tab ?? defaultTab(state)
  const view = state.change
  const open = view?.change.questions.filter(q => q.severity === 'blocking' && q.status === 'open').length ?? 0
  const go = (t: Tab) => {
    setTab(t)
    const u = new URL(location.href)
    u.searchParams.set('tab', t)
    history.replaceState(null, '', u)
  }

  const stages: { id: Tab; label: string; enabled: boolean; count?: number }[] = [
    { id: 'trace', label: '1 Trace', enabled: !!state.model },
    { id: 'edit', label: '2 Edit', enabled: !!view && !!state.model },
    { id: 'grill', label: '3 Grill', enabled: !!view && view.change.status !== 'draft', count: open },
    { id: 'plan', label: '4 Plan', enabled: !!view && ['approved', 'implemented', 'verified'].includes(view.change.status) },
  ]

  let screen
  if (!state.model) {
    screen = (
      <div class="empty">
        <b>No map yet.</b>
        <span>Ask Claude to map the part of the system your request touches: <span class="mono">/sysedit:map</span></span>
      </div>
    )
  } else if (current === 'trace' || !view) {
    screen = <Trace model={state.model} focus={focus} />
  } else if (current === 'edit') {
    screen = <Edit model={state.model} view={view} onSubmitted={() => { refresh(); go('grill') }} />
  } else if (current === 'grill') {
    screen = (
      <Grill
        model={state.model}
        view={view}
        onBack={() => go('edit')}
        onTrace={target => { setFocus(target); go('trace') }}
        onApproved={() => { refresh(); go('plan') }}
      />
    )
  } else {
    screen = <Plan view={view} />
  }

  return (
    <>
      <header class="top">
        <div class="brand">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <rect x="2" y="2" width="6" height="6" rx="1" />
            <rect x="12" y="12" width="6" height="6" rx="1" />
            <path d="M8 5 H15 V12" />
          </svg>
          <b>System Editor</b>
          <span class="repo">
            {state.status.repo} @ {state.model?.commit ?? state.status.head}
            {state.status.model?.stale ? ' (map is behind HEAD)' : ''}
          </span>
        </div>
        <nav class="stages" aria-label="Stages">
          {stages.map(s => (
            <button key={s.id} type="button" aria-current={current === s.id ? 'page' : undefined} disabled={!s.enabled} onClick={() => go(s.id)}>
              {s.label}
              {s.count ? <span class="count">{s.count}</span> : null}
            </button>
          ))}
        </nav>
        {view && (
          <div class="request">
            <span>Request</span>
            <span>“{view.change.request}”</span>
          </div>
        )}
      </header>
      {error && <div class="error" style={{ margin: '8px 24px' }}>{error}</div>}
      {screen}
    </>
  )
}

render(<App />, document.getElementById('app')!)
