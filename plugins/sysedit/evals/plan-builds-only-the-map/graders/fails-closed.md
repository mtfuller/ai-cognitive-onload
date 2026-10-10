---
type: llm
weight: 2
---

The engineer's answer to q2 was "fail closed": when fraud scoring is slow, fails or times out, the order is held for review rather than charged.

PASS if the final reply describes how a scoring timeout or failure is handled and that behaviour does not charge the customer (the order is held,
or checkout fails without capturing payment), and it says the build was marked implemented or is ready to verify.

FAIL if the reply says a scoring failure leads to capturing payment, doesn't mention scoring failures at all, or says the work wasn't built.
