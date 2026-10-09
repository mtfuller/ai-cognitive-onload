---
name: map
description: Start System Editor for a change to how the system works. Maps the parts of the code the request touches (with file and line evidence for every edge), opens the editor, and hands the design to the engineer. Use when the engineer asks for a feature, an integration, or a change to a flow (for example "add a fraud check before we capture payment", "send a webhook when an order ships", "move pricing into its own service"), or runs /sysedit:map. Not for typo fixes, renames, docs or test-only changes; suggest /sysedit:skip for those.
argument-hint: "[the change you want]"
---

# Map the system, then hand the design to the engineer

The engineer designs the change. You do the tedious part: reading the code to work out how it fits together, and drawing that as a map they can check. You do **not** propose the design, draft a spec, or write code in this skill.

Request: $ARGUMENTS

The sysedit MCP tools are named `mcp__plugin_sysedit_sysedit__<tool>`; below they are called by their short names.

## 1. Check where things stand

Call `status`. If a change is already in progress, tell the engineer which one and its stage, and stop: one change at a time. If there is no request, ask the engineer what they want to change, in their words.

## 2. Size the ceremony to the risk

Decide the risk tier from the request (state it in one line, with the reason):

- **low**: typo, copy, docs, rename, logging, test-only, a dependency bump. Say the process isn't worth it here and tell the engineer they can run `/sysedit:skip <reason>`. Do not skip on their behalf, and stop.
- **medium / high**: continue. Money, auth, data deletion or migration, events and queues, retries, timeouts, and anything on a core user path are high.

## 3. Find the entry points the request touches

Search for the routes, handlers, jobs, consumers and config that lead to the code the request is about (`Grep` for paths, handler names, topic names, cron names). Pick the smallest set of entry points that covers the request, usually one to three. Name them the way an engineer would: `POST /checkout`, `cron release-expired-holds`, `consumer order.placed`.

## 4. Reuse or refresh the map

- If `status` shows a model whose commit is the current HEAD and it already has these flows, reuse it.
- If the model is stale, map only what changed: `git diff --name-only <model commit>` and re-map the entry points whose files changed.
- Otherwise map each entry point.

Map entry points in parallel: dispatch one `sysedit:mapper` subagent per entry point in a single message, giving each the entry point, the request, and the ids of nodes already on the map so they reuse them. With more than three entry points and workflows available, run the `/sysedit:map-entry-points` workflow instead. Each mapper returns a model slice as JSON.

## 5. Save the model, with evidence

Call `save_model` with each slice and `merge: true` (the first slice may omit merge). The server refuses a model where a box has no source or an edge read from code has no evidence. Fix every error it reports by reading the code, not by deleting the edge, and call again. Keep inferred edges inferred: an event bus subscription, config routing or dynamic dispatch is `confidence: "inferred"` with a `note` that says how you inferred it.

## 6. Start the change and open the editor

1. Call `start_change` with a short title, the request verbatim, the main flow's id, and the risk tier.
2. Call `open_editor` and give the engineer the URL.
3. Tell the engineer, briefly:
   - **Trace** the flow on the map first: step through it with the code beside each step. Point out the one or two facts on the path that matter most for this request (a timeout budget, an idempotency key, a transaction boundary), as facts, not as design advice.
   - **Draw** the change in the Edit tab: add, remove or reroute boxes and arrows, and write what they're trying to do. Then press *Submit for Claude's review*.
   - Nothing is built until they have drawn it and answered your questions about it.

## If the engineer can't open the browser

Show the flow with `render_mermaid` (flow id) and walk it as a numbered list with `file:line` for each step. Ask the engineer to describe the change as concrete edits to the map ("add FraudService.score between placeOrder and capture; branch at 0.8 to a new OrderHold"). Transcribe exactly what they said with `propose_ops`, putting their words in each operation's `quote`, and ask them for the intent in one or two sentences (`set_intent`). Then `submit_change` when they say it's ready.

## Never

- Never draw the change yourself. If the engineer asks you to, offer two or three options as questions ("Where should the score sit: before reserve, or between reserve and capture?") and let them choose; record only what they chose, with their words as the quote. Operations without the engineer's words are recorded as suggestions they must accept.
- Never write or edit code outside `.sysedit/` in this skill. The gate holds those writes anyway.
