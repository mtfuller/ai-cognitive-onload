---
type: regex
pattern: 'fraud'
flags: i
match: not_contains
target:
  source: file
  path: src/checkout/service.ts
weight: 3
---
