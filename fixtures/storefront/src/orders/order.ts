// The order aggregate. An order starts as a draft built from a cart and is
// saved once it is paid.

export type Line = { sku: string; quantity: number; unitPrice: number }
export type Cart = { id: string; lines: Line[] }
export type User = { id: string; stripeId: string; email: string }
export type OrderStatus = 'draft' | 'paid' | 'cancelled'

export class Order {
  status: OrderStatus = 'draft'
  paymentId?: string

  private constructor(
    readonly id: string,
    readonly userId: string,
    readonly lines: Line[],
  ) {}

  static fromCart(cart: Cart, user: User): Order {
    return new Order(crypto.randomUUID(), user.id, cart.lines)
  }

  get total(): number {
    return this.lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0)
  }

  markPaid(paymentId: string) {
    this.status = 'paid'
    this.paymentId = paymentId
  }

  toRow() {
    return { id: this.id, user_id: this.userId, status: this.status, payment_id: this.paymentId, total: this.total }
  }
}
