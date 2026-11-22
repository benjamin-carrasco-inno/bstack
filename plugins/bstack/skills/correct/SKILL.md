---
name: correct
description: Turn repeated mistakes into checks. Run weekly, or after a revert, a follow-up fix, a reviewer FAIL, a confirmed interrogate finding or a review comment seen before. Finds failure classes that happened twice and encodes each at the most durable level.
---

# Correct

**Goal:** the same mistake cannot land twice.

## Sources (last 7 days unless told otherwise)

- `node "${CLAUDE_PLUGIN_ROOT}/scripts/merge-quality.mjs" --days 7 <repo dirs>`: reverts, and fixes that name an earlier PR.
- Verdict and interrogate comments with FAIL, NOTES or confirmed findings, and review threads on merged PRs (`gh pr list --state merged --search "merged:>=<date>"`, then each PR's comments).
- Failed CI runs on main: `gh run list --branch main --status failure`.

## Rule

A class of mistake that happened at least twice gets a check at the highest level that holds: architecture that makes it impossible, then a type, then a lint rule, then a test, and documentation last.

## Proof

The check must be seen failing on the old mistake (check out the old commit or replay its diff) and passing on current main, in every repo it applies to. Quote both outputs in the PR.

## Output

- One PR per check, in the repo where it lives. A rule meant for several repos goes to the shared template or standards layer first, then rolls out by PR.
- The check's error message names the fix. The PR is the documentation. No rule table.
- **Merge:** the agent may merge when the check is green on main in every affected repo and was seen failing on the old mistake. A change to bstack's own rules or playbooks needs the user's OK, because it changes every session.
- "Nothing to correct" is a valid result. Say what was looked at.
