---
type: llm
weight: 3
---

The engineer's explanation of checkout left out: stock is reserved before payment (InventoryService.reserve), the order and an outbox row are written in one transaction
and published as order.placed, and the email worker sends the receipt (an inferred link).
PASS if the reply scores the explanation as partial and names at least two of those missing steps with a file reference for each, briefly.
FAIL if it scores the explanation as complete, or doesn't say what was missed.
