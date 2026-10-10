// A minimal MCP Apps host for testing the in-chat editor: it loads the real
// ui://sysedit/editor page into a sandboxed iframe, answers the view's
// JSON-RPC over postMessage, and proxies tools/call to a real sysedit MCP
// server process, as Claude desktop would. It records what the view says
// to the conversation and to the model's context.

import type { Page } from '@playwright/test'

import { goldenModel, makeRepo, seed } from '../tests/helpers/fixture.ts'
import { McpClient } from '../tests/helpers/mcp.ts'
import type { ChangeSet } from '../plugins/sysedit/core/changeset.ts'

export type HostOptions = {
  tab?: string
  theme?: 'light' | 'dark'
  width?: number
  change?: Partial<ChangeSet> & { id: string }
}

export type Host = {
  dir: string
  mcp: McpClient
  /** Tool calls the view made through the host, by name. */
  calls: () => Promise<string[]>
  /** ui/message texts the view sent to the conversation. */
  messages: () => Promise<string[]>
  /** The latest ui/update-model-context text. */
  context: () => Promise<string>
  displayMode: () => Promise<string>
  close: () => Promise<void>
}

const HOST_PAGE = (width: number) => `<!doctype html>
<html><body style="margin:0;background:#ddd">
<iframe id="view" sandbox="allow-scripts" style="border:0;width:${width}px;height:400px;background:#fff"></iframe>
<script>
  window.__calls = []; window.__messages = []; window.__context = ''; window.__mode = 'inline'
  const frame = document.getElementById('view')
  const reply = (id, result) => frame.contentWindow.postMessage({ jsonrpc: '2.0', id, result }, '*')
  const fail = (id, message) => frame.contentWindow.postMessage({ jsonrpc: '2.0', id, error: { code: -32000, message } }, '*')
  const notify = (method, params) => frame.contentWindow.postMessage({ jsonrpc: '2.0', method, params }, '*')
  window.addEventListener('message', async event => {
    if (event.source !== frame.contentWindow) return
    const m = event.data
    if (!m || m.jsonrpc !== '2.0') return
    switch (m.method) {
      case 'ui/initialize':
        return reply(m.id, {
          protocolVersion: '2026-01-26',
          hostInfo: { name: 'sysedit-test-host', version: '0' },
          hostCapabilities: { serverTools: {}, serverResources: {}, openLinks: {}, logging: {} },
          hostContext: window.__hostContext,
        })
      case 'ui/notifications/initialized':
        notify('ui/notifications/tool-input', { arguments: window.__toolInput })
        notify('ui/notifications/tool-result', window.__toolResult)
        return
      case 'tools/call': {
        window.__calls.push(m.params.name)
        // A host proxies only app-visible tools from the view.
        if (!window.__appTools.includes(m.params.name)) return fail(m.id, 'tool not callable from the app: ' + m.params.name)
        try { return reply(m.id, await window.mcpCall(m.params)) } catch (e) { return fail(m.id, String(e)) }
      }
      case 'ui/message':
        window.__messages.push(m.params.content.text)
        return reply(m.id, {})
      case 'ui/update-model-context':
        window.__context = m.params.content.map(c => c.text).join('\\n')
        return reply(m.id, {})
      case 'ui/request-display-mode':
        window.__mode = m.params.mode
        frame.style.width = m.params.mode === 'fullscreen' ? '100vw' : '${width}px'
        return reply(m.id, { mode: m.params.mode })
      case 'ui/notifications/size-changed':
        frame.style.height = Math.min(m.params.height, 20000) + 'px'
        return
      default:
        if (m.id !== undefined && m.method) return fail(m.id, 'unsupported ' + m.method)
    }
  })
</script>
</body></html>`

export async function openHost(page: Page, opts: HostOptions = {}): Promise<Host> {
  const repo = makeRepo()
  seed(repo.dir, { model: goldenModel(), ...(opts.change && { change: opts.change }) })
  const mcp = new McpClient(repo.dir)
  await mcp.initialize({ apps: true })

  const { tools } = await mcp.request<{ tools: { name: string; _meta?: { ui?: { visibility?: string[] } } }[] }>('tools/list')
  const appTools = tools.filter(t => t._meta?.ui?.visibility?.includes('app')).map(t => t.name)
  const resource = await mcp.request<{ contents: { text: string }[] }>('resources/read', { uri: 'ui://sysedit/editor' })
  const toolInput = { tab: opts.tab ?? 'trace' }
  const toolResult = await mcp.request('tools/call', { name: 'show_editor', arguments: toolInput })

  await page.exposeFunction('mcpCall', (params: unknown) => mcp.request('tools/call', params))
  const width = opts.width ?? 760
  await page.setContent(HOST_PAGE(width))
  await page.evaluate(
    ({ appTools, toolInput, toolResult, theme, width, html }) => {
      const w = globalThis as any
      w.__appTools = appTools
      w.__toolInput = toolInput
      w.__toolResult = toolResult
      w.__hostContext = {
        theme,
        displayMode: 'inline',
        availableDisplayModes: ['inline', 'fullscreen'],
        containerDimensions: { width, maxHeight: 20000 },
        platform: 'desktop',
      }
      ;w.document.getElementById("view").srcdoc = html
    },
    { appTools, toolInput, toolResult, theme: opts.theme ?? 'light', width, html: resource.contents[0]!.text },
  )

  return {
    dir: repo.dir,
    mcp,
    calls: () => page.evaluate(() => (globalThis as any).__calls as string[]),
    messages: () => page.evaluate(() => (globalThis as any).__messages as string[]),
    context: () => page.evaluate(() => (globalThis as any).__context as string),
    displayMode: () => page.evaluate(() => (globalThis as any).__mode as string),
    close: async () => {
      await mcp.close()
      repo.cleanup()
    },
  }
}
