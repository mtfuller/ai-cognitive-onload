// Stock reservations. A reservation holds stock for an order while it is
// being paid for; src/inventory/cron.ts releases the ones that expire.

import type { Line } from '../orders/order.ts'
import type { Db } from '../lib/db.ts'

export const RESERVATION_TTL_MINUTES = 15

export class OutOfStock extends Error {}

export class InventoryService {
  constructor(private readonly db: Db) {}

  async reserve(lines: Line[], orderId: string) {
    await this.db.tx(async tx => {
      for (const line of lines) {
        const ok = await tx.stock.decrement(line.sku, line.quantity)
        if (!ok) throw new OutOfStock(line.sku)
      }
      await tx.reservations.insert({
        orderId,
        lines,
        expiresAt: new Date(Date.now() + RESERVATION_TTL_MINUTES * 60_000),
      })
    })
  }

  async release(orderId: string) {
    await this.db.tx(async tx => {
      const r = await tx.reservations.get(orderId)
      if (!r) return
      for (const line of r.lines) await tx.stock.increment(line.sku, line.quantity)
      await tx.reservations.delete(orderId)
    })
  }
}
