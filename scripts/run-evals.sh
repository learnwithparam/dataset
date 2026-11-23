#!/usr/bin/env bash
# Run every eval config in a folder. Keeps going after a red suite, exits 1 if any suite had a failure.
# Usage: scripts/run-evals.sh evals/hcp   (or evals/teammates, or evals)
set -u
dir="${1:-evals}"
status=0
for f in $(find "$dir" -name '*.yaml' | sort); do
  echo "== $f"
  npx -y promptfoo@0.125.1 eval -c "$f" --no-cache || status=1
done
exit $status
