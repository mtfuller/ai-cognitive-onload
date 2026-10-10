// The in-chat editor, server side: the MCP Apps resource and tools, offered
// only to hosts that render MCP Apps, so a host that doesn't (Claude Code)
// never lists the engineer's buttons as tools the model could press.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FRAUD_INTENT, FRAUD_OPS, fraudQuestions, goldenModel, makeRepo, seed } from '../helpers/fixture.ts'
import { McpClient } from '../helpers/mcp.ts'
import { Sysedit } from '../../src/node/service.ts'

const UI = 'ui://sysedit/editor'
const MIME = 'text/html;profile=mcp-app'

let repo: ReturnType<typeof makeRepo>
let mcp: McpClient

beforeEach(() => {
  repo = makeRepo()
  seed(repo.dir, { model: goldenModel(), change: { id: '0001-fraud-check', status: 'draft' } })
  mcp = new McpClient(repo.dir)
})
afterEach(async () => {
  await mcp.close()
  repo.cleanup()
})

type Listed = { name: string; _meta?: { ui?: { resourceUri: string; visibility?: string[] } } }

describe('a host that does not render MCP Apps (Claude Code)', () => {
  beforeEach(() => mcp.initialize())

  it('lists neither show_editor nor the app-only tools', async () => {
    const { tools } = await mcp.request<{ tools: Listed[] }>('tools/list')
    const names = tools.map(t => t.name)
    expect(names).not.toContain('show_editor')
    expect(names.filter(n => n.startsWith('app_'))).toEqual([])
    expect(tools.every(t => !t._meta)).toBe(true)
  })

  it('refuses a call to an app-only tool, so the model can never press "approve"', async () => {
    await expect(mcp.request('tools/call', { name: 'app_approve', arguments: {} })).rejects.toThrow(/unknown tool app_approve/)
    await expect(mcp.request('tools/call', { name: 'app_answer', arguments: { questionId: 'q2', optionId: 'closed' } })).rejects.toThrow(/unknown tool/)
  })

  it('lists no UI resources', async () => {
    expect(await mcp.request('resources/list')).toEqual({ resources: [] })
  })
})

describe('a host that renders MCP Apps (Claude desktop)', () => {
  beforeEach(() => mcp.initialize({ apps: true }))

  it('links show_editor to the editor resource, visible to the model', async () => {
    const { tools } = await mcp.request<{ tools: Listed[] }>('tools/list')
    const show = tools.find(t => t.name === 'show_editor')!
    expect(show._meta?.ui).toEqual({ resourceUri: UI, visibility: ['model', 'app'] })
  })

  it('marks every engineer action app-only', async () => {
    const { tools } = await mcp.request<{ tools: Listed[] }>('tools/list')
    const appTools = tools.filter(t => t.name.startsWith('app_'))
    expect(appTools.map(t => t.name).sort()).toEqual([
      'app_accept_op',
      'app_answer',
      'app_approve',
      'app_dismiss',
      'app_rate',
      'app_remove_op',
      'app_set_intent',
      'app_set_ops',
      'app_source',
      'app_state',
      'app_submit',
    ])
    for (const t of appTools) expect(t._meta?.ui).toEqual({ resourceUri: UI, visibility: ['app'] })
    // The model's own tools are unchanged and carry no UI metadata.
    expect(tools.find(t => t.name === 'approve_change')?._meta).toBeUndefined()
  })

  it('serves the editor as one self-contained page', async () => {
    const { resources } = await mcp.request<{ resources: { uri: string; mimeType: string }[] }>('resources/list')
    expect(resources).toEqual([expect.objectContaining({ uri: UI, mimeType: MIME })])
    const read = await mcp.request<{ contents: { uri: string; mimeType: string; text: string; _meta: any }[] }>('resources/read', { uri: UI })
    const [page] = read.contents
    expect(page!.mimeType).toBe(MIME)
    expect(page!._meta.ui).toEqual({ csp: {}, prefersBorder: true })
    const html = page!.text
    expect(html).toMatch(/^<!doctype html>/)
    expect(html).toContain('window.__SYSEDIT__ = { transport: "mcp-app" }')
    // Everything inline: nothing the default CSP would block.
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)=/i)
    expect(html.match(/<\/script>/g)).toHaveLength(2)
    expect(html.length).toBeGreaterThan(30_000)
  })

  it('refuses an unknown resource', async () => {
    await expect(mcp.request('resources/read', { uri: 'ui://sysedit/nope' })).rejects.toThrow(/unknown resource/)
  })

  it('show_editor tells the model where things stand, and hands the view the state', async () => {
    const r = await mcp.request<any>('tools/call', { name: 'show_editor', arguments: { tab: 'edit' } })
    expect(r.content[0].text).toMatch(/System Editor is shown in the conversation: Drawing the change/)
    expect(r.structuredContent.status.stage).toBe('edit')
    expect(r.structuredContent.model.flows).toHaveLength(2)
  })

  it('the engineer draws, submits, answers and approves through the app tools', async () => {
    const call = (name: string, args: Record<string, unknown> = {}) => mcp.request<any>('tools/call', { name, arguments: args })
    let r = await call('app_set_ops', { ops: FRAUD_OPS, intent: FRAUD_INTENT })
    expect(r.structuredContent.change.change.ops.every((o: { by: string }) => o.by === 'engineer')).toBe(true)
    await call('app_submit')
    new Sysedit(repo.dir).addQuestions(fraudQuestions())

    r = await call('app_approve')
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/answer 2 more blocking questions first/)

    await call('app_answer', { questionId: 'q2', optionId: 'closed' })
    await call('app_answer', { questionId: 'q3', text: 'keep it reserved until a reviewer decides' })
    r = await call('app_approve')
    expect(r.isError).toBe(false)
    expect(r.structuredContent.change.change.status).toBe('approved')

    const src = await call('app_source', { file: 'src/checkout/service.ts', start: 46, end: 47 })
    expect(src.structuredContent.lines[0]).toMatch(/async placeOrder/)
    const outside = await call('app_source', { file: '../../etc/passwd', start: 1, end: 2 })
    expect(outside.isError).toBe(true)
  })
})
