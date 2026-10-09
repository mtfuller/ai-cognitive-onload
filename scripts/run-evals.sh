#!/usr/bin/env bash
# Run the sysedit eval suite with claude plugin eval.
#
#   scripts/run-evals.sh                     every case, 3 runs per arm
#   scripts/run-evals.sh --tag smoke --runs 1
#   scripts/run-evals.sh --case 'grill-*'
#
# Extra flags pass through to claude plugin eval. Environment:
#   SYSEDIT_EVAL_MODEL     model under test (pin it in CI)
#   SYSEDIT_JUDGE_MODEL    judge for llm graders (default: sonnet)
#   SYSEDIT_EVAL_BUDGET    --max-cost-usd ceiling (default 25)
#   SYSEDIT_EVAL_THRESHOLD per-case pass threshold (default 0.8)
#
# Every case runs on a scaffolded copy of fixtures/storefront, against the
# plugin's real MCP server (so its validation, gate and drift logic are under
# test, not a mock). Write and Edit are granted to every case on purpose: the
# cases that check Claude doesn't write code are only meaningful if it can.
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/build.mjs --check
node scripts/gen-eval-scaffolds.mjs --check

stamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
out="plugins/sysedit/evals/results/${stamp}"
mkdir -p "$out"

args=(
  plugins/sysedit
  --allow-tools "mcp__plugin_sysedit_sysedit__*" Write Edit
  --scaffold
  --allow-real-servers
  --trust-plugin
  --no-publish
  --judge-model "${SYSEDIT_JUDGE_MODEL:-sonnet}"
  --threshold "${SYSEDIT_EVAL_THRESHOLD:-0.8}"
  --max-cost-usd "${SYSEDIT_EVAL_BUDGET:-25}"
  --output-dir "$out"
  --report "$out/report.html"
)
if [[ -n "${SYSEDIT_EVAL_MODEL:-}" ]]; then args+=(--model "$SYSEDIT_EVAL_MODEL"); fi

set +e
claude plugin eval "${args[@]}" "$@"
code=$?
set -e

if [[ -f "$out/aggregate-result.json" ]]; then
  node scripts/eval-compare.mjs "$out/aggregate-result.json" || code=$((code == 0 ? 1 : code))
fi
exit "$code"
