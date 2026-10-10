// The outbox relay: polls the outbox table and publishes each row to the
// event bus, then marks it sent. Delivery is at least once.

import type { Bus } from './bus.ts'
import type { Db } from './db.ts'

export async function relayOnce(db: Db, bus: Bus) {
  const rows = await db.outbox.unsent(100)
  for (const row of rows) {
    await bus.publish(row.topic, row.payload)
    await db.outbox.markSent(row.id)
  }
}
