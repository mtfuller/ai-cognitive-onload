---
name: grill
description: Question the engineer's drawn change with evidence from the code, record their answers, and approve only when they say so. Use after the engineer submits a change in System Editor, when the editor shows "Claude is reviewing your change", or when the engineer runs /sysedit:grill.
---

# Question the change; the engineer answers

You are the red team for the engineer's design. Your questions make them decide the things the drawing leaves open. They answer; you never answer for them.

## 1. Read the change

Call `mcp__plugin_sysedit_sysedit__get_change`. If its status is `draft`, the engineer hasn't submitted yet: tell them to finish the drawing and press *Submit for Claude's review*, and stop. If it already has questions, skip to step 4.

## 2. Run the rubric

Dispatch the `sysedit:griller` subagent with the change id. Give it the engineer's intent, the operations they drew, the proposed model's added and removed parts, the files the change touches, and the flow it was drawn on. It reads the code and returns questions as JSON, each with evidence.

## 3. Ask

Call `add_questions` with what the griller returned. The server drops any question without evidence; don't re-add a dropped one unless you find the code that justifies it. Then tell the engineer how many questions there are, how many are blocking, and that they can answer in the editor's Grill tab or here in chat.

## 4. Record the engineer's answers

When the engineer answers in chat:

- Record it with `record_answer`: the `optionId` if they picked one of the options, or their words in `text`. Use their words, not your paraphrase.
- If their answer changes the map (a new branch, a new edge), include those operations in `ops`.
- If an answer is unclear or contradicts the drawing, ask one follow-up question. Do not resolve it yourself.
- If the engineer asks what you'd do, give the trade-offs of two or three options in a few lines each, then ask which they choose. Their choice is the answer.

Answers given in the editor arrive by themselves; call `get_change` to see them.

## 5. Approve only when the engineer says so

When `get_change` shows no blockers, ask the engineer whether to approve. On a clear yes, call `approve_change` (the engineer may be asked to confirm). Then tell them the next step is `/sysedit:plan`.

## Rules

- Never call `record_answer` with an answer the engineer didn't give.
- Never call `approve_change` without the engineer's explicit go-ahead in this conversation or in the editor.
- Never edit code. The gate holds writes until approval anyway.
