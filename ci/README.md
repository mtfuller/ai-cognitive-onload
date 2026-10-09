# CI workflows

`github-workflows/` holds this repository's GitHub Actions workflows. They live here rather than in `.github/workflows/` because the session that created them couldn't push workflow files. To turn them on:

```bash
git mv ci/github-workflows .github/workflows
```

- `ci.yml`: on every push and PR: bundle check, typecheck, vitest (unit, integration, eval lint), Playwright, `claude plugin validate --strict`, `claude plugin test`. No model calls.
- `evals.yml`: `claude plugin eval` smoke cases on PRs that change what Claude reads (skills, agents, hooks, MCP tool descriptions), and the full suite weekly and on demand. Needs an `ANTHROPIC_API_KEY` secret.
