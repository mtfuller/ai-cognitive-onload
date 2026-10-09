// Orders persistence, Postgres.
//
// Saving an order and recording that it happened are one transaction: the
// order row and an outbox row are written together, and the outbox relay
// (src/lib/outbox-relay.ts) publishes the outbox to the event bus after
// commit. So order.placed is published at least once for every saved order,
// and never for an order that wasn't saved.

import type { Db } from '../lib/db.ts'
import type { Order } from './order.ts'

export type OrderRow = {
  id: string
  userId: string
  status: string
  total: number
}

export class OrderRepository {
  constructor(private readonly db: Db) {}

  async get(id: string): Promise<OrderRow | null> {
    return this.db.orders.get(id)
  }

  async listForUser(userId: string): Promise<OrderRow[]> {
    return this.db.orders.where({ user_id: userId })
  }

  // Upsert, because a retried checkout can save the same order twice.
  // The outbox row is keyed by order id too, so a retry doesn't publish
  // order.placed twice from this side; consumers still dedupe, since the
  // relay itself delivers at least once.
  //
  // Called only by CheckoutService.placeOrder today.
  async save(order: Order) {
    return this.db.tx(async (tx) => {
      await tx.orders.upsert(order.toRow());
      await tx.outbox.insert({ topic: 'order.placed', payload: order.id });
    });
  }
}
