---
name: interrogate
description: Adversarial review for tier 2 changes (data writes, schema, migrations, external side effects, auth, concurrency, importers, weakened checks). Spawns the bstack:adversary agent to try to break the diff. Findings count only when reproduced. Also use when the user asks to stress-test a change.
---

# Interrogate

**When:** the risk tier is 2, or the user asks to stress-test, "angrib" or "find huller i" a change.

1. **Spawn `bstack:adversary`** with only: `PR <n> in owner/repo`, the head SHA, the user's request verbatim (the PR's Request section) and the tier reasons from `risk-tier.mjs`. Not your reasoning or plan. It must form its own view.
2. **Each confirmed finding** goes through the bug-fix playbook: its reproduction becomes the failing test. Fix all of them, push once, then run `bstack:reviewer` again. Run interrogate again only if the fix touched tier 2 code.
3. `confirmed=0`, with the list of what was tried, is a valid and useful result.

**Cost:** one Opus run per tier 2 head. For a large architecture change, where getting it right the first time matters most, spawn it with `model: fable`. Add a second adversary on another model only if a missed bug later shows the need, and record that through `bstack:correct`.
