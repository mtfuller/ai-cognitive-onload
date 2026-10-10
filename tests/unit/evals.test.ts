// Lints the eval suite without calling a model: every case loads, every
// grader is well formed and names a tool that exists, every scaffold is
// current, and every case the suite promises to cover is there.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { TOOLS } from '../../src/mcp/tools.ts'
import { PLUGIN, ROOT } from '../helpers/fixture.ts'

const EVALS = join(PLUGIN, 'evals')
const cases = readdirSync(EVALS).filter(d => existsSync(join(EVALS, d, 'prompt.md')))
const skills = readdirSync(join(PLUGIN, 'skills'))

/** A small YAML-frontmatter reader: enough for the flat keys and one level of nesting the suite uses. */
function frontmatter(text: string): Record<string, any> {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) throw new Error('no frontmatter')
  const out: Record<string, any> = {}
  let parent: string | null = null
  for (const line of m[1]!.split('\n')) {
    const nested = line.match(/^ {2}(\w+):\s*(.*)$/)
    if (nested && parent) {
      out[parent][nested[1]!] = nested[2]
      continue
    }
    const kv = line.match(/^(\w+):\s*(.*)$/)
    if (!kv) continue
    const [, key, raw] = kv
    if (raw === '') {
      out[key!] = {}
      parent = key!
      continue
    }
    parent = null
    let value: any = raw
    if (/^'.*'$/.test(raw!)) value = raw!.slice(1, -1).replace(/''/g, "'")
    else if (/^\[.*\]$/.test(raw!)) value = raw!.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean)
    else if (/^-?\d+(\.\d+)?$/.test(raw!)) value = Number(raw)
    else if (raw === 'true' || raw === 'false') value = raw === 'true'
    else if (/^".*"$/.test(raw!)) value = JSON.parse(raw!)
    out[key!] = value
  }
  return out
}

const PROMPT_KEYS = ['schema_version', 'name', 'description', 'tags', 'plugins', 'runs', 'expected_outcome', 'model', 'max_turns', 'timeout_seconds', 'allowed_tools', 'append_system_prompt', 'env']
const GRADER_KEYS: Record<string, string[]> = {
  regex: ['pattern', 'flags', 'match', 'target'],
  tool_used: ['tool', 'input_match', 'min', 'max'],
  tool_order: ['before', 'after'],
  file_exists: ['path', 'exists'],
  llm: ['criteria', 'focus'],
  baseline: ['baseline_file', 'criteria'],
}
const BUILTIN_TOOLS = ['Read', 'Glob', 'Grep', 'Skill', 'Agent', 'TodoWrite', 'Write', 'Edit', 'Bash', 'AskUserQuestion']

describe('the eval suite', () => {
  it('covers every model-invocable skill and the gate', () => {
    const tags = new Set(cases.flatMap(c => frontmatter(readFileSync(join(EVALS, c, 'prompt.md'), 'utf8')).tags as string[]))
    for (const s of skills.filter(s => s !== 'skip' && s !== 'record')) expect([...tags], `a case tagged ${s}`).toContain(s)
    expect(tags).toContain('gate')
    expect(tags).toContain('smoke')
    expect(tags).toContain('anti-offloading')
  })

  it('has scaffolds generated from the current seeds and fixture', () => {
    expect(() => execFileSync(process.execPath, [join(ROOT, 'scripts', 'gen-eval-scaffolds.mjs'), '--check'], { stdio: 'pipe' })).not.toThrow()
  })
})

describe.each(cases)('case %s', name => {
  const dir = join(EVALS, name)
  const prompt = readFileSync(join(dir, 'prompt.md'), 'utf8')
  const fm = frontmatter(prompt)

  it('has a prompt with only known frontmatter keys and sane limits', () => {
    for (const key of Object.keys(fm)) expect(PROMPT_KEYS, `unknown key ${key}`).toContain(key)
    expect(prompt.replace(/^---[\s\S]*?---\n/, '').trim().length).toBeGreaterThan(10)
    expect(fm.max_turns).toBeGreaterThan(0)
    expect(fm.max_turns).toBeLessThanOrEqual(200)
    expect(fm.timeout_seconds).toBeLessThanOrEqual(3600)
    expect(fm.tags.length).toBeGreaterThan(0)
  })

  it('has a case.yaml that scaffolds its workspace', () => {
    const yaml = readFileSync(join(dir, 'case.yaml'), 'utf8')
    expect(yaml).toMatch(/^schema_version: "1.1"$/m)
    expect(yaml).toMatch(new RegExp(`^name: ${name}$`, 'm'))
    expect(yaml).toMatch(/scaffold_script: scaffold.sh/)
    expect(existsSync(join(dir, 'scaffold.sh'))).toBe(true)
  })

  const graders = readdirSync(join(dir, 'graders'))
  it('pairs an outcome grader with a process grader', () => {
    const types = graders.map(g => frontmatter(readFileSync(join(dir, 'graders', g), 'utf8')).type)
    expect(types.some(t => t === 'regex' || t === 'file_exists' || t === 'llm')).toBe(true)
    expect(types.some(t => t === 'tool_used' || t === 'tool_order' || t === 'regex')).toBe(true)
  })

  it.each(graders)('grader %s is well formed', g => {
    const text = readFileSync(join(dir, 'graders', g), 'utf8')
    const gfm = frontmatter(text)
    expect(Object.keys(GRADER_KEYS)).toContain(gfm.type)
    for (const key of Object.keys(gfm)) expect(['type', 'weight', 'arm', ...GRADER_KEYS[gfm.type]!], `unknown key ${key}`).toContain(key)
    if (gfm.arm) expect(['with-only', 'both']).toContain(gfm.arm)
    for (const key of ['pattern', 'input_match']) {
      if (gfm[key]) {
        expect(() => new RegExp(gfm[key], gfm.flags ?? '')).not.toThrow()
        expect(gfm[key]).not.toMatch(/\(\?i\)/)
      }
    }
    if (gfm.type === 'tool_used') {
      const tool = String(gfm.tool)
      if (tool.startsWith('mcp__')) {
        expect(tool.startsWith('mcp__plugin_sysedit_sysedit__')).toBe(true)
        expect(TOOLS.map(t => t.name)).toContain(tool.replace('mcp__plugin_sysedit_sysedit__', ''))
      } else {
        expect(BUILTIN_TOOLS).toContain(tool)
      }
      if (gfm.max === 0) expect(gfm.min).toBe(0)
      if (tool === 'Skill' && gfm.input_match) {
        const skill = String(gfm.input_match).match(/\)\?(\w[\w-]*)/)?.[1]
        expect(skills).toContain(skill)
      }
    }
    if (gfm.type === 'llm') {
      const body = text.replace(/^---[\s\S]*?---\n/, '')
      expect(body).toMatch(/PASS if/)
      expect(body).toMatch(/FAIL if/)
    }
  })
})
