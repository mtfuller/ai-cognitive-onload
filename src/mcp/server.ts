// A Model Context Protocol server over stdio: newline-delimited JSON-RPC 2.0.
// Written without dependencies so the plugin runs from its bundled file with
// nothing to install.

import { createInterface } from 'node:readline'

import { startEditorServer, type EditorServer } from '../http/server.ts'
import { Sysedit, SyseditError } from '../node/service.ts'
import { TOOLS, type ToolContext } from './tools.ts'

export const SERVER_INFO = { name: 'sysedit', version: '0.1.0' }
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05']

const INSTRUCTIONS =
  'System Editor keeps the engineer designing the change. Claude maps the code (with evidence for every edge), the engineer draws the change in the editor, ' +
  'Claude questions it with evidence, the engineer answers, and only then does Claude plan and build what was approved. Never draw the design or answer questions for the engineer.'

type Rpc = { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: any }

export type McpHandler = (message: Rpc) => Promise<object | null>

export function createHandler(app: Sysedit, opts: { editorDir?: string } = {}): { handle: McpHandler; close: () => Promise<void> } {
  let editor: EditorServer | undefined
  const ctx: ToolContext = {
    app,
    openEditor: async () => (editor ??= await startEditorServer(app, { editorDir: opts.editorDir })),
  }

  const handle: McpHandler = async message => {
    const { id, method, params } = message
    const isRequest = id !== undefined && id !== null
    const reply = (result: unknown) => (isRequest ? { jsonrpc: '2.0', id, result } : null)
    const error = (code: number, text: string) => (isRequest ? { jsonrpc: '2.0', id, error: { code, message: text } } : null)

    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion
        return reply({
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        })
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({
          tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        })
      case 'tools/call': {
        const tool = TOOLS.find(t => t.name === params?.name)
        if (!tool) return error(-32602, `unknown tool ${params?.name}`)
        try {
          const result = await tool.run(params?.arguments ?? {}, ctx)
          return reply({
            content: [{ type: 'text', text: result.text }],
            isError: !!result.isError,
          })
        } catch (e) {
          const text = e instanceof SyseditError ? e.message : `sysedit failed: ${e instanceof Error ? e.message : String(e)}`
          return reply({ content: [{ type: 'text', text }], isError: true })
        }
      }
      default:
        if (!isRequest) return null
        return error(-32601, `method not found: ${method}`)
    }
  }

  return { handle, close: async () => editor?.close() }
}

export async function serveStdio(app: Sysedit, opts: { editorDir?: string } = {}) {
  const { handle, close } = createHandler(app, opts)
  const write = (msg: object) => process.stdout.write(JSON.stringify(msg) + '\n')
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const pending = new Set<Promise<void>>()
  rl.on('line', line => {
    if (!line.trim()) return
    let message: Rpc
    try {
      message = JSON.parse(line)
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      return
    }
    const p = handle(message)
      .then(out => {
        if (out) write(out)
      })
      .catch(e => {
        if (message.id !== undefined) write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(e) } })
      })
      .finally(() => pending.delete(p))
    pending.add(p)
  })
  await new Promise<void>(resolve => rl.once('close', resolve))
  await Promise.allSettled([...pending])
  await close()
}
