// The in-chat editor, as an MCP App (io.modelcontextprotocol/ui). The same
// editor the localhost server serves, bundled into one HTML page that a chat
// host such as Claude desktop renders inline in a sandboxed iframe. The page
// can't reach the network; it reads and writes .sysedit/ through the host,
// by calling the app-only tools below on this server.
//
// The app-only tools are the engineer's own actions: submitting, answering,
// approving. Hosts that render MCP Apps keep them out of the model's tool
// list (visibility ["app"]), and this server lists them only to hosts that
// say they render MCP Apps, so a host that doesn't (Claude Code) never shows
// them to the model.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Op } from '../../plugins/sysedit/core/changeset.ts'
import { defaultEditorDir } from '../http/server.ts'
import { obj, opSchema, type ToolDef } from './tools.ts'

export const UI_EXTENSION = 'io.modelcontextprotocol/ui'
export const UI_MIME = 'text/html;profile=mcp-app'
export const EDITOR_URI = 'ui://sysedit/editor'

const TABS = ['trace', 'edit', 'grill', 'plan']

/** True when the client's initialize request says it renders MCP Apps HTML. */
export function rendersApps(capabilities: unknown): boolean {
  const ext = (capabilities as { extensions?: Record<string, { mimeTypes?: unknown }> } | undefined)?.extensions?.[UI_EXTENSION]
  return Array.isArray(ext?.mimeTypes) && ext.mimeTypes.includes(UI_MIME)
}

export const EDITOR_RESOURCE = {
  uri: EDITOR_URI,
  name: 'System Editor',
  description: 'Trace the flow, draw the change, and answer Claude’s questions, inline in the chat.',
  mimeType: UI_MIME,
}

/**
 * The editor as one self-contained page: its bundle and styles inlined, so
 * it needs nothing from the network under the host's default CSP.
 */
export function editorHtml(editorDir = defaultEditorDir()): string {
  const js = join(editorDir, 'app.js')
  const css = join(editorDir, 'app.css')
  if (!existsSync(js) || !existsSync(css)) throw new Error(`editor assets are missing from ${editorDir}; run npm run build`)
  // Inline text can't close its own tag early.
  const script = readFileSync(js, 'utf8').replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')
  const style = readFileSync(css, 'utf8').replace(/<\/style/gi, '<\\/style')
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<title>System Editor</title>',
    `<style>${style}</style>`,
    '</head>',
    '<body class="in-chat">',
    '<div id="app"><p class="boot">Loading System Editor…</p></div>',
    '<script>window.__SYSEDIT__ = { transport: "mcp-app" }</script>',
    `<script type="module">${script}</script>`,
    '</body>',
    '</html>',
  ].join('\n')
}

export function readEditorResource(editorDir?: string) {
  return {
    contents: [
      {
        uri: EDITOR_URI,
        mimeType: UI_MIME,
        text: editorHtml(editorDir),
        // No external origins: everything is inline, and data comes through the host.
        _meta: { ui: { csp: {}, prefersBorder: true } },
      },
    ],
  }
}

const app = (name: string, description: string, inputSchema: Record<string, unknown>, run: ToolDef['run']): ToolDef => ({
  name,
  description,
  inputSchema,
  ui: { resourceUri: EDITOR_URI, visibility: ['app'] },
  run,
})

const state = (ctx: Parameters<ToolDef['run']>[1]) => ctx.app.editorState() as unknown as Record<string, unknown>

/** The model's way in: show the editor in the conversation. */
export const SHOW_EDITOR: ToolDef = {
  name: 'show_editor',
  description:
    'Show the System Editor inline in this conversation, where the engineer traces the flow on the map, draws the change, and answers your questions. ' +
    'Use it after the map is saved and a change is started, and again whenever the engineer should look at or act on the map. ' +
    '`tab` opens a screen: trace, edit, grill or plan. `focus` names a box to trace to. The engineer acts in the editor; you never act for them.',
  inputSchema: obj({ tab: { type: 'string', enum: TABS }, focus: { type: 'string' } }),
  ui: { resourceUri: EDITOR_URI, visibility: ['model', 'app'] },
  run: (_args, ctx) => {
    const s = ctx.app.editorState()
    const lines = [`System Editor is shown in the conversation: ${s.status.stageLabel}.`]
    if (s.change) {
      const cs = s.change.change
      lines.push(`Change ${cs.id}: ${cs.title} [${cs.status}], ${cs.ops.length} operation(s) drawn, ${cs.questions.length} question(s).`)
      if (s.change.blockers.length && cs.status === 'in-review') lines.push(`Waiting on the engineer: ${s.change.blockers.join('; ')}.`)
    } else if (!s.model) {
      lines.push('There is no map yet: map the code first.')
    }
    return { text: lines.join('\n'), structured: state(ctx) }
  },
}

