// The editor's side of the MCP Apps protocol (io.modelcontextprotocol/ui):
// JSON-RPC 2.0 over postMessage with the chat host that renders it. The
// host proxies `tools/call` to the sysedit server, tells the view how it is
// displayed and themed, and relays `ui/message` into the conversation.

type Json = Record<string, unknown>

export type HostContext = {
  theme?: 'light' | 'dark'
  displayMode?: 'inline' | 'fullscreen' | 'pip'
  availableDisplayModes?: string[]
  containerDimensions?: { width?: number; maxWidth?: number; height?: number; maxHeight?: number }
  platform?: 'web' | 'desktop' | 'mobile'
  styles?: { variables?: Record<string, string | undefined> }
}

export type ToolCallResult = {
  content?: { type: string; text?: string }[]
  structuredContent?: Json
  isError?: boolean
}

const PROTOCOL = '2026-01-26'

export class AppHost {
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private listeners = new Map<string, Set<(params: any) => void>>()
  context: HostContext = {}
  /** The arguments the model called show_editor with, once the host sends them. */
  toolInput: Promise<Json>
  readonly ready: Promise<void>

  constructor(private readonly target: Window = window.parent) {
    let gotInput: (v: Json) => void = () => {}
    this.toolInput = new Promise(resolve => (gotInput = resolve))
    // A host that never sends the input must not hold the editor up.
    setTimeout(() => gotInput({}), 1500)
    this.on('ui/notifications/tool-input', p => gotInput((p?.arguments as Json) ?? {}))
    this.on('ui/notifications/host-context-changed', p => {
      this.context = { ...this.context, ...(p as HostContext) }
      this.applyTheme()
    })
    window.addEventListener('message', this.receive)
    this.ready = this.initialize()
  }

  private receive = (event: MessageEvent) => {
    if (event.source !== this.target) return
    const msg = event.data as { jsonrpc?: string; id?: number | string; method?: string; params?: any; result?: any; error?: { message?: string } }
    if (!msg || msg.jsonrpc !== '2.0') return
    if (msg.method && msg.id !== undefined) {
      // Requests from the host: answer the ones the spec defines for views.
      if (msg.method === 'ui/resource-teardown' || msg.method === 'ping') this.post({ jsonrpc: '2.0', id: msg.id, result: {} })
      else this.post({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
      return
    }
    if (msg.method) {
      for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params)
      return
    }
    const waiting = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined
    if (!waiting) return
    this.pending.delete(msg.id as number)
    if (msg.error) waiting.reject(new Error(msg.error.message ?? 'host error'))
    else waiting.resolve(msg.result)
  }

  private post(message: Json) {
    this.target.postMessage(message, '*')
  }

  request<T = any>(method: string, params?: Json): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.post({ jsonrpc: '2.0', id, method, ...(params && { params }) })
    })
  }

  notify(method: string, params?: Json) {
    this.post({ jsonrpc: '2.0', method, ...(params && { params }) })
  }

  on(method: string, fn: (params: any) => void): () => void {
    const set = this.listeners.get(method) ?? new Set()
    set.add(fn)
    this.listeners.set(method, set)
    return () => set.delete(fn)
  }

  private async initialize() {
    const result = await this.request<{ hostContext?: HostContext }>('ui/initialize', {
      appInfo: { name: 'System Editor', version: '0.1.0' },
      appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
      protocolVersion: PROTOCOL,
    })
    this.context = result?.hostContext ?? {}
    this.applyTheme()
    this.notify('ui/notifications/initialized')
    this.reportSize()
  }

  private applyTheme() {
    const root = document.documentElement
    if (this.context.theme) root.dataset.theme = this.context.theme
    root.dataset.display = this.context.displayMode ?? 'inline'
    const fixedHeight = this.context.containerDimensions?.height
    root.classList.toggle('fixed-height', fixedHeight !== undefined || this.context.displayMode === 'fullscreen')
  }

  /** Keep the host's iframe the size of the content. */
  private reportSize() {
    let last = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const send = () => {
      const width = Math.ceil(document.documentElement.scrollWidth)
      const height = Math.ceil(document.documentElement.scrollHeight)
      const key = `${width}x${height}`
      if (key === last) return
      last = key
      this.notify('ui/notifications/size-changed', { width, height })
    }
    new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(send, 50)
    }).observe(document.body)
    send()
  }

  async callTool(name: string, args: Json = {}): Promise<Json> {
    await this.ready
    const r = await this.request<ToolCallResult>('tools/call', { name, arguments: args })
    const text = r?.content?.map(c => c.text ?? '').join('\n') ?? ''
    if (r?.isError) throw new Error(text || `${name} failed`)
    if (r?.structuredContent) return r.structuredContent
    try {
      return JSON.parse(text)
    } catch {
      return { text }
    }
  }

  /** Say something in the conversation as the engineer, which starts Claude's next turn. */
  async say(text: string) {
    await this.ready
    return this.request('ui/message', { role: 'user', content: { type: 'text', text } })
  }

  /** Keep the model's view of the editor current without starting a turn. */
  async updateContext(text: string) {
    await this.ready
    return this.request('ui/update-model-context', { content: [{ type: 'text', text }] }).catch(() => undefined)
  }

  canFullscreen() {
    return (this.context.availableDisplayModes ?? []).includes('fullscreen')
  }

  async setDisplayMode(mode: 'inline' | 'fullscreen') {
    const r = await this.request<{ mode?: HostContext['displayMode'] }>('ui/request-display-mode', { mode })
    this.context = { ...this.context, displayMode: r?.mode ?? this.context.displayMode }
    this.applyTheme()
    return this.context.displayMode
  }
}
