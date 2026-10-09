---
name: skip
description: Skip the System Editor process for a change too small to need it, with a logged reason, so writes are let through. Only the engineer runs this.
argument-hint: "<reason>"
disable-model-invocation: true
---

# Skip the process for this change

The engineer has decided this change doesn't need the map, the review or the gate. Respect that; the skip is logged and the skip rate is a tracked metric, so a high rate is treated as a design problem with the process, not with the engineer.

Reason given: $ARGUMENTS

1. If no reason was given, ask for one in a few words ("typo fix in the receipt email", "dependency bump, no code paths change") and wait.
2. Call `mcp__plugin_sysedit_sysedit__skip_change` with the reason, verbatim. The engineer may be asked to confirm.
3. Confirm in one line that the skip is logged and writes are no longer held, then carry on with what the engineer asked for.
4. If the work turns out to touch a core flow (money, auth, data, events, timeouts), say so once, plainly, and let the engineer decide whether to start `/sysedit:map` after all.
