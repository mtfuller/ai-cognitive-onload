import { FRAUD_INTENT, FRAUD_OPS, fraudQuestions } from '../tests/helpers/fixture.ts'
import { expect, test } from './fixtures.ts'

test.describe('Trace', () => {
  test('steps through POST /checkout with the code beside each step', async ({ page, editor }) => {
    await editor.open('trace')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('POST /checkout, as it works today')
    await expect(page.getByTestId('step-count')).toHaveText('Step 1 of 8')
    await expect(page.locator('pre.code')).toContainText('path: /checkout')

    await page.getByRole('button', { name: 'Next step' }).click()
    await page.getByRole('button', { name: 'Next step' }).click()
    await page.getByRole('button', { name: 'Next step' }).click()
    await expect(page.getByTestId('step-count')).toHaveText('Step 4 of 8')
    await expect(page.locator('.right h2')).toHaveText('placeOrder charges the customer')
    await expect(page.locator('pre.code')).toContainText('idempotencyKey: `cart:${cart.id}`')
    await expect(page.locator('.node.current')).toContainText('PaymentService.capture')

    // The keyboard works too, and the last step is the inferred one, flagged as such.
    await page.keyboard.press('ArrowRight')
    await page.locator('.path-row').last().click()
    await expect(page.getByTestId('step-count')).toHaveText('Step 8 of 8')
    await expect(page.locator('.note')).toContainText("Matched on the topic string 'order.placed'")
    await expect(page.getByRole('button', { name: 'Next step' })).toBeDisabled()
  })

  test('folds the map to modules and services', async ({ page, editor }) => {
    await editor.open('trace')
    await expect(page.locator('.node')).toHaveCount(9)
    await page.getByRole('button', { name: 'Modules' }).click()
    await expect(page.locator('.node', { hasText: 'checkout' }).first()).toBeVisible()
    await expect(page.locator('.node', { hasText: 'CheckoutService.placeOrder' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Services' }).click()
    await expect(page.locator('.node', { hasText: 'orders-api' })).toBeVisible()
  })

  test('switches entry points', async ({ page, editor }) => {
    await editor.open('trace')
    await page.getByRole('button', { name: 'cron release-expired-holds' }).click()
    await expect(page.getByTestId('step-count')).toHaveText('Step 1 of 1')
    await expect(page.locator('pre.code')).toContainText('inventory.release(')
  })
})

test.describe('Edit', () => {
  test.use({ seedChange: { id: '0001-fraud-check', status: 'draft' } })

  test('the engineer draws a change and it is saved as theirs', async ({ page, editor }) => {
    await editor.open('edit')
    await expect(page.getByRole('button', { name: "Submit for Claude's review" })).toBeDisabled()

    // Add a service and name it
    await page.locator('.left').getByRole('button', { name: 'Service', exact: true }).click()
    const name = page.getByLabel('Name')
    await name.fill('FraudService.score')
    await name.press('Enter')
    await page.getByLabel('Lives in').fill('src/fraud/service.ts')
    await page.getByLabel('Lives in').press('Enter')

    // Connect placeOrder → the new service
    await page.getByRole('toolbar').getByRole('button', { name: 'Connect' }).click()
    await page.locator('[data-node="checkout.placeOrder"]').click()
    await expect(page.locator('.hint')).toContainText('now pick the box it goes to')
    await page.locator('[data-node="fraudService.score"]').click()

    // Remove the direct capture
    await page.getByRole('toolbar').getByRole('button', { name: 'Remove' }).click()
    await page.locator('[data-edge="checkout.placeOrder->payments.capture"]').click({ force: true })

    await expect(page.getByTestId('changes').locator('li')).toHaveCount(3)
    await expect(page.getByTestId('changes')).toContainText('New service FraudService.score')
    await expect(page.locator('.node.added')).toContainText('FraudService.score')

    await page.getByLabel("What you're trying to do").fill(FRAUD_INTENT)
    await page.getByRole('button', { name: "Submit for Claude's review" }).click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Claude is reviewing your change')

    const cs = editor.change()
    expect(cs.status).toBe('in-review')
    expect(cs.intent).toBe(FRAUD_INTENT)
    expect(cs.ops.map(o => o.op)).toEqual(['addNode', 'addEdge', 'removeEdge'])
    expect(cs.ops.every(o => o.by === 'engineer')).toBe(true)
  })

  test('undo takes back the last operation', async ({ page, editor }) => {
    await editor.open('edit')
    await page.locator('.left').getByRole('button', { name: 'Datastore' }).click()
    await expect(page.getByTestId('changes').locator('li')).toHaveCount(1)
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(page.getByTestId('changes').locator('li')).toHaveCount(0)
    await expect.poll(() => editor.change().ops.length).toBe(0)
  })

  test('a Claude suggestion is marked and needs the engineer to accept it', async ({ page, editor }) => {
    editor.claude.transcribeOps([{ op: 'addEdge', from: 'checkout.placeOrder', to: 'stripe' }])
    await editor.open('edit')
    await expect(page.getByTestId('changes')).toContainText('suggested by Claude')
    await page.getByRole('button', { name: 'Accept' }).click()
    await expect(page.getByTestId('changes')).not.toContainText('suggested by Claude')
    expect(editor.change().ops[0]!.by).toBe('engineer')
  })
})

test.describe('Grill', () => {
  test.use({ seedChange: { id: '0001-fraud-check', status: 'in-review', ops: FRAUD_OPS, intent: FRAUD_INTENT } })

  test('questions appear live, blocking ones hold approval, answers release it', async ({ page, editor }) => {
    await editor.open('grill')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Claude is reviewing your change')

    // Claude asks while the page is open: it updates without a reload.
    editor.claude.addQuestions(fraudQuestions())
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Claude has 3 questions about your change')
    await expect(page.getByTestId('grill-progress')).toHaveText('0 of 3 answered · 2 blocking left')
    await expect(page.getByRole('button', { name: 'Approve and generate implementation plan' })).toBeDisabled()
    await expect(page.getByTestId('approve-hint')).toContainText('answer 2 more blocking questions first')

    // The evidence pane shows the code behind the selected question.
    await expect(page.locator('.right')).toContainText('FraudService adds a network call inside a 3 s budget')
    await expect(page.locator('.right pre.code').first()).toContainText('timeout: 3s')

    await page.locator('[data-question="q2"] [data-option="closed"]').click()
    await expect(page.locator('[data-question="q2"] .answer')).toContainText('Map updated: timeout branch → OrderHold.create.')
    await page.locator('[data-question="q3"]').getByPlaceholder(/answer|fail closed/).fill('Keep it reserved until a reviewer decides')
    await page.locator('[data-question="q3"]').getByRole('button', { name: 'Answer', exact: true }).click()
    await expect(page.getByTestId('grill-progress')).toHaveText('2 of 3 answered · 0 blocking left')

    await page.locator('[data-question="q2"]').getByRole('button', { name: 'Useful' }).click()
    await page.getByRole('button', { name: 'Approve and generate implementation plan' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Implementation plan')
    await expect(page.locator('.hint')).toContainText('/sysedit:plan')

    const cs = editor.change()
    expect(cs.status).toBe('approved')
    expect(cs.questions.find(q => q.id === 'q2')).toMatchObject({ rating: 'useful', answer: { optionId: 'closed', changedMap: true } })
    expect(cs.questions.find(q => q.id === 'q3')!.answer!.text).toBe('Keep it reserved until a reviewer decides')
  })

  test('"Trace this on the map" opens the step behind the question', async ({ page, editor }) => {
    editor.claude.addQuestions(fraudQuestions())
    await editor.open('grill')
    await page.locator('[data-question="q3"] .qtext').click()
    await page.getByRole('button', { name: 'Trace this on the map' }).click()
    await expect(page.getByTestId('step-count')).toHaveText('Step 3 of 8')
    await expect(page.locator('.node.current')).toContainText('InventoryService.reserve')
  })
})

test('with no map yet, the editor says how to make one', async ({ page, editor }) => {
  const { rmSync } = await import('node:fs')
  rmSync(`${editor.dir}/.sysedit/model.json`)
  await editor.open()
  await expect(page.getByText('No map yet.')).toBeVisible()
})
