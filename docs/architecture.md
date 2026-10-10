# Architecture

One system model, passed between the engineer and Claude. Everything hangs off files in `.sysedit/`; every surface reads and writes them through the same pure core.

```text
                    ┌──────────────────────── browser ────────────────────────┐
                    │  Editor: Trace · Edit · Grill · Plan   (src/editor, Preact)│
                    └───────────────▲──────────────────────────┬───────────────┘
                                    │ GET state, source         │ PUT ops, POST answer/approve
                                    │ SSE "changed"             │ (token + localhost only)
┌───────── Claude Code ─────────────┴──────────────────────────▼────────────────────────┐
│ skills/ map trace grill plan verify record skip explain                                │
│ agents/ mapper, griller        workflows/ map-entry-points                            │
│        │ tool calls                                                                    │
│        ▼                                                                               │
│ sysedit MCP server  (dist/sysedit.mjs mcp: src/mcp + src/http + src/node)             │
│        │                                                                               │
│ mod (hooks/register.tsx): gate on Edit/Write, approve/skip confirmation,               │
│        band above the prompt, /sysedit-status pane, status line in every prompt        │
└────────┼──────────────────────────────────────────────────────────────────────────────┘
         ▼
 repository/.sysedit/   model.json · cache/<commit>.json · changes/<id>.json · state.json
                        skips.jsonl · explain-back.jsonl
```

## Core (`plugins/sysedit/core/`)

