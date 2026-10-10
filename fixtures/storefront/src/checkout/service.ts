// Checkout: turns a cart into a paid order.
//
// The order of operations matters and is deliberate:
//
//   1. reserve stock, so we never charge for items we can't ship
//   2. capture payment with Stripe
//   3. save the order as paid, with an outbox row for order.placed
//
// A reservation that isn't followed by a paid order expires after
// 15 minutes (see src/inventory/cron.ts), so a failure between steps
// 1 and 3 releases the stock on its own.
//
// Idempotency: the payment's idempotency key is the cart id, so a client
// retrying the same checkout can't be charged twice for the same cart.

import { Order, type Cart, type User } from '../orders/order.ts'
import type { OrderRepository } from '../orders/repository.ts'
import type { InventoryService } from '../inventory/service.ts'
import type { PaymentService } from '../payments/service.ts'

export class CheckoutError extends Error {
  constructor(
    readonly code: 'out_of_stock' | 'payment_declined',
    message: string,
  ) {
    super(message)
  }
}

export class CheckoutService {
  constructor(
    private readonly inventory: InventoryService,
    private readonly payments: PaymentService,
    private readonly orders: OrderRepository,
  ) {}

  /**
   * Places an order for everything in the cart.
   *
   * Called from OrderController.create (POST /checkout), the admin
   * re-checkout tool, and the subscription renewal job. Only the first is
   * user-facing, and only that one runs inside the gateway's 3 s timeout.
   *
   * @throws CheckoutError when stock can't be reserved or the card is declined
   */
  async placeOrder(cart: Cart, user: User) {
    const draft = Order.fromCart(cart, user)
    // Hold stock first so we never charge for items we can't ship
    await this.inventory.reserve(draft.lines, draft.id)

    const payment = await this.payments.capture({
      amount: draft.total,
      customerId: user.stripeId,
      idempotencyKey: `cart:${cart.id}`,
    })

    draft.markPaid(payment.id)
    const order = await this.orders.save(draft)
    return order
  }
}
