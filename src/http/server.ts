// The editor's local server: serves the web app and a small JSON API over the
// same store the MCP tools use. Bound to 127.0.0.1, every API call carries a
// per-process token, and the Host header must be local, so another site open
// in the browser can't read the map or answer for the engineer.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Op } from '../../plugins/sysedit/core/changeset.ts'
import { Sysedit, SyseditError } from '../node/service.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
}

export function defaultEditorDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [join(here, 'editor'), join(here, '..', '..', 'plugins', 'sysedit', 'dist', 'editor')]
  return candidates.find(d => existsSync(join(d, 'index.html'))) ?? candidates[0]!
}

export type EditorServer = {
  url: string
  port: number
  token: string
  server: Server
  close: () => Promise<void>
}

export async function startEditorServer(
  app: Sysedit,
  opts: { port?: number; editorDir?: string; token?: string } = {},
): Promise<EditorServer> {
  const token = opts.token ?? randomBytes(16).toString('hex')
  const editorDir = opts.editorDir ?? defaultEditorDir()
  const clients = new Set<ServerResponse>()

  const push = (what: string) => {
    for (const res of clients) res.write(`event: changed\ndata: ${JSON.stringify({ what })}\n\n`)
  }
  app.on('changed', push)

  // Claude and the CLI write .sysedit/ from other processes; watch it so the editor follows.
  let watcher: FSWatcher | undefined
  let debounce: NodeJS.Timeout | undefined
  try {
    watcher = watch(app.store.dir, { recursive: true }, () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => push('disk'), 120)
    })
  } catch {
    // .sysedit/ may not exist yet, or recursive watch may be unsupported; the editor also polls.
  }

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res)
    } catch (error) {
      const status = error instanceof SyseditError ? 409 : error instanceof HttpError ? error.status : 500
      send(res, status, { error: error instanceof Error ? error.message : String(error) })
    }
  })

  class HttpError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message)
    }
  }

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(JSON.stringify(body))
  }

  const readBody = async (req: IncomingMessage): Promise<any> => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > 2 * 1024 * 1024) throw new HttpError(413, 'body too large')
      chunks.push(chunk as Buffer)
    }
    if (chunks.length === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new HttpError(400, 'body is not JSON')
    }
  }

  const localHost = (host: string | undefined) => !!host && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!localHost(req.headers.host)) throw new HttpError(403, 'the editor only answers on localhost')
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname

    if (!path.startsWith('/api/')) {
      // Static files. The page reads its token from the URL it was opened with.
      const file = path === '/' ? 'index.html' : normalize(path).replace(/^[/\\]+/, '')
      if (file.includes('..')) throw new HttpError(404, 'not found')
      const abs = join(editorDir, file)
      if (!existsSync(abs)) {
        if (path === '/') throw new HttpError(500, `editor assets are missing from ${editorDir}; run npm run build`)
        throw new HttpError(404, 'not found')
      }
      res.writeHead(200, {
        'content-type': MIME[extname(abs)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
      })
      res.end(readFileSync(abs))
      return
    }

    const given = req.headers['x-sysedit-token'] ?? url.searchParams.get('t')
    if (given !== token) throw new HttpError(401, 'missing or wrong token: open the editor from the link Claude gave you')

    const route = `${req.method} ${path}`
    switch (route) {
      case 'GET /api/events': {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        res.write('retry: 2000\n\n')
        clients.add(res)
        req.on('close', () => clients.delete(res))
        return
      }
      case 'GET /api/state': {
        const status = app.status()
        const model = app.store.readModel()
        let change = null
        try {
          change = status.change ? app.getChange() : null
        } catch {
          change = null
        }
        return send(res, 200, { status, model, change })
      }
      case 'GET /api/source': {
        const file = url.searchParams.get('file') ?? ''
        const start = Number(url.searchParams.get('start') ?? '1')
        const end = Number(url.searchParams.get('end') ?? String(start + 20))
        const lines = app.store.readLines(file, start, end)
        if (!lines) throw new HttpError(404, `can't read ${file}`)
        return send(res, 200, lines)
      }
      case 'PUT /api/change/ops': {
        const body = await readBody(req)
        if (!Array.isArray(body.ops)) throw new HttpError(400, 'ops must be an array')
        return send(res, 200, app.setOps(body.ops as Op[], 'engineer', typeof body.intent === 'string' ? body.intent : undefined))
      }
      case 'POST /api/change/intent': {
        const body = await readBody(req)
        return send(res, 200, app.setIntent(String(body.intent ?? '')))
      }
      case 'POST /api/change/accept-op': {
        const body = await readBody(req)
        return send(res, 200, app.acceptOp(Number(body.index)))
      }
      case 'POST /api/change/remove-op': {
        const body = await readBody(req)
        return send(res, 200, app.removeOp(Number(body.index)))
      }
      case 'POST /api/change/submit':
        return send(res, 200, app.submit())
      case 'POST /api/answer': {
        const body = await readBody(req)
        return send(
          res,
          200,
          app.answer({
            questionId: String(body.questionId ?? ''),
            optionId: body.optionId ? String(body.optionId) : undefined,
            text: body.text ? String(body.text) : undefined,
          }),
        )
      }
      case 'POST /api/rate': {
        const body = await readBody(req)
        if (body.rating !== 'useful' && body.rating !== 'noise') throw new HttpError(400, 'rating is useful or noise')
        return send(res, 200, app.rate(String(body.questionId ?? ''), body.rating))
      }
      case 'POST /api/dismiss': {
        const body = await readBody(req)
        return send(res, 200, app.dismiss(String(body.questionId ?? '')))
      }
      case 'POST /api/approve':
        return send(res, 200, app.approve())
      case 'GET /api/mermaid':
        return send(res, 200, { mermaid: app.mermaid({ proposed: url.searchParams.get('proposed') === '1' }) })
      default:
        throw new HttpError(404, `no route ${route}`)
    }
  }

  const port = opts.port ?? Number(process.env.SYSEDIT_PORT ?? 0)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  const url = `http://127.0.0.1:${actualPort}/?t=${token}`

  return {
    url,
    port: actualPort,
    token,
    server,
    close: () =>
      new Promise<void>(resolve => {
        app.off('changed', push)
        watcher?.close()
        for (const res of clients) res.end()
        clients.clear()
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  }
}
