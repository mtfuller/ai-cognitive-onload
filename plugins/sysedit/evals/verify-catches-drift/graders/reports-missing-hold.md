---
type: llm
weight: 3
---

The engineer drew a branch from FraudService.score to OrderHold.create for risky orders; the code that was built never creates a hold.
PASS if the final reply reports that the hold branch (OrderHold.create) drawn on the map is missing from the code, with a file reference,
and asks the engineer whether to fix the code or change the map. FAIL if it says the code matches the map, or fixes the code without asking.
