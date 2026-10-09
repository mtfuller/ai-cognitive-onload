// sysedit: one entry point for the MCP server, the editor, the settings-hook
// gate and the CI checks. Bundled to plugins/sysedit/dist/sysedit.mjs.

import { readFileSync } from 'node:fs'

import { decide, type GateMode } from '../../plugins/sysedit/core/gate.ts'
import { formatDrift } from '../../plugins/sysedit/core/drift.ts'
import { formatMetrics } from '../../plugins/sysedit/core/metrics.ts'
import type { SystemModel } from '../../plugins/sysedit/core/model.ts'
import { formatReport } from '../../plugins/sysedit/core/validate.ts'
import { startEditorServer } from '../http/server.ts'
import { serveStdio } from '../mcp/server.ts'
import { Sysedit } from '../node/service.ts'

const HELP = `sysedit — System Editor for Claude Code

Usage: sysedit <command> [options]

  mcp                      Run the MCP server on stdio (Claude Code starts this)
  serve [--port N]         Start the editor on localhost and print its URL
  status [--json]          Stage, active change, open blocking questions
  validate [model.json]    Check a model (default .sysedit/model.json) against the code
  mermaid [--flow ID] [--proposed]
                           Print the model, a flow, or the proposed change as Mermaid
  verify --actual FILE     Compare a re-mapped model with the approved change
  skip --reason TEXT       Skip the process for the active change; the reason is logged
  metrics [--json]         Process metrics
  gate                     PreToolUse hook: read the tool call on stdin, hold writes until approved
  ci                       Fail when a change set in .sysedit/ isn't verified or skipped

Options: --root DIR (default: $SYSEDIT_ROOT, $CLAUDE_PROJECT_DIR, or the working directory)
`

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv
  const root = flag(args, 'root')
  const out = (s: string) => process.stdout.write(s.endsWith('\n') ? s : s + '\n')
  const errOut = (s: string) => process.stderr.write(s.endsWith('\n') ? s : s + '\n')

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    out(HELP)
    return 0
  }

  const app = new Sysedit(root)

  switch (command) {
    case 'mcp':
      await serveStdio(app)
      return 0

    case 'serve': {
      const port = flag(args, 'port')
      const server = await startEditorServer(app, { port: port ? Number(port) : undefined })
      app.store.writeState({ editorUrl: server.url })
      out(`System Editor: ${server.url}`)
      await new Promise<void>(resolve => {
        process.once('SIGINT', resolve)
        process.once('SIGTERM', resolve)
      })
      await server.close()
      return 0
    }

    case 'status': {
      const s = app.status()
      if (args.includes('--json')) {
        out(JSON.stringify(s, null, 2))
        return 0
      }
      out(`${s.repo} @ ${s.head} · ${s.stageLabel}`)
      if (s.model) out(`Model: ${s.model.nodes} nodes, ${s.model.edges} edges (${s.model.inferred} inferred) from ${s.model.commit}${s.model.stale ? ' (stale)' : ''}`)
      else out('Model: none yet (run /sysedit:map)')
      if (s.change) {
        out(`Change ${s.change.id}: ${s.change.title} [${s.change.status}, ${s.change.risk ?? '?'} risk]`)
        for (const q of s.change.openBlocking) out(`  blocking ${q.id} · ${q.target}: ${q.question}`)
        for (const b of s.change.blockers) out(`  needs: ${b}`)
      }
      if (s.editorUrl) out(`Editor: ${s.editorUrl}`)
      return 0
    }

    case 'validate': {
      const file = args.find(a => !a.startsWith('--') && a !== root)
      const model = file ? (JSON.parse(readFileSync(file, 'utf8')) as SystemModel) : undefined
      const report = app.validate(model)
      out(formatReport(report))
      return report.ok ? 0 : 1
    }

    case 'mermaid':
      out(app.mermaid({ flow: flag(args, 'flow'), proposed: args.includes('--proposed') }))
      return 0

    case 'verify': {
      const file = flag(args, 'actual')
      const actual = file ? (JSON.parse(readFileSync(file, 'utf8')) as SystemModel) : undefined
      const drift = app.verify(actual)
      out(formatDrift(drift))
      return drift.ok ? 0 : 1
    }

    case 'skip': {
      const reason = flag(args, 'reason')
      if (!reason) {
        errOut('sysedit skip needs --reason "why this change doesn\'t need the process"')
        return 2
      }
      const r = app.skip(reason)
      out(r.change ? `Skipped ${r.change.id}; reason logged.` : 'Skip logged.')
      return 0
    }

    case 'metrics': {
      const m = app.metrics()
      out(args.includes('--json') ? JSON.stringify(m, null, 2) : formatMetrics(m))
      return 0
    }

    case 'gate': {
      // A PreToolUse settings hook, for teams that run without mods. Exit 0 with a JSON decision.
      const input = JSON.parse((await readStdin()) || '{}')
      const mode = (process.env.SYSEDIT_GATE_MODE ?? process.env.CLAUDE_PLUGIN_OPTION_GATE_MODE ?? 'approved-only') as GateMode
      let change = null
      let model = null
      try {
        change = app.store.activeChange()
        model = app.store.readModel()
      } catch {
        // An unreadable .sysedit/ never blocks work.
      }
      const decision = decide({
        tool: String(input.tool_name ?? ''),
        filePath: input.tool_input?.file_path ?? input.tool_input?.notebook_path,
        root: app.store.root,
        cwd: input.cwd ?? app.store.root,
        mode,
        change,
        model,
      })
      if (!decision.allow) {
        out(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: decision.reason,
            },
          }),
        )
      }
      return 0
    }

    case 'ci': {
      const problems: string[] = []
      const report = app.validate()
      if (app.store.readModel() && !report.ok) problems.push(`model: ${report.errors.length} error(s)\n${formatReport(report)}`)
      for (const cs of app.store.listChanges()) {
        if (cs.status === 'verified' || cs.status === 'skipped') continue
        problems.push(`change ${cs.id} is ${cs.status}: verify it (/sysedit:verify) or skip it with a reason before merging`)
        if (cs.drift && !cs.drift.ok) problems.push(formatDrift(cs.drift))
      }
      if (problems.length === 0) {
        out('sysedit: every change set is verified or skipped.')
        return 0
      }
      errOut(problems.join('\n'))
      return 1
    }

    default:
      errOut(`unknown command "${command}"\n\n${HELP}`)
      return 2
  }
}
