// Payments: the one place the app talks to the payment provider.

import type { StripeAdapter } from './stripe-adapter.ts'

export type CaptureRequest = {
  amount: number
  customerId: string
  /** Stripe dedupes requests with the same key for 24 hours. */
  idempotencyKey: string
}

export class PaymentDeclined extends Error {}

export class PaymentService {
  constructor(private readonly stripe: StripeAdapter) {}

  async capture(req: CaptureRequest) {
    const result = await this.stripe.capture(req)
    if (result.status !== 'succeeded') throw new PaymentDeclined(result.id)
    return result
  }
}
