#!/bin/bash
# Bounded Stop-hook probe run in an isolated CODEX_HOME.
set -uo pipefail
export CODEX_HOME=/tmp/codex-probe-home
PROMPT="${1:-Reply with exactly the word DONE and nothing else. Do not use any tools.}"
echo "=== probe start $(date -u +%FT%TZ)"
echo "=== prompt: $PROMPT"
codex exec --skip-git-repo-check --dangerously-bypass-hook-trust "$PROMPT" 2>&1 | tail -60
echo "=== probe exit: $?"
