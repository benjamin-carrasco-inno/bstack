---
name: interrogate
description: Adversarial review for tier 2 changes (data writes, schema, migrations, side effects, auth, concurrency, importers, weakened checks): the bstack:adversary agent tries to break the diff; findings count only when reproduced. Also when the user asks to stress-test a change.
---

# Interrogate

**When:** tier 2, first ready head, before the reviewer; or the user asks to stress-test, "angrib" or "find huller i" a change.

1. **Spawn `bstack:adversary`** with only: `PR <n> in owner/repo`, the head SHA, the user's request verbatim (the PR's Request section) and the reasons from `risk-tier.mjs`. Not your reasoning or plan.
2. **Blocking findings** (only these block the merge) go through the bug-fix playbook, each reproduction as the failing test. Fix all, push once, interrogate again ([internal](#exposure): only `bstack:reviewer`).
3. **Non-blocking findings** become `needs-triage` issues, ranked by real-use frequency; rare edge cases may share one.
4. **Max 3 blocking rounds**; clean ones do not count. Then report fixed, open, recommendation; only the user's OK line for the head reopens the merge. Same component blocked in all 3: propose a redesign.

## Exposure

The base branch's `.github/bstack-exposure.txt` is exactly `internal`, else `external`; `risk-tier.mjs` prints it. External: rounds until the head has no blocking finding. Internal: one run per PR; blocking findings need a newer verdict. A `risk-paths.txt` path, or a PR changing either file, is external; the latter needs the user's OK line.

**Cost:** one Opus run per round; `model: fable` for a large architecture change. A second adversary on another model only after a missed bug, via `bstack:correct`.
