# Spec and tickets

The spec is where multi-PR work is going. The tickets are the steps, each one PR. Both are issues, and both are temporary: once the code is merged, the code, the tests and the glossary are the truth, and the spec is closed.

## Spec

One issue labelled `plan:spec`, written from what was settled (in a grilling session or a map), not from a new interview. Terms from `GLOSSARY.md`; respect the ADRs in the area.

```markdown
## Problem
What the user faces, in their terms.

## Solution
What changes for them.

## Behaviour
Numbered: who does what, and what they get. Cover the edge cases that came up.

## Decisions
Data shape, interfaces and contracts (payloads or files others read), and why. No file paths or line numbers: they go stale.

## How it is proven
The boundary the tests drive (HTTP route, CLI, page), the hostile inputs, prior tests to copy.

## Out of scope
What this work deliberately leaves alone.

## Sources
Links to the request issue, the map and the decision tickets, when there are some.
```

Before writing tickets, check with the user that the proving boundary is the one they expect.

## Tickets

Sub-issues of the spec, each one PR that leaves main working:
- **A vertical slice**: a thin path through every layer it needs (data, logic, route, page, test), demoable on its own. Not "all the models", then "all the routes".
- **About 300 changed lines** outside tests, a guideline: measured PRs up to 300 lines took 1.5 reviewer runs on average, larger ones 3.9. A migration is its own ticket.
- **Prefactor first**: when a change is hard to make, the first ticket makes it easy, without changing behaviour.
- **A wide mechanical change** (a rename across many callers) is expand, migrate in batches, contract: add the new form beside the old, move callers over one ticket per batch, then delete the old form in a ticket blocked by every batch.

```markdown
## What to build
The behaviour this ticket makes work, from the user's side. Current behaviour first for a change.

## Acceptance criteria
- [ ] Each criterion checkable on its own, on the real surface

## Out of scope
- What a builder might be tempted to add
```

Name the types, areas and contracts it touches, not paths. Write the acceptance criteria as the test of done: the reviewer judges against them.

## Publish

1. Show the breakdown as a numbered list (title, blocked by, what it delivers) and ask once whether the granularity and order are right. Recommend your answer.
2. Run `tracker.mjs labels`. Create tickets in dependency order as sub-issues (`--parent <spec>`), then wire `--blocked-by` with the real numbers.
3. Label each `ready-for-agent`, or `ready-for-human` with the reason.
4. Leave the spec open. The ticket playbook closes it when its last ticket is merged; when a person does the last ticket, whoever records that closes the spec. The request issue it came from closes with it, as completed, with a link to the spec.
