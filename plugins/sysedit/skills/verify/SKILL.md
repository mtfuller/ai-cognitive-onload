---
name: verify
description: Re-map the code after a System Editor change is built and check it against the map the engineer approved, reporting drift. Use after implementing an approved change, before opening a PR, or when the engineer runs /sysedit:verify.
---

# Verify the code against the approved map

Drift is reported, never silently accepted.

1. Call `mcp__plugin_sysedit_sysedit__get_change`. It should be `implemented` (or `approved` if the build just finished; call `mark_implemented`). Note the operations and the nodes they touch.
2. Re-map the changed code: dispatch the `sysedit:mapper` subagent for the change's flow, telling it to **reuse the ids already on the map and the ids the engineer drew for new boxes** (from the `addNode` operations), and to map from the code as it is now, with evidence. Ask for the whole flow, not just the new parts.
3. Merge the slice into the current model and call `verify_change` with the merged result as `actual`. (Save it with `save_model` too, so the map stays current.)
4. Report the result:
   - **No drift**: say so, then suggest `/sysedit:record` for the decision record and PR description.
   - **Drift**: list each difference in plain words with the code location: "You drew FraudService.score → OrderHold.create for scores ≥ 0.8; the code never calls OrderHold.create (src/fraud/service.ts:12–30)." Then ask the engineer which way to resolve each: change the code to match the map, or change the map (which reopens review). Don't pick for them.
5. After fixes, run this skill again until it reports no drift.
