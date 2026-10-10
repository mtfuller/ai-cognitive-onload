// The in-chat editor, end to end: the real ui://sysedit/editor page in a
// sandboxed iframe, a mock MCP Apps host, and a real sysedit server.

import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Sysedit } from '../src/node/service.ts'
import { FRAUD_INTENT, FRAUD_OPS, fraudQuestions } from '../tests/helpers/fixture.ts'
import { openHost, type Host, type HostOptions } from './apps-host.ts'

let host: Host | undefined
const errors: string[] = []

async function open(page: Page, opts: HostOptions = {}) {
  page.on('pageerror', e => errors.push(e.message))
  host = await openHost(page, opts)
  const view = page.frameLocator('#view')
  await expect(view.locator('.top')).toBeVisible()
  await settled(page)
  return { host, view }
}

/** Wait until the host has stopped resizing the iframe to the view's reported size. */
async function settled(page: Page) {
  let last = ''
  await expect
    .poll(
      async () => {
        const now = await page.locator('#view').evaluate(el => (el as any).style.height)
        const same = now === last && now !== '400px'
        last = now
        return same
      },
      { intervals: [250] },
    )
    .toBe(true)
}

const changeFile = (dir: string, id: string) => JSON.parse(readFileSync(join(dir, '.sysedit', 'changes', `${id}.json`), 'utf8'))

test.afterEach(async () => {
  await host?.close()
  host = undefined
  expect(errors.splice(0), 'no uncaught errors in the view').toEqual([])
})

test('traces the checkout flow inline, with code read through the host', async ({ page }) => {
  const { host, view } = await open(page)
  await expect(view.getByRole('heading', { level: 1 })).toContainText('POST /checkout, as it works today')
  await view.getByRole('button', { name: 'Next step' }).click()
  await view.getByRole('button', { name: 'Next step' }).click()
  await expect(view.getByTestId('step-count')).toHaveText('Step 3 of 8')
  // No snippet on that step's evidence was needed: the code arrived via app_source.
  await expect(view.locator('pre.code')).toContainText('this.inventory.reserve(')
  const calls = await host.calls()
  expect(calls).toContain('app_state')
  expect(calls.every(c => c.startsWith('app_'))).toBe(true)
  // The view fits the chat column: no horizontal page overflow.
  const overflow = await view.locator('html').evaluate(el => el.scrollWidth - el.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
})

test('opens on the tab show_editor asked for, and follows the host theme', async ({ page }) => {
  const { view } = await open(page, { tab: 'edit', theme: 'dark', change: { id: '0001-fraud-check', status: 'draft' } })
  await expect(view.getByRole('heading', { level: 1 })).toContainText('Your change')
  await expect(view.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('the engineer draws and submits in chat, and Claude is told to review it', async ({ page }) => {
  const { host, view } = await open(page, { tab: 'edit', change: { id: '0001-fraud-check', status: 'draft' } })
  await view.locator('.left').getByRole('button', { name: 'Service', exact: true }).click()
  await view.getByLabel('Name').fill('FraudService.score')
  await view.getByLabel('Name').press('Enter')
  await view.getByRole('toolbar').getByRole('button', { name: 'Connect' }).click()
  await view.locator('[data-node="checkout.placeOrder"]').click()
  await view.locator('[data-node="fraudService.score"]').click()
  await view.getByLabel("What you're trying to do").fill(FRAUD_INTENT)
  await view.getByRole('button', { name: "Submit for Claude's review" }).click()

  await expect.poll(() => host.messages()).toEqual([
    "I've drawn my change in the System Editor and submitted it for review. Please review it.",
  ])
  const cs = changeFile(host.dir, '0001-fraud-check')
  expect(cs.status).toBe('in-review')
  expect(cs.ops.map((o: { op: string; by: string }) => `${o.op}:${o.by}`)).toEqual(['addNode:engineer', 'addEdge:engineer'])
  // Claude's context follows what the engineer drew, without a new turn.
  await expect.poll(() => host.context()).toMatch(/Drawn by the engineer: New service FraudService.score; CheckoutService.placeOrder → FraudService.score/)
})

test('questions Claude asks appear in the chat view; answers and approval go back as the engineer’s', async ({ page }) => {
  const { host, view } = await open(page, {
    tab: 'grill',
    change: { id: '0001-fraud-check', status: 'in-review', ops: FRAUD_OPS, intent: FRAUD_INTENT },
  })
  await expect(view.getByRole('heading', { level: 1 })).toHaveText('Claude is reviewing your change')
  // Claude asks while the view is open: it picks them up without a reload.
  new Sysedit(host.dir).addQuestions(fraudQuestions())
  await expect(view.getByTestId('grill-progress')).toHaveText('0 of 3 answered · 2 blocking left', { timeout: 10_000 })

  await view.locator('[data-question="q2"] [data-option="closed"]').click()
  await view.locator('[data-question="q3"] [data-option="extend"]').click()
  await expect(view.getByTestId('grill-progress')).toHaveText('2 of 3 answered · 0 blocking left')
  await view.getByRole('button', { name: 'Approve and generate implementation plan' }).click()

  await expect.poll(() => host.messages()).toEqual([
    "I've answered the review and approved the change in the System Editor. Plan it and build it.",
  ])
  expect(changeFile(host.dir, '0001-fraud-check').status).toBe('approved')
  await expect.poll(() => host.context()).toMatch(/Answers: q2: Fail closed: hold the order for review; q3: Keep it reserved until a reviewer decides/)
})

test('the engineer can take the editor fullscreen and back', async ({ page }) => {
  const { host, view } = await open(page)
  await view.getByRole('button', { name: 'Expand' }).click()
  await expect.poll(() => host.displayMode()).toBe('fullscreen')
  await view.getByRole('button', { name: 'Back to chat' }).click()
  await expect.poll(() => host.displayMode()).toBe('inline')
})
