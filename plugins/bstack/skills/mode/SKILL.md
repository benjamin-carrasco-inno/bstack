---
name: mode
description: The engineering method for every code task (bug fix, feature, refactor, migration, investigation, shipping a PR, autonomous runs). Load it before changing code; it routes to a playbook with gates and sets the risk tier and models.
---

# bstack mode

## First reply in a code task

Three lines, then start:
- **Goal**: one sentence, in the user's terms.
- **Smallest change**: what you will touch, and what you deliberately leave alone.
- **Route**: playbook and expected risk tier.

## Route

| The task | Playbook |
|-|-|
| An idea bigger than one PR, or unclear what to build | the `bstack:plan` skill |
| How or why does something work; no change | [investigate](playbooks/investigate.md) |
| Something is broken | [bug-fix](playbooks/bug-fix.md) |
| New behaviour | [feature](playbooks/feature.md) |
| Same behaviour, better shape | [refactor](playbooks/refactor.md) |
| Schema, stored data, or a file or payload format others read | [migration](playbooks/migration.md) |
| An issue to build, or "the next ticket" | [ticket](playbooks/ticket.md) |
| A prototype or POC the user asked for | the `bstack:vibecoding` skill |
| A branch exists and must land | [ship](playbooks/ship.md) |
| "Keep going until X", or a run without the user | [autonomous-run](playbooks/autonomous-run.md) |
| Review or clean up a whole repo | the `bstack:audit` skill |
| Incoming issues to sort | the `bstack:triage` skill |

When several fit, the riskiest wins. Every route that changes code ends in ship, except a vibe branch the user discards (always for a `plan:prototype` ticket). A change to CI workflows also follows [ci](ci.md).

## Risk tier

Computed, not chosen. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/risk-tier.mjs"` after the first diff (or `--pr <n>`); it also prints what the gate requires. The guard recomputes it from the PR diff. Treat a change as riskier than the script says, never as safer.

- **0** docs only: CI.
- **1** code, config, CI, agent instructions: CI, your own full diff read, and a `bstack:reviewer` verdict.
- **2** code that writes, deletes or counts data; schema and migrations; external side effects (POST, mail, publishing, webhooks, n8n); auth; concurrency; importers; weakened tests or checks: tier 1, plus `bstack:interrogate`, plus the user's OK when a revert cannot undo it.

A repo can raise paths to tier 2 with globs in the base branch's `.github/risk-paths.txt`. Add one only for a risk the heuristics miss.

## Models and effort

Weekly quota is real. Spend where risk is.
- Main session: the user's choice (default Opus, medium). High for tier 2 work; never xhigh or max by default.
- Builder: the ticket's `Expected tier` sets the worker's `model`. Sonnet for tier 0-1 in an [internal](../interrogate/SKILL.md#exposure) repo, else the session's model, also for `risk-paths.txt` paths. A higher computed tier mid-build changes nothing; the gate decides.
- Mechanical work (polling CI, bulk renames): a Haiku subagent.
- Fable for implementation only when the user names it, or after Opus failed twice on a task.

## Subagents

- A scoped change goes to a `bstack:worker`, with the goal, the files, and the check that proves it.
- Fix rounds stay with the builder: fix your own change, continue the worker that built one (SendMessage), a fresh one only when it is gone.
- Big read-only searches go to Explore. Parallel work in one repo uses one worktree per agent.

## Gates

Every playbook step names the evidence that opens it. Inconclusive evidence, or evidence from the wrong surface (a unit test where the user hit an HTTP route), keeps the gate closed. A lane that cannot run is a gap to fix, never a pass.

## Principles

Read [principles](principles.md) when a design choice is not obvious.
