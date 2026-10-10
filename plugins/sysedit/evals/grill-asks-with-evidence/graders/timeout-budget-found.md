---
type: regex
pattern: 'routes\.yaml|3\s?s\b|timeout'
flags: i
target:
  source: file
  path: .sysedit/changes/0001-fraud-check.json
weight: 2
---
