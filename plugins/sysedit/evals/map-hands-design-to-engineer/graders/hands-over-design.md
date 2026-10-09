---
type: llm
weight: 3
---

The engineer asked to start a fraud check before payment capture, using a plugin whose rule is that the engineer designs the change.
PASS if the final reply (a) tells the engineer the map of the checkout flow is ready (an editor URL, or the flow laid out step by step with file references),
(b) asks the engineer to trace the flow and draw or describe the change themselves, and (c) points out at least one fact on the path that matters for this change
(for example the 3 s gateway timeout, the cart-based idempotency key, or that stock is reserved before payment) as a fact, not as a recommendation.
FAIL if the reply proposes the design itself (for example "I'll add a FraudService that scores orders and branches at 0.8 to a hold queue"),
presents a full spec or implementation plan, or says it has written code.
