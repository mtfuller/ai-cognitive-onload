// Each test gets its own throwaway storefront repo and editor server, started
// through the bundled CLI exactly as `sysedit serve` runs it.

import { test as base, expect } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ChangeSet } from '../plugins/sysedit/core/changeset.ts'
import { Sysedit } from '../src/node/service.ts'
import { CLI, makeRepo, seed } from '../tests/helpers/fixture.ts'

type Editor = {
  dir: string
  url: string
  /** The same store the server uses, for playing Claude's side of the process. */
  claude: Sysedit
  change: () => ChangeSet
  open: (tab?: string) => Promise<void>
}

export const test = base.extend<{ seedChange: Partial<ChangeSet> & { id: string } | null; editor: Editor }>({
  seedChange: [null, { option: true }],
  editor: async ({ page, seedChange }, use) => {
    const repo = makeRepo()
    seed(repo.dir, seedChange ? { change: seedChange } : {})
    const proc: ChildProcess = spawn(process.execPath, [CLI, 'serve', '--root', repo.dir, '--port', '0'])
    const url = await new Promise<string>((resolve, reject) => {
      proc.stdout!.on('data', d => {
        const m = String(d).match(/http:\/\/\S+/)
        if (m) resolve(m[0])
      })
      proc.once('exit', code => reject(new Error(`sysedit serve exited ${code}`)))
    })
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    const claude = new Sysedit(repo.dir)
    await use({
      dir: repo.dir,
      url,
      claude,
      change: () => {
        const id = JSON.parse(readFileSync(join(repo.dir, '.sysedit', 'state.json'), 'utf8')).activeChange
        return JSON.parse(readFileSync(join(repo.dir, '.sysedit', 'changes', `${id}.json`), 'utf8'))
      },
      open: async tab => {
        await page.goto(tab ? `${url}&tab=${tab}` : url)
        await expect(page.locator('.top')).toBeVisible()
      },
    })
    proc.kill()
    repo.cleanup()
    expect(errors, 'no uncaught errors in the page').toEqual([])
  },
})

export { expect }
