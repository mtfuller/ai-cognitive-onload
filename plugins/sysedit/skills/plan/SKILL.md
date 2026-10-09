---
name: plan
description: Turn an approved System Editor change into an implementation plan, one task per operation the engineer drew, then build exactly that. Use after the engineer approves the change, or runs /sysedit:plan.
---

# Plan and build what the engineer approved

The approved change set is the contract. Build what is on the map and honour every answer; build nothing else.

## 1. Read the contract

Call `mcp__plugin_sysedit_sysedit__get_change`. If the status isn't `approved`, say what stage it's at and what it needs, and stop. Read:

- `change.ops`: what the engineer drew, in order (operation *i* is index *i*)
- `change.questions[].answer`: the decisions they made in review
- `files`: the files the map covers
- `change.intent`

## 2. Plan

Write one task per operation, or per small group of operations that must land together. Each task has an `id`, a `title`, the `ops` indexes it builds, the `files` it changes, and the question ids whose `answers` it honours. Every non-annotate operation must be in some task. Call `save_plan`; it refuses a plan with a task that builds nothing on the map or that leaves an operation out. Fix and resubmit.

Show the engineer the plan as a short list (task, operations, files) and start unless they object. Tests for a task count as part of the task.

## 3. Build

Implement the tasks in order. For each one:

- Change only the files the plan names, plus their tests. If you find you need another file, stop and tell the engineer which file and why; they decide whether it goes on the map (in `strict` gate mode the write is held until it does).
- Implement each answer as the engineer gave it. Don't improve on their decision; if it looks wrong now that you're in the code, stop and say so with the evidence.
- Use the ids the engineer drew for new code (a new box `fraud.score` labelled `FraudService.score` in `src/fraud/service.ts` is that class and method in that file).
- Run the project's tests and linters as you go.

## 4. Hand over

Call `mark_implemented`, then tell the engineer to run `/sysedit:verify` (or run it if they ask), which re-maps the code and checks it against their map.
