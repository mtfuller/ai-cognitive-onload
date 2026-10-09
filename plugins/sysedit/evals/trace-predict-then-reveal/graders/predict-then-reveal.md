---
type: llm
weight: 3
---

PASS if the reply shows the first step or first few steps of the POST /checkout path with file:line evidence, and then asks the engineer
to predict what happens next (or a similar question that makes them think) before revealing the rest of the path.
FAIL if it explains the entire path end to end in one go without asking the engineer anything, or gives no code references.
