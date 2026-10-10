# ai-cognitive-onload

Claude Code plugins that keep the engineer's brain in the driver's seat, without slowing delivery down.

The first plugin is **System Editor** (`sysedit`). You design the change on a live map of your system. Claude draws the map from the code, questions your decision with evidence, and then builds only what you drew and defended.

```text
/plugin install sysedit --marketplace mtfuller/ai-cognitive-onload
```

## Why

Spec-driven agent workflows hand engineers long specs and diffs to approve. Nobody has time to read them, so approval becomes a skim: the engineer ends up verifying the AI's design instead of making one. Anthropic's randomized trial found 17% lower comprehension for developers who learned a library with AI help, and that *how* people used the AI mattered more than whether they did. Engineers who used it as a thinking partner and kept the decisions scored 65–86%; those who handed the thinking over scored 24–39%.

System Editor builds the first pattern into the workflow. Claude does the tedious part (reading code to work out how it fits together). The engineer does the part that builds judgment (deciding what should change, and defending it).

| | Typical agent flow | With System Editor |
|-|-|-|
| 1 | You ask for a feature | You ask for a feature |
| 2 | Claude writes a long spec | Claude **maps** the parts of the system it touches, with file and line evidence for every arrow |
| 3 | You skim and approve | **You trace** the path on the map, with the code beside each step |
| 4 | Claude implements | **You draw** the change: add, remove, reroute |
| 5 | You skim the PR | Claude **questions** your change: failure modes, timeouts, data, events. Each question cites code |
| 6 | | **You answer**; Claude never answers for you |
| 7 | | Claude **plans and builds only what's on the map**, and a gate holds every other write |
| 8 | | Claude **verifies** the built code against your map and reports drift |

## What's in the plugin

| Piece | Kind | What it does |
|-|-|-|
| `/sysedit:map` | Skill | Sizes the ceremony to the risk, maps the entry points the request touches (parallel `mapper` subagents, or the `map-entry-points` workflow), saves the model, starts a change set, opens the editor |
| `/sysedit:trace` | Skill | Walks a flow predict-then-reveal: you guess the next step, then see the evidence |
| `/sysedit:grill` | Skill + `griller` subagent | Red-team rubric over your drawn change; every question cites code; blocking questions hold approval |
| `/sysedit:plan` | Skill | One task per operation you drew; refuses work that isn't on the map; then builds it |
| `/sysedit:verify` | Skill | Re-maps the changed code and diffs it against your map |
| `/sysedit:record` | Skill | Writes `docs/adr/NNNN-*.md` from your intent, map and answers, and a PR description that maps each file to a box |
| `/sysedit:skip` | Skill (you only) | Skips the process for a small change, with a logged reason |
| `/sysedit:explain` | Skill | Explain-back check: explain the flow without the tool; Claude scores it and shows what you missed |
| `sysedit` server | MCP server | Tools for the model, change set, questions, plan and drift check; serves the editor on localhost |
| Editor | Web app | **Trace**, **Edit**, **Grill**, **Plan**: the four screens from the mockup |
| Editor in chat | MCP App | The same editor inline in the conversation, served by the `sysedit` server as a `ui://` resource, in hosts that render MCP Apps (Claude desktop chat) |
| Mod | Hooks module | Gate on `Edit`/`Write` until approved; band above the prompt; `/sysedit-status` pane; asks *you* before Claude approves or skips |
| `sysedit` CLI | Node script | `status`, `validate`, `mermaid`, `verify`, `metrics`, `gate` (PreToolUse settings hook), `ci`, `desktop-config` |

Everything sysedit knows lives in your repository under `.sysedit/`: the model, one JSON change set per change (intent, operations, questions, answers, plan, drift report, history), and logs for skips and explain-back checks. It's reviewed and versioned with the code.

### The five rules it holds to

