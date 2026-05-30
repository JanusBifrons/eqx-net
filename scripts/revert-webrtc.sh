#!/usr/bin/env bash
# Rollback helper for the swift-otter WebRTC DataChannel plan.
# Hostile review #15 mitigation — we ship a one-line revert path before
# Phase 2 in case the experiment proves to harm net-feel on phones.
#
# Usage:
#   scripts/revert-webrtc.sh
#
# Behaviour:
#   1. Validate we're on a feature branch (NOT main).
#   2. Discover every commit whose subject contains
#      "(plan: swift-otter, Phase N)" for N in {0..5} (Phase -1 is
#      the TCP_NODELAY belt-and-braces and explicitly NOT reverted —
#      that change is independent of the DataChannel path).
#   3. Run `git revert -n <each-commit>` in REVERSE chronological order,
#      then one squashed `git commit -m "revert: roll back swift-otter
#      WebRTC plan"`.
#   4. Print the resulting log line so the user can verify before pushing.
#
# What this does NOT do:
#   - Push. The user always controls the remote.
#   - Drop the node-datachannel dependency from package.json. That's a
#     separate, deliberate step — the library is harmless when unused.
#
# Plan: swift-otter (Phase 1).

set -euo pipefail

branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "${branch}" == "main" || "${branch}" == "master" ]]; then
  echo "refuse: revert-webrtc.sh must run on a feature branch (current: ${branch})." >&2
  exit 2
fi

# Find commit hashes for Phases 0..5 of swift-otter (Phase -1 excluded
# — TCP_NODELAY ships independently). Reverse-chronological so `git
# revert` produces the cleanest sequence of patches to apply.
mapfile -t hashes < <(
  git log --reverse --pretty=format:'%H %s' \
    | awk '/\(plan: swift-otter, Phase [0-5]\)/ { print $1 }' \
    | tac
)

if [[ ${#hashes[@]} -eq 0 ]]; then
  echo "no swift-otter Phase 0..5 commits found — nothing to revert." >&2
  exit 1
fi

echo "Reverting ${#hashes[@]} swift-otter commits (newest → oldest):"
for h in "${hashes[@]}"; do
  echo "  $(git log -1 --pretty=format:'%h %s' "${h}")"
done
echo

for h in "${hashes[@]}"; do
  git revert -n "${h}"
done

git commit -m "$(cat <<'EOF'
revert: roll back swift-otter WebRTC plan

Reverts every Phase 0..5 commit of the swift-otter WebRTC DataChannel plan.
Phase -1 (TCP_NODELAY) is intentionally kept — it's independent of the DC path.

To re-apply later, cherry-pick the original hashes in chronological order.
EOF
)"

echo
echo "Done. Resulting commit:"
git log -1 --oneline
