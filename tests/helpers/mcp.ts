// A minimal MCP client over stdio, for driving the real bundled server the way
// Claude Code does: spawn `node dist/sysedit.mjs mcp`, initialize, call tools.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

import { CLI } from './fixture.ts'

export type ToolResponse = { content: { type: string; text: string }[]; isError?: boolean; structuredContent?: any }

export class McpClient {
  private proc: ChildProcessWithoutNullStreams
  private nextId = 1
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  stderr = ''

  constructor(root: string, env: Record<string, string> = {}) {
    this.proc = spawn(process.execPath, [CLI, 'mcp'], {
      env: { ...process.env, SYSEDIT_ROOT: root, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.proc.stderr.on('data', d => (this.stderr += String(d)))
    createInterface({ input: this.proc.stdout }).on('line', line => {
      const msg = JSON.parse(line)
      const w = this.waiting.get(msg.id)
      if (!w) return
      this.waiting.delete(msg.id)
      if (msg.error) w.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }))
      else w.resolve(msg.result)
    })
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  notify(method: string, params?: unknown) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  writeRaw(line: string) {
    this.proc.stdin.write(line + '\n')
  }

  /** `apps: true` initializes as a host that renders MCP Apps, such as Claude desktop. */
  async initialize(opts: { apps?: boolean } = {}) {
    const r = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: opts.apps ? { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } : {},
      clientInfo: { name: 'sysedit-tests', version: '0' },
    })
    this.notify('notifications/initialized')
    return r
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResponse & { text: string }> {
    const r = await this.request<ToolResponse>('tools/call', { name, arguments: args })
    return { ...r, text: r.content.map(c => c.text).join('\n') }
  }

  /** Call a tool and parse its text as JSON (for tools that return JSON). */
  async json<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = await this.call(name, args)
    if (r.isError) throw new Error(r.text)
    return JSON.parse(r.text) as T
  }

  async close() {
    this.proc.stdin.end()
    await new Promise<void>(resolve => {
      if (this.proc.exitCode !== null) return resolve()
      const t = setTimeout(() => {
        this.proc.kill()
        resolve()
      }, 3000)
      this.proc.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
    })
  }
}