1. **Every box has a source.** The server refuses a model where a box has no file and lines, or an arrow read from code has no evidence.
2. **Say what was guessed.** Event-bus subscriptions, config routing and dynamic dispatch are marked *inferred*, drawn dashed, with a note on what to check.
3. **The diagram is the contract.** The plan must cover every operation and nothing else; the gate holds writes until approval (`strict` mode also holds files that aren't on the map); verify reports drift.
4. **Questions earn their place.** A question with no evidence is dropped. Operations Claude adds without quoting the engineer's words are suggestions the engineer must accept.
5. **Ceremony scales with risk.** A typo fix skips the process; a change to checkout gets all of it. Skips are logged and the skip rate is a tracked metric.

## Use it

```text
/sysedit:map Add a fraud check before we capture payment
```

Claude maps `POST /checkout`, opens the editor, and asks you to trace and draw. Submit your drawing, answer the questions (in the editor or in chat), approve, then `/sysedit:plan`, `/sysedit:verify` and `/sysedit:record`. The band above the prompt always shows the stage and what it's waiting on, with a button for the next step.

Gate modes are a plugin option (`/config`): `approved-only` (default), `strict`, or `off`. Teams that run without mods can use the CLI as a settings hook instead; see [docs/architecture.md](docs/architecture.md#the-gate).

To try it from a clone:

```bash
npm ci && npm run build
claude --plugin-dir plugins/sysedit
```

### In the chat

The editor also runs inside the conversation, as an [MCP App](https://modelcontextprotocol.io/docs/extensions/apps): the `sysedit` server serves it as a `ui://sysedit/editor` resource and Claude opens it with `show_editor`. You trace, draw, answer and approve in the chat; submitting or approving sends the next message for you ("I've drawn my change… please review it"), and what you've drawn and answered is kept in Claude's context as you go. It is not a mod: mods draw in Claude Code's terminal and app, while MCP Apps render in hosts that support them, such as Claude desktop chat. Claude Code doesn't render MCP Apps, so there the plugin keeps using the browser editor.

To add it to Claude desktop, build once, then print the config entry for your repository and merge it into `claude_desktop_config.json` (Settings → Developer → Edit Config):

```bash
npm ci && npm run build
node plugins/sysedit/dist/sysedit.mjs desktop-config --root /path/to/your/repo
```

```json
{
  "mcpServers": {
    "sysedit": {
      "command": "/usr/local/bin/node",
      "args": ["/path/to/ai-cognitive-onload/plugins/sysedit/dist/sysedit.mjs", "mcp"],
      "env": { "SYSEDIT_ROOT": "/path/to/your/repo" }
    }
  }
}
```

Restart Claude desktop and ask it to show the System Editor. The in-chat editor works on the same `.sysedit/` files, so a change drawn in chat can be planned and built from Claude Code, where the gate and the band apply.

## Testing and evals

Three layers, described in [docs/testing.md](docs/testing.md):

| Layer | Command | What it proves | Model calls |
|-|-|-|-|
| Unit + integration | `npm test` | Core logic; the real bundled MCP server over stdio through a full map→draw→grill→approve→plan→build→verify cycle on a git copy of the fixture; editor API security; CLI gate as a PreToolUse hook; eval-suite lint | None |
| Editor end-to-end | `npm run test:e2e` | Trace, Edit, Grill and Plan in Chromium against a real server; the in-chat editor in a sandboxed iframe under a mock MCP Apps host | None |
| Mod | `npm run test:mod` | Gate, approve/skip confirmation, band and pane, with `claude plugin test` | None |
| Skill evals | `npm run evals` | Whether the skills actually change Claude's behaviour, with and without the plugin, graded by transcript, files and a judge model | Yes |

The eval suite ([docs/evals.md](docs/evals.md)) has a case per skill and for the gate, each starting from a scaffolded copy of the fixture repository at the right stage, run against the plugin's real MCP server. The headline case is `refuses-to-answer-for-engineer`: told "just answer the questions yourself and build it", Claude must keep the decisions with the engineer *and* make answering them quick.

## Repository layout

```text
plugins/sysedit/          the plugin (what users install)
  .claude-plugin/         manifest
  core/                   pure TypeScript shared by the mod, server, CLI and editor
  skills/ agents/ workflows/ hooks/   what Claude reads and the mod
  dist/                   bundled MCP server/CLI and editor (committed; npm run build)
  evals/                  claude plugin eval suite
src/                      sources for dist/: node store, MCP server, HTTP server, CLI, editor
fixtures/storefront/      the sample repository every test and eval runs on
tests/ e2e/               vitest and Playwright suites
scripts/                  build, fixture model, eval scaffolds, eval runner and comparison
ci/github-workflows/      CI and eval workflows (move to .github/workflows to enable)
docs/                     architecture, testing, evals, metrics; design/ has the original plan and mockup
```

## Status

This implements phases 0–4 of the [plan](docs/design/system-editor-plan.html) (the map, trace mode, edit mode and change sets, the grill and the gate, plan/build/verify) and the start of phase 5 (risk tiers, skip, explain-back, metrics, eval CI). The editor also runs in the chat as an MCP App. Not yet built: shared repo-wide maps, and language-specific mappers beyond what the mapper agent does with `LSP`, `Grep` and `Read`.
