---
name: interrogate
description: Adversarial review for tier 2 changes (data writes, schema, migrations, side effects, auth, concurrency, importers, weakened checks): the bstack:adversary agent tries to break the diff; findings count only when reproduced. Also when the user asks to stress-test a change.
---

# Interrogate

**When:** tier 2, or the user asks to stress-test, "angrib" or "find huller i" a change.

1. **Spawn `bstack:adversary`** with only: `PR <n> in owner/repo`, the head SHA, the user's request verbatim (the PR's Request section) and the reasons from `risk-tier.mjs`. Not your reasoning or plan.
2. **Blocking findings** (only these block the merge) go through the bug-fix playbook, each reproduction as the failing test. Fix all, push once, then `bstack:reviewer` and interrogate again (the gate needs one per head).
3. **Non-blocking findings** become `needs-triage` issues, ranked by real-use frequency; rare edge cases may share one.
4. **Max 3 blocking rounds**; clean rounds do not count. Then stop and report: fixed, open, recommendation; only the user's OK line for the head reopens the merge. Same component blocked in all 3: propose a redesign.

**Cost:** one Opus run per tier 2 head; `model: fable` for a large architecture change. A second adversary on another model only after a missed bug shows the need, recorded via `bstack:correct`.
