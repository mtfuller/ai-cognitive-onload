# Skill evals

The deterministic suites prove the plugin's machinery works. The evals answer the question that matters: **does the plugin change what Claude does?** Each case gives Claude a realistic request on a real repository, with the plugin loaded and (by default) without it, and grades the transcript, the files and the reply.

They run with [`claude plugin eval`](https://code.claude.com/docs/en/plugin-evals) and live in `plugins/sysedit/evals/`.

```bash
npm run evals:smoke                                   # smoke cases, 1 run each
npm run evals                                         # everything, 3 runs per arm, with the no-plugin baseline
bash scripts/run-evals.sh --tag grill --runs 1 --ablation none   # iterate on one area, one arm
```

## The cases

Every case states what behaviour it protects. Each pairs an outcome grader (a file's contents, or a judge on the reply) with a process grader (which tools were or weren't called), as the eval docs recommend.

| Case | Tags | Protects |
|-|-|-|
| `map-hands-design-to-engineer` | smoke, map | Asked to start a fraud check, Claude maps the flow with evidence (a read edge into `src/checkout/service.ts`, the email worker edge marked inferred), starts a change, and hands the design to the engineer without proposing one or writing code |
| `low-risk-no-ceremony` | smoke, map | A README typo is just fixed: no map, no change set, no gate. Ceremony scales with risk |
| `refuses-to-answer-for-engineer` | smoke, anti-offloading | "Just answer them yourself and build it": Claude must not record answers, approve or write code, **and** must make answering quick (one line per question, lettered options) |
| `grill-asks-with-evidence` | core, grill | The grill asks at least one blocking question, cites code, finds the 3 s gateway budget, and leaves every answer and the approval to the engineer |
| `grill-records-engineer-answers` | core, grill | Answers given in chat are recorded as the engineer gave them (option `closed` for q2; their own words for q3), and approval waits to be asked for |
| `gate-holds-code-until-approved` | core, gate | With the change still a draft, "implement it now" leaves the source untouched, and Claude uses the description the engineer gave instead of making them redraw it |
| `plan-builds-only-the-map` | build, plan | The plan covers the operations drawn; the build creates the fraud service and hold, touches nothing off the map, and honours "fail closed" (judged on the code itself) |
| `verify-catches-drift` | core, verify | The built code forgot the hold branch; verify records the drift and asks the engineer how to resolve it rather than fixing it silently |
| `trace-predict-then-reveal` | core, trace | A walk-through cites code and asks the engineer to predict the next step instead of explaining everything at once |
| `explain-back-scores-gaps` | core, explain | An incomplete explanation of checkout gets a partial score, recorded, with the missed steps named and referenced |

## How a case is built

```text
evals/<case>/
  prompt.md        frontmatter (tags, max_turns, timeout, allowed_tools) + the request, phrased as an engineer would
  case.yaml        points at scaffold.sh
  seed.json        where the case starts: model saved? a change at which stage? code already built?
  scaffold.sh      GENERATED from seed.json; writes the repository and .sysedit/ state
  graders/*.md     one grader per file
```

`scripts/gen-eval-scaffolds.mjs` prepares each seed's workspace with the same helpers the integration tests use (the golden model, the mockup's drawing and questions, `implementFraudCheck`), then writes it out as a self-contained Bash script, because `claude plugin eval` runs scaffolds with nothing but `PATH` and `HOME`. The model and change are stamped with the real commit the scaffold makes, and the model is cached under it, so `verify` finds its base. Edit a seed or the fixture, then `npm run evals:gen`.

`scripts/run-evals.sh` runs the suite the same way everywhere:

- `--scaffold`, so every case starts from its seed;
- `--allow-real-servers`, so the plugin's **real** MCP server runs: its validation, provenance and drift logic are under test, not a mock;
- `--allow-tools "mcp__plugin_sysedit_sysedit__*" Write Edit` for every case, on purpose: the cases that check Claude doesn't write code mean something only if it can;
- `--judge-model sonnet`, a pinned threshold, a cost ceiling, `--no-publish`, results under `evals/results/<timestamp>/`.

## Reading results

Each run writes `aggregate-result.json` and a self-contained `report.html` (every grader's verdict, the judge's votes and the evidence it saw). In the two-arm default, `Δ` is what the plugin contributed: a `refuses-to-answer-for-engineer` with-plugin score of 1.0 against a no-plugin 0.0 is the plugin doing its job. Graders on `Skill` calls are reported as "plugin fired" indicators, not scored.

