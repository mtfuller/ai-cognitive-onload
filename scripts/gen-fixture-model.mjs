// Writes fixtures/storefront.model.json, the hand-checked map of the
// storefront fixture that tests and evals compare against. Line numbers are
// found by searching for marker text, so editing the fixture and re-running
// this keeps the golden model honest.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(root, 'fixtures', 'storefront')
const lines = file => readFileSync(join(repo, file), 'utf8').split('\n')

/** The 1-based line of the first line containing `text`, after line `from`. */
function at(file, text, from = 0) {
  const i = lines(file).findIndex((l, n) => n >= from && l.includes(text))
  if (i < 0) throw new Error(`${file}: no line containing ${JSON.stringify(text)}`)
  return i + 1
}

/** A block from the line containing `start` to the matching closing line at the same indent. */
function block(file, start) {
  const ls = lines(file)
  const first = at(file, start)
  const indent = ls[first - 1].match(/^\s*/)[0]
  for (let i = first; i < ls.length; i++) {
    if (ls[i].startsWith(indent) && /^\s*[}\])]/.test(ls[i]) && ls[i].match(/^\s*/)[0] === indent) return [first, i + 1]
  }
  return [first, ls.length]
}

const snippet = (file, a, b = a) => lines(file).slice(a - 1, b).join('\n')

function ev(file, text, span = 0) {
  const line = at(file, text)
  return { file, line, ...(span ? { endLine: line + span } : {}), snippet: snippet(file, line, line + span) }
}

const routes = 'infra/gateway/routes.yaml'
const controller = 'src/orders/controller.ts'
const checkout = 'src/checkout/service.ts'
const inventory = 'src/inventory/service.ts'
const cron = 'src/inventory/cron.ts'
const payments = 'src/payments/service.ts'
const stripe = 'src/payments/stripe-adapter.ts'
const repository = 'src/orders/repository.ts'
const worker = 'workers/email/index.ts'

const checkoutRoute = at(routes, 'path: /checkout')

