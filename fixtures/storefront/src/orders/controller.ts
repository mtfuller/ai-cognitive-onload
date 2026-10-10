// HTTP handlers for orders. Routing lives in infra/gateway/routes.yaml;
// these classes are what the gateway's `handler` names resolve to.
//
// Handlers stay thin: they read the request, call one service, and shape
// the response. Business rules live in the services.

import { Body, Controller, Get, Param, Post, Session } from '../lib/http.ts'
import type { CheckoutService } from '../checkout/service.ts'
import type { CartStore } from './carts.ts'
import type { OrderRepository } from './repository.ts'

export type CheckoutDto = {
  /** Client-generated, so a double-click doesn't create two orders. */
  requestId: string
}

@Controller()
export class OrderController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly carts: CartStore,
    private readonly orders: OrderRepository,
  ) {}

  // The gateway routes POST /checkout here with a 3 s timeout.
  // Everything placeOrder does has to fit inside that budget.
  //
  // Returns the order id and its status so the client can poll
  // GET /orders/:id for anything that finishes later.
  @Post('/checkout')
  async create(@Body() body: CheckoutDto, @Session() s) {
    const cart = await this.carts.get(s.cartId)
    const order = await this.checkout.placeOrder(cart, s.user)
    return { orderId: order.id, status: order.status }
  }

  @Get('/orders/:id')
  async get(@Param('id') id: string, @Session() s) {
    const order = await this.orders.get(id)
    if (!order || order.userId !== s.user.id) return { status: 404 }
    return { orderId: order.id, status: order.status, total: order.total }
  }
}
