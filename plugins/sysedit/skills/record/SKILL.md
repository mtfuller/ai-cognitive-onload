---
name: record
description: Write the decision record (docs/adr/NNNN-*.md) for a System Editor change from the engineer's intent, map diff and answers, plus a PR description that maps each changed file to a box on the diagram. Use after a change is verified, when opening a PR for it, or when the engineer runs /sysedit:record.
---

# Write the decision record and the PR description

The record is the engineer's decisions, in their words. You assemble it; you don't add decisions they didn't make.

1. Call `mcp__plugin_sysedit_sysedit__get_change`. Note the intent, operations, questions with answers, plan, drift report and history. If it isn't verified yet, say so and offer `/sysedit:verify` first; write the record anyway only if the engineer asks.
2. Get the diagrams: `render_mermaid` with `proposed: true` (the change, coloured), and with the change's `flow` (before).
3. Find the next ADR number from `docs/adr/` (start at 0001) and write `docs/adr/NNNN-<slug>.md`:

   ```markdown
   # NNNN. <change title>

   Date: <today> · Status: Accepted · Change set: .sysedit/changes/<id>.json

   ## Context
   <the request, verbatim, and the flow as it worked before: 3–6 lines with file:line references>

   ## Decision
   <the engineer's intent, verbatim>
   <the operations they drew, one line each>

   ## Decisions made in review
   <one entry per answered question: the question, the engineer's answer verbatim, and the evidence that prompted it as file:line>

   ## Consequences
   <what the map now shows that it didn't, from the answers: failure behaviour, data consistency, events. Only what the answers and the map say.>

   ## Diagram
   <the proposed-change Mermaid block>
   ```

4. Call `set_adr` with the path.
5. Write the PR description (print it, or save it as `.sysedit/changes/<id>.pr.md`): a one-paragraph summary in the engineer's terms, the Mermaid diagram, then a table mapping **each changed file** (`git diff --name-only <base>`) to the box or arrow on the diagram it implements, and the review answers it honours. A changed file that maps to nothing on the diagram goes in a separate list headed "Not on the map", for the reviewer to question.
6. If verify found drift the engineer accepted, list it in the PR under "Known drift" with their reason.
