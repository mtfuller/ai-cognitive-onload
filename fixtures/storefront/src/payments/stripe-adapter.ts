// Stripe adapter: confirms a PaymentIntent synchronously.
//
// There is no timeout wrapper here. The Stripe client's own default is 80 s,
// far longer than the gateway's 3 s budget for POST /checkout.

import Stripe from 'stripe'

import type { CaptureRequest } from './service.ts'

export class StripeAdapter {
  constructor(private readonly stripe: Stripe) {}

  // Creating with confirm: true charges the card in one call.
  // The idempotency key makes a retried request return the first result.
  // Returns the intent's id and status; the caller decides what a non-success means.
  async capture(req: CaptureRequest) {
    const intent = await this.stripe.paymentIntents.create({
      amount: req.amount, currency: 'usd',
      customer: req.customerId, confirm: true,
    }, { idempotencyKey: req.idempotencyKey })
    return { id: intent.id, status: intent.status }
  }
}
