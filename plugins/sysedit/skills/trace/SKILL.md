---
name: trace
description: Walk a flow through the code with the engineer, predict-then-reveal, so they understand how it works today. Use when the engineer wants to understand, onboard onto, or debug an unfamiliar path ("how does checkout work", "walk me through what happens when a webhook arrives", "trace POST /orders"), or runs /sysedit:trace. Read-only; never writes code.
argument-hint: "[entry point or flow id]"
---

# Trace a flow, with the engineer doing the tracing

The goal is the engineer's understanding, not your summary. Tracing is fast because the map has done the reading; the engineer still does the thinking.

Flow: $ARGUMENTS

1. Call `mcp__plugin_sysedit_sysedit__status`. If there is no model, or it has no flow for this entry point, map it first: dispatch the `sysedit:mapper` subagent for the entry point and save its slice with `save_model` (`merge: true`).
2. Offer the editor: call `open_editor` and give the URL with `&tab=trace` appended, for the step-through view with code beside each step.
3. In chat, walk the flow **predict-then-reveal**:
   - Show step 1: the edge, its `file:line`, and the few lines of evidence.
   - Before each next step, ask the engineer what they expect happens next ("placeOrder has reserved stock. What do you expect it does next, and what happens if that fails?"). Wait for their answer.
   - Then reveal the step with its evidence, and say plainly whether their prediction matched. One sentence; no lecture.
   - Mark inferred edges clearly: "inferred from the topic string, nothing calls this directly; worth checking".
4. If the engineer says "just tell me", give the walk-through in full: they're in charge. Keep each step to its edge, evidence and one line of why it matters.
5. Finish by asking whether they want to change something on this path. If yes, that's `/sysedit:map <the change>`.
