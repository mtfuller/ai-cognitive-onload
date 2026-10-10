# Measuring it

The plan's claim has two halves: the process keeps engineers' understanding intact, and it doesn't slow them down. `sysedit metrics` (or the `get_metrics` tool) computes both from what the plugin already writes to `.sysedit/`, so a team can judge it on more than how it feels.

```text
$ node plugins/sysedit/dist/sysedit.mjs metrics
Changes: 12 (verified 9, skipped 2, in-review 1)
Time to submit a drawn change (median): 6.5 min
Time defending it in review (median): 4.0 min
Grill hit rate (blocking answers that changed the map): 55% of 14 blocking asked
Questions rated useful: 71%
Drift caught before merge: 22%
Skips: 3 (skip rate 20%)
Explain-back mean score: 81% over 5 check(s)
```

| Metric | From | What it tells you |
|-|-|-|
| Time to submit | change `createdAt` → `submitted` | How long drawing takes compared with writing a prompt and reading a spec. |
| Time in review | `submitted` → `approved` | The cost of defending the change. |
| Grill hit rate | answered blocking questions whose answer changed the map | Whether blocking questions catch something real. Low means the rubric is noisy. |
| Useful rate | the engineer's useful/noise ratings | Which rubric items to cut. |
| Drift caught | changes whose verify found drift at least once | Problems found before merge rather than after. |
| Skip rate | skips over changes started plus skips | Too much ceremony shows up here first. A high skip rate is a design problem with the process, not with the engineers. |
| Explain-back | `/sysedit:explain` scores | The direct check on the goal: can engineers explain what they changed without the tool? |

Not computed here, but worth tracking alongside: **map accuracy** (sample edges and have engineers mark them right, wrong or missing; the evals' `model-has-evidence` grader and the validator are the automated floor) and **post-merge defects** on changes that went through the process versus ones that skipped it.