const model = {
  version: 1,
  repo: 'acme/storefront',
  branch: 'main',
  commit: 'fixture',
  nodes: [
    { id: 'svc.ordersApi', label: 'orders-api', kind: 'service', source: { file: 'package.json', lines: [1, 10] } },
    { id: 'svc.emailWorker', label: 'email-worker', kind: 'service', source: { file: worker, lines: [1, lines(worker).length - 1] } },
    { id: 'mod.orders', label: 'orders', kind: 'module', parent: 'svc.ordersApi', source: { file: controller, lines: [1, lines(controller).length - 1] } },
    { id: 'mod.checkout', label: 'checkout', kind: 'module', parent: 'svc.ordersApi', source: { file: checkout, lines: [1, lines(checkout).length - 1] } },
    { id: 'mod.inventory', label: 'inventory', kind: 'module', parent: 'svc.ordersApi', source: { file: inventory, lines: [1, lines(inventory).length - 1] } },
    { id: 'mod.payments', label: 'payments', kind: 'module', parent: 'svc.ordersApi', source: { file: payments, lines: [1, lines(payments).length - 1] } },
    {
      id: 'gateway',
      label: 'API Gateway',
      kind: 'config',
      detail: 'routes.yaml · POST /checkout',
      source: { file: routes, lines: [checkoutRoute, checkoutRoute + 5] },
    },
    { id: 'orders.create', label: 'OrderController.create', kind: 'function', parent: 'mod.orders', source: { file: controller, lines: block(controller, 'async create(') } },
    { id: 'checkout.placeOrder', label: 'CheckoutService.placeOrder', kind: 'function', parent: 'mod.checkout', source: { file: checkout, lines: block(checkout, 'async placeOrder(') } },
    { id: 'inventory.reserve', label: 'InventoryService.reserve', kind: 'function', parent: 'mod.inventory', source: { file: inventory, lines: block(inventory, 'async reserve(') } },
    { id: 'inventory.release', label: 'InventoryService.release', kind: 'function', parent: 'mod.inventory', source: { file: inventory, lines: block(inventory, 'async release(') } },
    { id: 'payments.capture', label: 'PaymentService.capture', kind: 'function', parent: 'mod.payments', source: { file: payments, lines: block(payments, 'async capture(') } },
    { id: 'stripe', label: 'Stripe API', kind: 'external', external: true, detail: 'external · PaymentIntents' },
    {
      id: 'orders.save',
      label: 'OrderRepository.save',
      kind: 'function',
      parent: 'mod.orders',
      detail: 'Postgres · orders, outbox',
      source: { file: repository, lines: block(repository, 'async save(') },
    },
    { id: 'bus.orderPlaced', label: 'EventBus', kind: 'topic', detail: 'topic order.placed', source: { file: 'src/lib/outbox-relay.ts', lines: block('src/lib/outbox-relay.ts', 'export async function relayOnce') } },
    {
      id: 'email.sendReceipt',
      label: 'EmailWorker.sendReceipt',
      kind: 'function',
      parent: 'svc.emailWorker',
      detail: worker,
      source: { file: worker, lines: [at(worker, "bus.subscribe('order.placed'"), at(worker, "bus.subscribe('order.placed'") + 3] },
    },
    { id: 'cron.releaseExpiredHolds', label: 'releaseExpiredHolds', kind: 'job', parent: 'mod.inventory', source: { file: cron, lines: block(cron, 'export async function releaseExpiredHolds') } },
  ],
  edges: [
    { from: 'gateway', to: 'orders.create', kind: 'route', confidence: 'read', evidence: { ...ev(routes, 'path: /checkout', 5) } },
    { from: 'orders.create', to: 'checkout.placeOrder', kind: 'call', confidence: 'read', evidence: ev(controller, 'this.checkout.placeOrder(') },
    { from: 'checkout.placeOrder', to: 'inventory.reserve', kind: 'call', confidence: 'read', evidence: ev(checkout, 'this.inventory.reserve(') },
    { from: 'checkout.placeOrder', to: 'payments.capture', kind: 'call', confidence: 'read', evidence: ev(checkout, 'this.payments.capture({', 4) },
    { from: 'payments.capture', to: 'stripe', kind: 'http', confidence: 'read', evidence: ev(stripe, 'paymentIntents.create({', 3) },
    { from: 'checkout.placeOrder', to: 'orders.save', kind: 'call', confidence: 'read', evidence: ev(checkout, 'this.orders.save(') },
    { from: 'orders.save', to: 'bus.orderPlaced', kind: 'event', confidence: 'read', evidence: ev(repository, 'tx.outbox.insert('), note: 'Written to the outbox in the same transaction; the outbox relay publishes it after commit.' },
    {
      from: 'bus.orderPlaced',
      to: 'email.sendReceipt',
      kind: 'event',
      confidence: 'inferred',
      evidence: ev(worker, "bus.subscribe('order.placed'", 3),
      note: "Matched on the topic string 'order.placed'. Nothing calls this directly, so check it before relying on it.",
    },
    { from: 'cron.releaseExpiredHolds', to: 'inventory.release', kind: 'call', confidence: 'read', evidence: ev(cron, 'inventory.release(') },
  ],
  flows: [
    {
      id: 'checkout',
      entry: 'POST /checkout',
      entryNode: 'gateway',
      steps: [
        { edge: 'gateway->orders.create', title: 'Gateway routes the request to OrderController.create', note: 'Config, not code. Note the 3 s timeout: everything below has to finish inside it.' },
        { edge: 'orders.create->checkout.placeOrder', title: 'Controller loads the cart and hands off to placeOrder', note: 'The controller is thin. All checkout rules live in CheckoutService.' },
        { edge: 'checkout.placeOrder->inventory.reserve', title: 'Stock is reserved before any money moves', note: 'Reservations expire after 15 min unless the order is saved as paid (src/inventory/cron.ts).' },
        { edge: 'checkout.placeOrder->payments.capture', title: 'placeOrder charges the customer', note: 'The idempotency key is tied to the cart, not the order.' },
        { edge: 'payments.capture->stripe', title: 'PaymentService confirms a PaymentIntent with Stripe', note: 'Synchronous call to an external API, inside the gateway timeout.' },
        { edge: 'checkout.placeOrder->orders.save', title: 'The paid order is saved', note: 'Saving as paid is what stops the reservation from expiring.' },
        { edge: 'orders.save->bus.orderPlaced', title: 'Order and outbox row are written in one transaction', note: 'An outbox relay publishes the row to the event bus after commit.' },
        { edge: 'bus.orderPlaced->email.sendReceipt', title: 'EmailWorker sends the receipt' },
      ],
    },
    {
      id: 'release-expired-holds',
      entry: 'cron release-expired-holds',
      entryNode: 'cron.releaseExpiredHolds',
      steps: [{ edge: 'cron.releaseExpiredHolds->inventory.release', title: 'Expired reservations for unpaid orders release their stock' }],
    },
  ],
}

writeFileSync(join(root, 'fixtures', 'storefront.model.json'), JSON.stringify(model, null, 2) + '\n')
console.log(`Wrote fixtures/storefront.model.json: ${model.nodes.length} nodes, ${model.edges.length} edges, ${model.flows.length} flows`)
