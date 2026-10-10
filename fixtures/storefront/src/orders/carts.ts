import type { Cart } from './order.ts'

export interface CartStore {
  get(cartId: string): Promise<Cart>
}