Pure TypeScript with no Node or DOM, imported by the mod (which runs in Claude Code's hooks environment), the MCP server and CLI (bundled for Node), the editor (bundled for the browser) and the tests. Decisions are made in one place:

| File | Owns |
|-|-|
| `model.ts` | The system model: nodes with `source`, edges with `evidence` and `confidence: read \| inferred`, flows of steps. Levels (services, modules, functions) and folding between them; flow slices; merging mapper slices. |
| `validate.ts` | The first two rules: every non-external box has a source, every read edge has evidence, line ranges exist in the files. Inferred edges without a note are warned about. |
| `changeset.ts` | Operations (`addNode`, `removeNode`, `updateNode`, `addEdge`, `removeEdge`, `rerouteEdge`, `addBranch`, `annotate`), applying them to a model with added/removed marks, questions and answers, and every lifecycle transition with the reason it's refused. |
| `gate.ts` | Stages, and the gate's decision for a write. |
| `drift.ts` | Approved model vs re-mapped model, scoped to the nodes the change touched. |
| `layout.ts`, `mermaid.ts` | Drawing: the editor's layered layout; Mermaid for terminals, PRs and ADRs. |
| `metrics.ts`, `risk.ts` | The plan's measures; a first guess at the risk tier. |

## The lifecycle

```text
draft ──submit──▶ in-review ──approve──▶ approved ──mark_implemented──▶ implemented ──verify ok──▶ verified
  │                  │  ▲                                                 │  ▲
  │                  │  └ questions, answers (engineer), accept suggestions│  └ verify found drift
  └──────────────────┴──────────── skip (reason logged) ──▶ skipped
```

Refusals carry their reason, which is what Claude reads:

- `submit`: needs an intent of a sentence and at least one operation.
- `addQuestions`: drops a question with no evidence or one that repeats another.
- `approve`: refused while a blocking question is open, or while an operation Claude added without the engineer's words (`by: "claude"`) is unaccepted.
- `savePlan`: every task must build at least one operation; every operation must be in a task.
- `recordDrift`: a clean report verifies the change; drift keeps it implemented.

### Who drew it

Operations carry `by: "engineer" | "claude"`. The editor writes the engineer's. Claude can only add operations through `propose_ops`, and they count as the engineer's only when Claude includes the engineer's own words as `quote`; otherwise they're suggestions, drawn dashed, and they block approval until the engineer accepts or removes them. Answers picked from a question's options apply that option's map operations as the engineer's, because the engineer chose them.

## The gate

Writes (`Edit`, `Write`, `NotebookEdit`) outside `.sysedit/` and `docs/adr/` are held while a change is a draft or in review. The deny reason tells Claude what the engineer still has to do, and not to do it for them. Once approved, writes go through; in `strict` mode only to files on the map (the new boxes' files, the files of every box an operation touches, files named in the plan, and tests). With no active change, or a skipped or verified one, the gate is out of the way.

The gate runs in two places:

- **The mod** (`hooks/register.tsx`), on `tool.call`, reading `.sysedit/` fresh for every write. It's the default: it works in the terminal, the desktop app, `claude -p` and the Agent SDK.
- **A settings hook**, for teams that turn mods off: add to `.claude/settings.json`

  ```json
  {
    "hooks": {
      "PreToolUse": [
        {
          "matcher": "Edit|Write|NotebookEdit",
          "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/path/to/sysedit.mjs\" gate" }]
        }
      ]
    }
  }
  ```

Both call `decide()` in `core/gate.ts`. The gate fails open: an unreadable `.sysedit/` never blocks work. It's a workflow tool, not a security boundary; a shell command can still write files, which is why the mod also puts a one-line status into every prompt so Claude knows writes are held.

## The mod

Besides the gate, the mod:

- asks the engineer (`$.ui.ask`) before Claude's `approve_change` or `skip_change` goes through, in sessions with a person at the prompt;
- draws a band above the prompt with the stage, open blocking questions, a link to the editor and a button for the next step (`/sysedit:grill`, `/sysedit:plan`, `/sysedit:verify`, `/sysedit:record`);
- adds `/sysedit-status`, a pane in the terminal and desktop app (text where nothing draws);
- adds a line of context to every prompt while a change is open: the stage, the open blocking questions, and that only the engineer answers them.

It polls `.sysedit/` every two seconds so the band follows what the engineer does in the browser.

## The MCP server and editor

`dist/sysedit.mjs mcp` speaks MCP over stdio (newline-delimited JSON-RPC, no dependencies). `open_editor` starts the HTTP server in the same process on a random localhost port. The editor's API:

- binds `127.0.0.1` only and rejects requests whose `Host` isn't local (DNS rebinding);
- requires a per-process token, which the URL Claude gives the engineer carries;
- serves source lines only for paths that resolve, through symlinks, inside the repository;
- pushes `changed` events (server-sent events) when anything under `.sysedit/` changes, so Claude's questions appear while the page is open.

## The editor in chat (MCP App)

In hosts that render [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps) (Claude desktop chat), the same editor runs inside the conversation. This is part of the MCP server, not the mod: mods draw in Claude Code, which doesn't render MCP Apps.

- **Only for hosts that say so.** The server checks the client's `initialize` for the `io.modelcontextprotocol/ui` extension with `text/html;profile=mcp-app`. Other clients, Claude Code included, see none of what follows: no resource, no `show_editor`, no `app_*` tools, and calls to them are unknown tools.
- **One self-contained page.** `resources/read` on `ui://sysedit/editor` returns the editor bundle (`dist/editor/app.js` and `app.css`) inlined into one HTML document, with an empty CSP: the page makes no network requests.
- **`show_editor`** (visible to the model and the app) carries `_meta.ui.resourceUri`, so the host renders the page with the tool's input (`tab`, `focus`) and result (the editor state).
- **`app_*` tools** (visibility `["app"]`, hidden from the model) are the page's API, the same operations as the localhost HTTP API: read state and source lines (confined to the repository), save the engineer's operations and intent, accept or remove a suggestion, submit, answer, rate, dismiss, approve. The host proxies them from the page's `tools/call`. Everything the page saves is the engineer's, as in the browser editor.
- **Back to the conversation.** Submitting sends a `ui/message` asking Claude to review; approving sends one asking it to plan and build. While the engineer works, the page keeps `ui/update-model-context` current with what they've drawn and answered, so Claude knows without a new turn.
- **Fits the chat.** The page follows the host's theme, stacks its three columns at chat width, reports its height (`ui/notifications/size-changed`), and offers fullscreen when the host allows it. It polls state every 2.5 seconds, so questions Claude asks appear without a reload.

`src/editor/apphost.ts` is the page's side of the protocol (postMessage JSON-RPC, `ui/initialize`); `src/editor/api.ts` picks the transport, HTTP or MCP App, and the four screens don't know which they're on.

## Mapping

The `mapper` subagent maps one entry point: it follows calls with `LSP` where a language server is configured, else `Grep` plus reading each call site, and returns a model slice. `map` dispatches one per entry point in parallel and merges them with `save_model(merge: true)`; the server validates the result against the files on disk and refuses it with the errors to fix. Models are cached by commit under `.sysedit/cache/`; a stale model is re-mapped from `git diff --name-only <model commit>`.

For a language server, install the official code intelligence plugin for your language (for TypeScript, `typescript-lsp`), so the mapper gets go-to-definition and find-references rather than text search.
