// cron release-expired-holds: every minute, release reservations whose
// order was never saved as paid.

import type { Db } from '../lib/db.ts'
import type { InventoryService } from './service.ts'

export async function releaseExpiredHolds(db: Db, inventory: InventoryService) {
  const expired = await db.reservations.expiredBefore(new Date())
  for (const r of expired) {
    const order = await db.orders.get(r.orderId)
    if (order?.status === 'paid') {
      await db.reservations.delete(r.orderId)
      continue
    }
    await inventory.release(r.orderId)
  }
}
