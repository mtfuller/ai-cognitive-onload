// Code beside each step: the lines an edge's evidence names, read from the
// repository through the local server, with their line numbers.

import { useEffect, useState } from 'preact/hooks'

import { api } from './api.ts'

export type CodeRef = { file: string; start: number; end: number; snippet?: string }

export function Code({ at }: { at: CodeRef | null }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    if (!at) {
      setText(null)
      return
    }
    if (at.snippet) {
      setText(number(at.snippet.split('\n'), at.start))
      return
    }
    let live = true
    api
      .source(at.file, at.start, at.end)
      .then(r => live && setText(number(r.lines, r.start)))
      .catch(e => live && setError(String(e.message ?? e)))
    return () => {
      live = false
    }
  }, [at?.file, at?.start, at?.end, at?.snippet])

  if (!at) return null
  return (
    <div class="stack" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <span class="filepath">
        {at.file}:{at.start}
        {at.end > at.start ? `–${at.end}` : ''}
      </span>
      {error ? <div class="error">{error}</div> : <pre class="code">{text ?? '…'}</pre>}
    </div>
  )
}

function number(lines: string[], start: number) {
  return lines.map((line, i) => `${String(start + i).padStart(3, ' ')}  ${line}`).join('\n')
}