/** The engineer's actions from the in-chat editor. Hidden from the model. */
export const APP_TOOLS: ToolDef[] = [
  app('app_state', 'The editor’s view of .sysedit/: status, model, and the active change.', obj({}), (_a, ctx) => ({ text: 'state', structured: state(ctx) })),
  app(
    'app_source',
    'Lines of a repository file, for the code beside each step.',
    obj({ file: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' } }, ['file', 'start', 'end']),
    ({ file, start, end }, ctx) => {
      const lines = ctx.app.store.readLines(String(file), Number(start), Number(end))
      if (!lines) return { text: `can't read ${file}`, isError: true }
      return { text: `${file}:${lines.start}`, structured: lines }
    },
  ),
  app(
    'app_set_ops',
    'Save the map the engineer drew, and optionally their intent.',
    obj({ ops: { type: 'array', items: opSchema }, intent: { type: 'string' } }, ['ops']),
    ({ ops, intent }, ctx) => {
      ctx.app.setOps(ops as Op[], 'engineer', typeof intent === 'string' ? intent : undefined)
      return { text: 'saved', structured: state(ctx) }
    },
  ),
  app('app_set_intent', 'Save what the engineer is trying to do.', obj({ intent: { type: 'string' } }, ['intent']), ({ intent }, ctx) => {
    ctx.app.setIntent(String(intent))
    return { text: 'saved', structured: state(ctx) }
  }),
  app('app_accept_op', 'The engineer accepts an operation Claude suggested.', obj({ index: { type: 'integer' } }, ['index']), ({ index }, ctx) => {
    ctx.app.acceptOp(Number(index))
    return { text: 'accepted', structured: state(ctx) }
  }),
  app('app_remove_op', 'The engineer removes an operation from the map.', obj({ index: { type: 'integer' } }, ['index']), ({ index }, ctx) => {
    ctx.app.removeOp(Number(index))
    return { text: 'removed', structured: state(ctx) }
  }),
  app('app_submit', 'The engineer submits the drawn change for review.', obj({}), (_a, ctx) => {
    ctx.app.submit()
    return { text: 'submitted', structured: state(ctx) }
  }),
  app(
    'app_answer',
    'The engineer answers a question: an option, or their own words.',
    obj({ questionId: { type: 'string' }, optionId: { type: 'string' }, text: { type: 'string' } }, ['questionId']),
    ({ questionId, optionId, text }, ctx) => {
      ctx.app.answer({ questionId: String(questionId), optionId: optionId ? String(optionId) : undefined, text: text ? String(text) : undefined })
      return { text: 'answered', structured: state(ctx) }
    },
  ),
  app(
    'app_rate',
    'The engineer rates a question useful or noise.',
    obj({ questionId: { type: 'string' }, rating: { type: 'string', enum: ['useful', 'noise'] } }, ['questionId', 'rating']),
    ({ questionId, rating }, ctx) => {
      ctx.app.rate(String(questionId), rating === 'noise' ? 'noise' : 'useful')
      return { text: 'rated', structured: state(ctx) }
    },
  ),
  app('app_dismiss', 'The engineer dismisses a worth-checking question.', obj({ questionId: { type: 'string' } }, ['questionId']), ({ questionId }, ctx) => {
    ctx.app.dismiss(String(questionId))
    return { text: 'dismissed', structured: state(ctx) }
  }),
  app('app_approve', 'The engineer approves the change from the editor.', obj({}), (_a, ctx) => {
    ctx.app.approve('Approved in the System Editor')
    return { text: 'approved', structured: state(ctx) }
  }),
]
