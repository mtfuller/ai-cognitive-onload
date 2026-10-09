# Testing

Four suites, from cheapest to most realistic. Everything except the skill evals runs without a model, a sign-in or a network, and in CI on every push.

```bash
npm ci
npm run ci          # build check, typecheck, vitest, Playwright, plugin validate, mod tests
npm run evals:smoke # model-graded smoke evals (needs Claude Code credentials)
```

## 1. Unit tests (`tests/unit`, vitest)

The pure core, where every rule the plugin enforces is decided:

| File | Covers |
|-|-|
| `model.test.ts` | The golden storefront model is valid; validation refuses boxes without sources, read edges without evidence, unknown nodes, out-of-range lines, paths that escape the repo; folding to modules and services; flow slices; merging mapper slices |
| `changeset.test.ts` | Applying every operation (including conflicts), the mockup's fraud-check drawing, files and nodes touched, the lifecycle and every refusal (submit without intent, approval with open blocking questions or unaccepted suggestions, plans with off-map tasks or missing operations), answers that redraw the map |
| `gate-drift.test.ts` | The gate in every status and mode, path handling, stages; drift (missing, unexpected, still present, missing nodes, out-of-scope noise ignored); Mermaid; layout; metrics; risk tiers |
| `provenance.test.ts` | Quotes must be the engineer's words; delegations ("answer them yourself") are refused; approvals must approve |
| `evals.test.ts` | Lints the eval suite without a model call (see [evals.md](evals.md#the-lint)) |

## 2. Integration tests (`tests/integration`, vitest)

Each test makes a throwaway git copy of `fixtures/storefront` and drives the real bundled `plugins/sysedit/dist/sysedit.mjs`, the same file Claude Code starts.

- **`mcp-workflow.test.ts`** speaks MCP over stdio (`tests/helpers/mcp.ts` is a small client): protocol basics, malformed input, tool errors vs protocol errors, model validation against the files on disk, and one full cycle. It saves the map, starts a change, transcribes the engineer's ops, submits, asks questions (and drops the one without evidence), checks the gate's deny reason through the CLI hook, records answers, has approval refused over Claude's unaccepted suggestion, accepts it through the editor's HTTP API, approves, has a plan refused for building off the map, saves a covering plan, then **builds the code in the repo** (`implementFraudCheck`), first leaving out the hold branch so verify reports the drift and `sysedit ci` fails, then completely so verify passes and CI goes green. Skips, explain-back and Mermaid have their own tests.
- **`http-api.test.ts`** covers the editor server: token required, non-local `Host` refused (DNS rebinding), loopback-only bind, source reads confined to the repository (`..`, absolute paths, symlinks out), the engineer's whole path through the API, Claude's suggestions keeping their author when the engineer saves, server-sent events on change, and 4xx on bad input.
- **`cli.test.ts`** covers the CLI as CI and a `PreToolUse` settings hook run it: allow/deny output format, gate modes from the plugin option, strict mode, failing open on an unreadable `.sysedit/`, `validate`, `status`, `mermaid`, `skip`, `metrics` and `ci` exit codes.

## 3. Editor end-to-end tests (`e2e`, Playwright)

Each test gets its own repository and a `sysedit serve` process (`e2e/fixtures.ts`), drives the editor in Chromium, and checks both the page and the files on disk. They also fail on any uncaught page error.

- **Trace**: step through `POST /checkout` with the code beside each step, keyboard stepping, the inferred step flagged, folding to modules and services, switching entry points.
- **Edit**: add and name a box, connect, remove an arrow, write the intent, submit; the saved operations are the engineer's; undo; accepting a Claude suggestion.
- **Grill**: questions appear live while the page is open, blocking ones hold approval with the reason, picking an option shows its map effect, a free-text answer, rating, approval, and "Trace this on the map" opening the step behind a question.

`playwright.config.ts` uses a preinstalled Chromium when `PLAYWRIGHT_CHROMIUM_PATH` or `/opt/pw-browsers/chromium` exists; in CI, `npx playwright install --with-deps chromium`.

## 4. Mod tests (`plugins/sysedit/hooks/tests`, `claude plugin test`)

Run inside Claude Code's own hooks environment with the `claude-code/testing` kit, stubbing what Claude Code would answer (`.sysedit/` files, the transcript, the dialog):

- the gate holds writes while drawing and in review (naming the open questions), lets `.sysedit/` through, opens on approval, stays out of the way with no change, and in strict mode holds files off the map;
- answers, approvals and skips must quote what the engineer typed; a delegation is refused; an operation quoting words the engineer never said becomes a suggestion; with a person at the prompt, approval and skip also need their yes;
- every prompt during a change carries a status line, and a delegation attempt adds the fast-path instruction;
- `/sysedit-status` answers in text where no pane can be placed; the band shows blocking questions on the terminal and desktop surfaces, offers the next step as a button, and stays out of the way when idle.

## Fixtures

`fixtures/storefront/` is the repository every suite runs on, and `fixtures/storefront.model.json` its golden map, generated by `scripts/gen-fixture-model.mjs` from marker text so line numbers can't drift. `tests/helpers/fixture.ts` has the shared pieces: `makeRepo()`, `seed()`, the mockup's fraud-check drawing (`FRAUD_OPS`) and questions, and `implementFraudCheck()`, which builds the change in a repository and returns the model a mapper would produce from it.

## Typechecking and the bundle

`npm run typecheck` checks the Node sources, the core, the tests and the editor. The mod is typechecked against the engine's declarations (written by Claude Code when it loads the mod) and validated with `claude plugin validate --strict`, which also reports every event the mod hooks and every API call it makes. `npm run build:check` rebuilds `dist/` into a temporary directory and fails if the committed bundle is stale.
