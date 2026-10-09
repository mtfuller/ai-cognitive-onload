---
name: explain
description: Explain-back check. The engineer explains a flow they changed or traced, without the map or the code open, and Claude scores it against the model and shows what they missed. Use when the engineer asks to test their understanding ("quiz me on checkout", "let me explain it back"), or runs /sysedit:explain. Never start one unasked.
argument-hint: "[flow id or entry point]"
---

# Explain-back: does the understanding hold without the tool?

This is the direct check on the plugin's goal: after using the map, can the engineer explain the flow on their own?

Flow: $ARGUMENTS

1. Call `mcp__plugin_sysedit_sysedit__get_model` with the flow (default: the active or most recent change's flow). Don't show it.
2. Ask the engineer to explain the flow from the entry point to the end, in order, from memory: what calls what, where it can fail, what happens to data and events. Say it's fine to be rough; ask them not to open the editor or the code.
3. When they're done, compare their explanation with the flow's steps:
   - A step counts as **right** when they named both ends of the edge (or an obvious equivalent) in the right order.
   - Note anything important they missed or got wrong: inferred edges, timeouts, transactions, retries.
4. Score = right steps ÷ total steps. Show them, briefly: the steps they got, the ones they missed with `file:line` evidence for each, and one sentence on the most important miss. No lecture.
5. Call `record_explain_back` with the flow id, the change id if there is one, the score, and the missed steps as short strings.
