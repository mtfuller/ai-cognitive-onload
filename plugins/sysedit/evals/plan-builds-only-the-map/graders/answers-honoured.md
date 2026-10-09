---
type: llm
focus:
  source: file
  path: src/checkout/service.ts
weight: 2
---

This file is CheckoutService after a change that adds a fraud check. Judge only the placeOrder method; ignore comments and anything outside it.

PASS if, in placeOrder, a fraud score is obtained before payments.capture is called, and when the score is at or above the threshold the method creates a hold
(any call that puts the order on hold or into review) and returns without calling payments.capture.

FAIL if payments.capture can be called before the score is obtained, if an order at or above the threshold can still reach payments.capture, or if there is no hold branch.
