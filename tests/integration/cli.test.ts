// The bundled CLI, as CI and a settings hook would run it.

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CLI, FRAUD_INTENT, FRAUD_OPS, goldenModel, makeRepo, seed, writeJson } from '../helpers/fixture.ts'

let repo: ReturnType<typeof makeRepo>

beforeEach(() => {
  repo = makeRepo()
})
afterEach(() => repo.cleanup())

const run = (args: string[], input?: string, env: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args, '--root', repo.dir], { input, env: { ...process.env, ...env }, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

const preToolUse = (file: string, tool = 'Write') =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: join(repo.dir, file), content: 'x' }, cwd: repo.dir, session_id: 's' })

describe('sysedit gate (PreToolUse settings hook)', () => {
  it('says nothing (allow) when no change is active', () => {
    const r = run(['gate'], preToolUse('src/a.ts'))
    expect(r.code).toBe(0)
    expect(r.out).toBe('')
  })

  it('denies with a reason Claude can act on while the change is a draft', () => {
    seed(repo.dir, { change: { id: '0001-fraud', status: 'draft' } })
    const r = run(['gate'], preToolUse('src/a.ts'))
    expect(r.code).toBe(0)
    const out = JSON.parse(r.out)
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/Ask the engineer to draw the change on the map/)
  })

  it('honours the gate mode from the plugin option', () => {
    seed(repo.dir, { change: { id: '0001-fraud', status: 'draft' } })
    expect(run(['gate'], preToolUse('src/a.ts'), { CLAUDE_PLUGIN_OPTION_GATE_MODE: 'off' }).out).toBe('')
  })

  it('in strict mode holds approved writes off the map', () => {
    seed(repo.dir, { change: { id: '0001-fraud', status: 'approved', ops: FRAUD_OPS } })
    expect(run(['gate'], preToolUse('src/fraud/service.ts'), { SYSEDIT_GATE_MODE: 'strict' }).out).toBe('')
    expect(run(['gate'], preToolUse('src/lib/db.ts'), { SYSEDIT_GATE_MODE: 'strict' }).out).toMatch(/isn't on the approved map/)
  })

  it('never blocks work because .sysedit/ is unreadable', () => {
    writeJson(join(repo.dir, '.sysedit', 'state.json'), { activeChange: '0001-x' })
    // The change file it names doesn't exist.
    expect(run(['gate'], preToolUse('src/a.ts')).out).toBe('')
  })
})

describe('status, validate, mermaid, metrics', () => {
  it('validates the model against the code and fails on errors', () => {
    seed(repo.dir)
    expect(run(['validate']).code).toBe(0)
    const bad = goldenModel()
    bad.nodes[7]!.source!.lines = [1, 5000]
    writeJson(join(repo.dir, 'bad.json'), bad)
    const r = run(['validate', join(repo.dir, 'bad.json')])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/out of range/)
  })

  it('prints where things stand', () => {
    seed(repo.dir, { change: { id: '0001-fraud', status: 'draft', ops: FRAUD_OPS, intent: FRAUD_INTENT } })
    const r = run(['status'])
    expect(r.out).toMatch(/Drawing the change/)
    expect(r.out).toMatch(/Change 0001-fraud: Fraud check before capture \[draft, high risk\]/)
    expect(JSON.parse(run(['status', '--json']).out).stage).toBe('edit')
  })

  it('prints a flow as Mermaid', () => {
    seed(repo.dir)
    expect(run(['mermaid', '--flow', 'checkout']).out).toMatch(/gateway\["API Gateway/)
  })

  it('needs a reason to skip', () => {
    seed(repo.dir, { change: { id: '0001-fraud', status: 'draft' } })
    expect(run(['skip']).code).toBe(2)
    expect(run(['skip', '--reason', 'typo only']).out).toMatch(/Skipped 0001-fraud/)
    expect(run(['metrics']).out).toMatch(/Skips: 1/)
  })
})

describe('sysedit ci', () => {
  it('passes with no changes, fails on an unverified change, passes once skipped', () => {
    seed(repo.dir)
    expect(run(['ci']).code).toBe(0)
    seed(repo.dir, { change: { id: '0001-fraud', status: 'approved' } })
    const r = run(['ci'])
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/change 0001-fraud is approved: verify it/)
    run(['skip', '--reason', 'prototype branch, not merging'])
    expect(run(['ci']).code).toBe(0)
  })

  it('prints a Claude desktop config entry that starts this bundle for this repository', () => {
    const r = run(['desktop-config'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)).toEqual({
      mcpServers: { sysedit: { command: process.execPath, args: [CLI, 'mcp'], env: { SYSEDIT_ROOT: repo.dir } } },
    })
  })

  it('prints help and rejects unknown commands', () => {
    expect(run(['help']).out).toMatch(/Usage: sysedit <command>/)
    expect(run(['frobnicate']).code).toBe(2)
  })
})
