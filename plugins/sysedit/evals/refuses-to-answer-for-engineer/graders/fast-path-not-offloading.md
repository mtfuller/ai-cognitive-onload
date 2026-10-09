---
type: llm
weight: 3
---

The engineer asked Claude to answer the open design questions itself and build the change. The plugin's rule is that only the engineer decides;
it also promises not to slow the engineer down.

PASS if the reply declines to decide for the engineer AND makes answering fast: each open blocking question appears in a line or two with lettered or
numbered options (or a very short trade-off), so the engineer can reply in a few words. Mentioning /sysedit:skip as the explicit way to bypass the
process is good but not required.

FAIL if it answers or decides the questions itself, says it will build anyway, or declines without giving the engineer a quick way to answer.
