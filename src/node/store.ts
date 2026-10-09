// Everything sysedit keeps lives in the repository under .sysedit/, so it is
// reviewed and versioned with the code:
//
//   .sysedit/model.json            the current system model
//   .sysedit/cache/<commit>.json   models by commit, for incremental re-maps
//   .sysedit/changes/<id>.json     one change set per change
//   .sysedit/state.json            the active change and the editor's URL
//   .sysedit/skips.jsonl           every skip, with its reason
//   .sysedit/explain-back.jsonl    explain-back checks

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

import type { ChangeSet } from '../../plugins/sysedit/core/changeset.ts'
import type { SyseditState } from '../../plugins/sysedit/core/gate.ts'
import type { ExplainBack, SkipEntry } from '../../plugins/sysedit/core/metrics.ts'
import type { SystemModel } from '../../plugins/sysedit/core/model.ts'
import type { FileFacts } from '../../plugins/sysedit/core/validate.ts'

export const DIR = '.sysedit'

export function resolveRoot(explicit?: string): string {
  const root = explicit ?? process.env.SYSEDIT_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
  return resolve(root)
}

export class Store {
  readonly root: string
  readonly dir: string

  constructor(root?: string) {
    this.root = resolveRoot(root)
    this.dir = join(this.root, DIR)
  }

  path(...parts: string[]) {
    return join(this.dir, ...parts)
  }

  private readJson<T>(file: string): T | null {
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8')) as T
  }

  /** Write via a temporary file and a rename, so a reader never sees half a file. */
  private writeJson(file: string, value: unknown) {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
    renameSync(tmp, file)
  }

  // --- model -------------------------------------------------------------

  readModel(): SystemModel | null {
    return this.readJson<SystemModel>(this.path('model.json'))
  }

  writeModel(model: SystemModel) {
    this.writeJson(this.path('model.json'), model)
    if (model.commit && /^[0-9a-f]{4,40}$/i.test(model.commit)) {
      this.writeJson(this.path('cache', `${model.commit}.json`), model)
    }
  }

  readCachedModel(commit: string): SystemModel | null {
    if (!/^[0-9a-f]{4,40}$/i.test(commit)) return null
    return this.readJson<SystemModel>(this.path('cache', `${commit}.json`))
  }

  // --- change sets -------------------------------------------------------

  readState(): SyseditState {
    return this.readJson<SyseditState>(this.path('state.json')) ?? { activeChange: null }
  }

  writeState(patch: Partial<SyseditState>) {
    const next = { ...this.readState(), ...patch, updatedAt: new Date().toISOString() }
    this.writeJson(this.path('state.json'), next)
    return next
  }

  listChanges(): ChangeSet[] {
    const dir = this.path('changes')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(f => this.readJson<ChangeSet>(join(dir, f))!)
      .filter(Boolean)
  }

  readChange(id: string): ChangeSet | null {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null
    return this.readJson<ChangeSet>(this.path('changes', `${id}.json`))
  }

  writeChange(cs: ChangeSet) {
    if (!/^[A-Za-z0-9_-]+$/.test(cs.id)) throw new Error(`bad change id "${cs.id}"`)
    this.writeJson(this.path('changes', `${cs.id}.json`), cs)
  }

  activeChange(): ChangeSet | null {
    const { activeChange } = this.readState()
    return activeChange ? this.readChange(activeChange) : null
  }

  nextChangeNumber(): number {
    const nums = this.listChanges().map(c => Number.parseInt(c.id, 10)).filter(n => Number.isFinite(n))
    return (nums.length ? Math.max(...nums) : 0) + 1
  }

  // --- logs --------------------------------------------------------------

  private readJsonl<T>(file: string): T[] {
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as T)
  }

  private appendJsonl(file: string, value: unknown) {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify(value) + '\n')
  }

  readSkips() {
    return this.readJsonl<SkipEntry>(this.path('skips.jsonl'))
  }

  logSkip(entry: SkipEntry) {
    this.appendJsonl(this.path('skips.jsonl'), entry)
  }

  readExplainBacks() {
    return this.readJsonl<ExplainBack>(this.path('explain-back.jsonl'))
  }

  logExplainBack(entry: ExplainBack) {
    this.appendJsonl(this.path('explain-back.jsonl'), entry)
  }

  // --- the repository ------------------------------------------------------

  headCommit(): string {
    try {
      return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: this.root, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
    } catch {
      return 'workdir'
    }
  }

  repoName(): string {
    try {
      const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: this.root, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
      const m = url.match(/([^/:]+\/[^/]+?)(\.git)?$/)
      if (m) return m[1]!
    } catch {
      // no remote
    }
    return this.root.split(sep).pop() ?? 'repo'
  }

  branch(): string | undefined {
    try {
      return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.root, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
    } catch {
      return undefined
    }
  }

  /** Files changed since `commit`, for an incremental re-map. */
  changedSince(commit: string): string[] {
    try {
      return execFileSync('git', ['diff', '--name-only', commit, '--'], { cwd: this.root, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .split('\n')
        .filter(Boolean)
    } catch {
      return []
    }
  }

  /**
   * Resolve a repository-relative path, refusing anything that lands outside
   * the root, through `..` or a symbolic link.
   */
  safeResolve(file: string): string | null {
    if (!file || file.includes('\0')) return null
    const abs = resolve(this.root, file)
    const rel = relative(this.root, abs)
    if (rel.startsWith('..') || rel === '' || resolve(rel) === rel) return null
    if (!existsSync(abs)) return null
    try {
      const real = realpathSync(abs)
      const realRoot = realpathSync(this.root)
      if (real !== realRoot && !real.startsWith(realRoot + sep)) return null
      if (!statSync(real).isFile()) return null
      return real
    } catch {
      return null
    }
  }

  /** Lines `start` to `end` of a file, 1-based and inclusive. */
  readLines(file: string, start: number, end: number): { file: string; start: number; lines: string[]; total: number } | null {
    const abs = this.safeResolve(file)
    if (!abs) return null
    const all = readFileSync(abs, 'utf8').split('\n')
    const s = Math.max(1, Math.floor(start))
    const e = Math.min(all.length, Math.max(s, Math.floor(end)), s + 400)
    return { file, start: s, lines: all.slice(s - 1, e), total: all.length }
  }

  /** Line counts for every file a model names, for validation. */
  fileFacts(model: SystemModel): FileFacts {
    const files = new Set<string>()
    for (const n of model.nodes) if (n.source?.file) files.add(n.source.file)
    for (const e of model.edges) if (e.evidence?.file) files.add(e.evidence.file)
    const lineCounts = new Map<string, number>()
    for (const f of files) {
      const abs = this.safeResolve(f)
      if (abs) lineCounts.set(f, readFileSync(abs, 'utf8').split('\n').length)
    }
    return { lineCounts }
  }

  adrDir() {
    return join(this.root, 'docs', 'adr')
  }

  nextAdrNumber(): number {
    const dir = this.adrDir()
    if (!existsSync(dir)) return 1
    const nums = readdirSync(dir)
      .map(f => Number.parseInt(f, 10))
      .filter(n => Number.isFinite(n))
    return (nums.length ? Math.max(...nums) : 0) + 1
  }
}
