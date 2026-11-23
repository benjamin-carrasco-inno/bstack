---
name: plan
description: Plan work before building it, with GitHub issues as the memory between sessions and machines. Sizes the work, grills the user where intent is unclear, and writes a spec with ticket sub-issues, or a map of decision tickets when the way is foggy. Use for "planlæg", "lav issues", "spec", "roadmap", or any idea bigger than one PR.
---

# Plan

**Goal:** every build session starts from a ticket that says what done looks like, and every decision made on the way is written once, in the issue that made it. The plan is as light as the fog allows.

## Size it first

- **Clear, one PR**: no plan. Go to `bstack:mode`. One ticket only if the user wants it tracked.
- **Clear goal, several PRs**: grill until nothing is assumed, then a spec with tickets ([tickets](tickets.md)).
- **Destination known, way foggy**: questions one session cannot settle (facts to research, something to see before deciding, a choice that waits on someone else). Chart a map ([map](map.md)); it ends in a spec and tickets.

State the size and the reason in one line. When in doubt, the smaller plan; move up when fog shows.

## Grill

The user's intent is the one input no tool can produce. Interview in rounds:
- A round asks every question whose prerequisites are settled, numbered, each with your recommended answer, worded so "yes" accepts it. A question that hangs on an open answer waits for a later round.
- Facts are yours to find (code, tracker, docs, a read-only subagent); never ask the user what you can look up. Decisions are the user's; never answer your own question.
- Test the picture with concrete scenarios and edge cases, and check what the user says against the code. Name contradictions.
- Done when nothing is silently assumed and the user confirms the shared picture. Then write it down. Planning and building are separate sessions.

## Shared language

`GLOSSARY.md` and `docs/adr/` at the repo root, created when the first term or decision settles, never upfront.
- Glossary: terms specific to this project, one or two lines each, what the thing is (not how it is built), with the words to avoid. One word per concept, used the same in issues, code and tests.
- ADR (`docs/adr/NNNN-slug.md`, a paragraph is enough): only for a decision that is hard to reverse, surprising without context, and the result of a real trade-off.
- Read both before planning or building in an area. Say so when a plan contradicts an ADR.

## The tracker

GitHub issues in the repo where the work lands, through `gh` (2.94 or newer for sub-issues and blocking).
- Before the first issue write in a repo: `node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs" labels`. It creates missing labels and changes nothing else.
- What can start now: `node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs" next [<parent>]` lists open tickets with no open blocker and no assignee, in order. Trust it over judging by eye.
- Children are native sub-issues (`gh issue create --parent`), order is native blocking (`--blocked-by`). Create the issues first, wire blocking and cross-links in a second pass with real numbers. A guessed `#n` links an unrelated issue.
- In text the user reads, name issues by title with the link inside, not walls of numbers.
- Claim by assigning yourself (`gh issue edit <n> --add-assignee @me`) before any work. Assigned means a session is on it now; a session that stops leaves a status comment and removes its claim.
- The issue holds the question or the contract. The answer goes in a comment when resolved, then close it. Prototypes and long research are linked, not pasted.
- Issues are readable by everyone with access to the repo: no secrets, personal or customer data.

## Labels

- `plan:map`, `plan:spec`: a map, a spec.
- `plan:research`, `plan:prototype`, `plan:grill`, `plan:task`: decision tickets on a map ([map](map.md)).
- `ready-for-agent`: a build ticket an agent can do alone. `ready-for-human`: needs a person (judgement, access, manual testing), and the ticket says why.
- `bug`, `enhancement`, `needs-triage`, `needs-info`, `wontfix`: intake, see `bstack:triage`.

## After the plan

Building is `bstack:mode` on a ticket: one ticket, one PR, through the ticket playbook and ship. Planning never merges code.
