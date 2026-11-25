---
name: vibecoding
description: Try an idea out fast as a prototype or proof of concept, skipping the process before the PR, then discard it or harden it through ship. Only when the user asks for it (/bstack:vibecoding, "prototype", "POC", "vibe"); never chosen for other work.
---

# Vibecoding

**Goal:** see an idea run as fast as possible, then decide. Speed comes from skipping process, never from skipping safety or the merge gate.

**When:** only on the user's request: this skill, or the words prototype, POC or vibe. A `plan:prototype` ticket is built with it and always ends in discard: the decision survives, and real work goes through a spec. Never pick it yourself to get past a gate.

## Setup

- In a repo: its own worktree on a `vibe/<slug>` branch from the default branch.
- No repo yet: a local folder with `git init` and no remote.
- First reply: the idea in one sentence and the first thing you will show running.

## Skipped

Plan and grill, ticket, the playbook steps (trace, two shapes, tests, browser check), the frontend skill, comment cleanup, PR, CI, reviewer, interrogate and worker subagents. The always-on rules on smallest change, one PR per change and comments do not bind a vibe branch.

## Kept

- The guard, unchanged.
- The stop-and-ask list: deploys, real or existing data, mail and posts, credentials and access. Use test data and mocks.
- One proof per iteration on the running thing (a request, a page, a command's output), shown to the user. That proof is the point.
- Commit locally as you go. Push only when the user wants to share the branch or back it up: a push can start billed CI.

## Exits

The user chooses. Ask once the idea is shown running, or when the user stops.

- **Discard**: remove the worktree and delete the branch. From a `plan:prototype` ticket, write the conclusion as a comment there and close it.
- **Harden**: write a ticket (`bstack:plan`) whose acceptance criteria are what the prototype showed. Then continue the same branch as that ticket through the feature playbook from tests on: tests, proof on the running app, ship. A prototype without a repo gets its GitHub repo first.

Vibe code reaches the default branch only through ship: CI, a reviewer verdict, and interrogate on tier 2. The gate never relaxes.
