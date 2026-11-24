---
name: interrogate
description: Adversarial review for tier 2 changes (data writes, schema, migrations, side effects, auth, concurrency, importers, weakened checks): the bstack:adversary agent tries to break the diff; findings count only when reproduced. Also when the user asks to stress-test a change.
---

# Interrogate

**When:** tier 2, or the user asks to stress-test, "angrib" or "find huller i" a change.

1. **Spawn `bstack:adversary`** with only: `PR <n> in owner/repo`, the head SHA, the user's request verbatim (the PR's Request section) and the reasons from `risk-tier.mjs`. Not your reasoning or plan.
2. **Blocking findings** (only these block the merge) go through the bug-fix playbook, each reproduction as the failing test. Fix all, push once, run `bstack:reviewer` again; interrogate again only if the fix touched tier 2 code.
3. **Non-blocking findings** become `needs-triage` issues, ranked by real-use frequency; rare edge cases may share one.
4. **Max 3 rounds per PR.** Then stop and report to the user: fixed, open, recommendation. Same component with confirmed findings 3 rounds in a row: propose a redesign, not another patch.

**Cost:** one Opus run per tier 2 head; `model: fable` for a large architecture change. A second adversary on another model only after a missed bug shows the need, recorded via `bstack:correct`.