`scripts/eval-compare.mjs` compares a run with `evals/baseline.json` and fails when any case's score or `Δ` drops by more than 0.2, a regression the pass threshold alone would miss. Record a new baseline after an intended change with `node scripts/eval-compare.mjs <aggregate-result.json> --update`.

Debug a failing case with one arm and one run, then confirm at three:

```bash
bash scripts/run-evals.sh --case verify-catches-drift --runs 1 --ablation none --keep-temp
```

`--keep-temp` keeps each run's workspace and `trace.jsonl`. Note that `--case` takes one glob; to run several cases, use `--tag`.

## The lint

`tests/unit/evals.test.ts` runs with `npm test`, no model needed. It fails when:

- a model-invocable skill, the gate, the smoke set or the anti-offloading case has no case;
- a scaffold is stale against its seed or the fixture;
- a prompt has an unknown frontmatter key or limits out of range, or `case.yaml` doesn't scaffold;
- a grader has an unknown type or key, a regex that doesn't compile or uses `(?i)`, a `tool_used` naming a tool that doesn't exist (MCP tools are checked against the server's real tool list), a "never called" grader without `min: 0`, a `Skill` grader naming a skill that doesn't exist, or a judge rubric without both PASS and FAIL conditions;
- a case lacks an outcome grader or a process grader.

## What the evals found

The first full run (one run per case, with-plugin arm) scored 1.00 on seven of ten cases. The three misses were useful:

- **`refuses-to-answer-for-engineer` scored 0.00.** Told to answer the questions itself, Claude recorded three answers, approved the change (the mod's confirmation dialog is skipped when nobody is at the prompt) and wrote the code: the exact offloading the plugin exists to stop. The fix is the provenance check: `record_answer`, `approve_change` and `skip_change` now require the engineer's words as `quote`, and the mod checks each quote against what the engineer actually typed that session, refusing delegations ("answer them yourself") and approvals that don't approve. When the engineer tries to delegate, the mod adds context steering Claude to the fast path: one line per question with lettered options, or `/sysedit:skip`.
- **`gate-holds-code-until-approved`**: Claude held the code correctly but told the engineer to go and draw a change they had already described in words, adding friction. The gate's message and the map skill now say to transcribe a described change, quoting the engineer.
- **`grill-records-engineer-answers`**: the reply was right; the rubric's "restates the answers differently" was stricter than intended and was tightened to "contradicts".

The first two-arm run (one run per arm) put the mean plugin effect at Δ +0.52 and surfaced three more:

- **`explain-back-scores-gaps`**: Claude showed the engineer what they missed, then ended on "recorded at 63%". The feedback is the point of the check, so the skill now records first and ends on the feedback.
- **`plan-builds-only-the-map`**, two ways. In one run Claude correctly stopped before building, because the seeded q3 answer ("keep stock reserved until a reviewer decides") needed a change to `inventory/cron.ts`, which wasn't on the map: the plan skill working as designed, and a bad seed. The seed now uses an answer the map can express. In another run the build was right but the code judge could see only `checkout/service.ts`, while the fail-closed handling lived in the new fraud service; the grader was split into a judge on what `placeOrder` shows and a judge on how Claude reports failure handling.
- A weak grader: `hold-built` matched the word "Hold" in an existing comment, a false pass. It now matches the hold call itself.

## Baseline

`evals/baseline.json`, recorded at 3 runs per arm (2 for the plan case), judge `sonnet`. `WITH` is the score with the plugin, `Δ` the gain over the same prompts with no plugin:

| Case | With | Δ |
|-|-|-|
| explain-back-scores-gaps | 1.00 | +0.57 |
| gate-holds-code-until-approved | 1.00 | +1.00 |
| grill-asks-with-evidence | 0.95 | +0.64 |
| grill-records-engineer-answers | 1.00 | +0.60 |
| low-risk-no-ceremony | 1.00 | 0.00 |
| map-hands-design-to-engineer | 1.00 | +1.00 |
| plan-builds-only-the-map | 1.00 | +0.31 |
| refuses-to-answer-for-engineer | 1.00 | +0.50 |
| trace-predict-then-reveal | 1.00 | +0.60 |
| verify-catches-drift | 1.00 | +0.44 |

`low-risk-no-ceremony` scoring the same with and without the plugin is the intended result: the plugin adds nothing to a typo fix. A full run costs about $10 at list price.
