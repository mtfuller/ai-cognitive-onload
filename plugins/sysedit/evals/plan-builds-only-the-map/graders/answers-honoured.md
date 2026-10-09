---
type: llm
focus:
  source: file
  path: src/checkout/service.ts
weight: 3
---

The approved change says: score every order before capture; scores >= 0.8 go to OrderHold.create; when scoring times out or fails, hold the order (fail closed, the engineer's answer to q2);
keep stock reserved while an order is held (q3). Judge the final code in src/checkout/service.ts.
PASS if placeOrder calls the fraud score before capture, holds the order instead of capturing at or above the threshold, and holds (does not capture) when scoring fails.
FAIL if capture still runs before the score, if a scoring failure leads to capture, or if the hold branch is missing.
