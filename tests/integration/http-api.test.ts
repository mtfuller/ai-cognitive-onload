// The editor's local API: it must answer only the engineer's browser, only on
// localhost, and never read outside the repository.

import { request } from 'node:http'
import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startEditorServer, type EditorServer } from '../../src/http/server.ts'
import { Sysedit } from '../../src/node/service.ts'
import { FRAUD_INTENT, FRAUD_OPS, fraudQuestions, makeRepo, PLUGIN, seed } from '../helpers/fixture.ts'

let repo: ReturnType<typeof makeRepo>
let app: Sysedit
let server: EditorServer

beforeEach(async () => {
  repo = makeRepo()
  seed(repo.dir, { change: { id: '0001-fraud-check', status: 'draft' } })
  app = new Sysedit(repo.dir)
  server = await startEditorServer(app, { editorDir: join(PLUGIN, 'dist', 'editor') })
})

afterEach(async () => {
  await server.close()
  repo.cleanup()
})

const api = (path: string, init: RequestInit = {}, token: string | null = server.token) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: { ...(token ? { 'x-sysedit-token': token } : {}), 'content-type': 'application/json', ...(init.headers ?? {}) },
  })

/** fetch() won't let us forge Host, so use node:http for that one. */
function withHost(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path: '/api/state', headers: { host, 'x-sysedit-token': server.token } }, res => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

describe('access', () => {
  it('serves the editor page and its assets', async () => {
    const page = await fetch(server.url)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toMatch(/default-src 'self'/)
    expect(await page.text()).toMatch(/<title>System Editor<\/title>/)
    expect((await fetch(`http://127.0.0.1:${server.port}/app.js`)).status).toBe(200)
  })

  it('refuses API calls without the token', async () => {
    expect((await api('/api/state', {}, null)).status).toBe(401)
    expect((await api('/api/state', {}, 'wrong')).status).toBe(401)
    expect((await api('/api/state')).status).toBe(200)
  })

  it('refuses a request whose Host is not local (DNS rebinding)', async () => {
    expect(await withHost('evil.example.com')).toBe(403)
    expect(await withHost(`localhost:${server.port}`)).toBe(200)
  })

  it('binds to the loopback interface only', () => {
    const addr = server.server.address()
    expect(typeof addr === 'object' && addr?.address).toBe('127.0.0.1')
  })
})

describe('source reading', () => {
  it('reads line ranges from the repository', async () => {
    const r = await api('/api/source?file=src/checkout/service.ts&start=46&end=49')
    const body: any = await r.json()
    expect(body.lines[0]).toMatch(/async placeOrder/)
    expect(body.lines).toHaveLength(4)
  })

  it.each(['../../../etc/passwd', '/etc/passwd', 'src/../../outside.txt', '.git/../../x'])('refuses to read %s', async file => {
    const r = await api(`/api/source?file=${encodeURIComponent(file)}&start=1&end=5`)
    expect(r.status).toBe(404)
  })

  it('refuses to follow a symlink out of the repository', async () => {
    symlinkSync('/etc/hostname', join(repo.dir, 'escape.txt'))
    expect((await api('/api/source?file=escape.txt&start=1&end=2')).status).toBe(404)
  })
})

describe('the engineer’s actions', () => {
  it('draws, submits, answers and approves, as the engineer', async () => {
    let r = await api('/api/change/ops', { method: 'PUT', body: JSON.stringify({ ops: FRAUD_OPS, intent: FRAUD_INTENT }) })
    expect(r.status).toBe(200)
    expect(((await r.json()) as any).ops.every((o: { by: string }) => o.by === 'engineer')).toBe(true)

    expect((await api('/api/change/submit', { method: 'POST' })).status).toBe(200)
    app.addQuestions(fraudQuestions())

    // Approval is refused with the reason while questions are open
    r = await api('/api/approve', { method: 'POST' })
    expect(r.status).toBe(409)
    expect(((await r.json()) as any).error).toMatch(/answer 2 more blocking questions first/)

    await api('/api/answer', { method: 'POST', body: JSON.stringify({ questionId: 'q2', optionId: 'retry' }) })
    await api('/api/answer', { method: 'POST', body: JSON.stringify({ questionId: 'q3', text: 'release on hold' }) })
    await api('/api/rate', { method: 'POST', body: JSON.stringify({ questionId: 'q2', rating: 'useful' }) })
    await api('/api/dismiss', { method: 'POST', body: JSON.stringify({ questionId: 'q4' }) })

    r = await api('/api/approve', { method: 'POST' })
    expect(r.status).toBe(200)
    const state: any = await (await api('/api/state')).json()
    expect(state.status.stage).toBe('implement')
    expect(state.change.change.questions.map((q: { status: string }) => q.status)).toEqual(['answered', 'answered', 'dismissed'])
  })

  it('keeps Claude’s suggestions marked as Claude’s when the engineer saves the rest of the map', async () => {
    app.transcribeOps([{ op: 'addEdge', from: 'checkout.placeOrder', to: 'stripe' }])
    const current = ((await (await api('/api/state')).json()) as any).change.change.ops
    const r = await api('/api/change/ops', { method: 'PUT', body: JSON.stringify({ ops: [...current, FRAUD_OPS[0]] }) })
    const ops = ((await r.json()) as any).ops
    expect(ops.map((o: { by: string }) => o.by)).toEqual(['claude', 'engineer'])
  })

  it('pushes a server-sent event when .sysedit/ changes', async () => {
    const res = await api('/api/events')
    const reader = res.body!.getReader()
    await reader.read() // retry: line
    app.setIntent('A new intent from the CLI')
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toMatch(/event: changed/)
    await reader.cancel()
  })

  it('rejects bad input with a 4xx, not a crash', async () => {
    expect((await api('/api/change/ops', { method: 'PUT', body: '{"ops": "nope"}' })).status).toBe(400)
    expect((await api('/api/change/ops', { method: 'PUT', body: 'not json' })).status).toBe(400)
    expect((await api('/api/rate', { method: 'POST', body: JSON.stringify({ questionId: 'q1', rating: 'meh' }) })).status).toBe(400)
    expect((await api('/api/nope')).status).toBe(404)
  })
})
